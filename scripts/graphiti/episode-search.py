"""Read-only Graphiti Episode BM25 search, returning authorized identities only.

Graphiti 0.31.2's FalkorDB Episode search ignores SearchFilters. This narrow
adapter reuses its fulltext query builder and queryNodes expression, adding the
CRM's UUID allowlist before ORDER/LIMIT. It neither embeds nor rewrites queries.
"""
import asyncio
import contextlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile

# Reuse the existing offline runner's path/network guards without importing
# Graphiti, FastEmbed, or a model during pure contract validation.
_spec = importlib.util.spec_from_file_location('graphiti_offline_search', Path(__file__).with_name('search.py'))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)
SearchInputError = core.SearchInputError
MissingGenerationError = core.MissingGenerationError

PROTOCOL = 'graphiti-episode-search-v1'
STRATEGY = 'graphiti-episode-bm25'


def validate_request(job):
    if not isinstance(job, dict) or set(job) != {
        'workspace_id', 'customer_id', 'generation', 'query', 'partitions', 'limit'
    }:
        raise SearchInputError('Invalid request')
    for field in ('workspace_id', 'customer_id', 'generation'):
        core.uuid_string(job[field])
    if not isinstance(job['query'], str) or not 1 <= len(job['query'].strip()) <= 12000 or '\x00' in job['query']:
        raise SearchInputError('Invalid query')
    if type(job['limit']) is not int or not 1 <= job['limit'] <= 30:
        raise SearchInputError('Invalid limit')
    if not isinstance(job['partitions'], list) or not 1 <= len(job['partitions']) <= 64:
        raise SearchInputError('Invalid partitions')
    groups, total = set(), 0
    for partition in job['partitions']:
        if not isinstance(partition, dict) or set(partition) != {'group', 'episode_ids'}:
            raise SearchInputError('Invalid partition')
        group, ids = partition['group'], partition['episode_ids']
        if not isinstance(group, str) or not re.fullmatch(r'evidence_[a-f0-9]{32}', group) or group in groups:
            raise SearchInputError('Invalid evidence group')
        groups.add(group)
        if not isinstance(ids, list) or not 1 <= len(ids) <= 50000:
            raise SearchInputError('Invalid Episode allowlist')
        for episode_id in ids:
            core.uuid_string(episode_id)
        if len(set(ids)) != len(ids):
            raise SearchInputError('Duplicate Episode identity')
        total += len(ids)
    if total > 50000:
        raise SearchInputError('Episode allowlist too large')
    return job


async def episode_fulltext_search(driver, query, group, episode_ids, limit):
    """Official FalkorDB BM25 query with both authorization filters before LIMIT."""
    from graphiti_core.driver.driver import GraphProvider
    from graphiti_core.graph_queries import get_nodes_query
    from graphiti_core.search.search_utils import fulltext_query

    if driver.provider != GraphProvider.FALKORDB:
        raise SearchInputError('Unsupported Episode search provider')
    fuzzy_query = fulltext_query(query, [group], driver)
    if fuzzy_query == '':
        return []
    # On FalkorDB, get_nodes_query has no inner LIMIT. Therefore low-ranked
    # authorized Episodes are not displaced by unauthorized matching Episodes.
    cypher = get_nodes_query('episode_content', '$query', limit=limit, provider=driver.provider) + """
        YIELD node AS episode, score
        MATCH (e:Episodic)
        WHERE e.uuid = episode.uuid
          AND e.group_id IN $group_ids
          AND e.uuid IN $episode_ids
        RETURN e.uuid AS uuid, e.group_id AS group_id, score
        ORDER BY score DESC, e.uuid ASC
        LIMIT $limit
    """
    records, _, _ = await driver.execute_query(
        cypher, query=fuzzy_query, group_ids=[group], episode_ids=episode_ids,
        limit=limit, routing_='r'
    )
    accepted, seen = [], set()
    allowed = set(episode_ids)
    for record in records:
        episode_id, hit_group, score = record['uuid'], record['group_id'], record['score']
        if episode_id not in allowed or hit_group != group or episode_id in seen:
            raise SearchInputError('Graph returned an unauthorized Episode')
        if not isinstance(score, (int, float)) or not math.isfinite(score) or score < 0:
            raise SearchInputError('Invalid Episode rank score')
        seen.add(episode_id)
        accepted.append(episode_id)
    if len(accepted) > limit:
        raise SearchInputError('Episode result limit exceeded')
    return accepted


def fuse_rankings(rankings, allowed, limit, rrf):
    accepted = []
    for group, ids in rankings:
        if len(ids) != len(set(ids)) or any(episode_id not in allowed[group] for episode_id in ids):
            raise SearchInputError('Graph returned an unauthorized Episode')
        accepted.append([group + ':' + episode_id for episode_id in ids])
    keys, scores = rrf(accepted)
    hits = []
    for index, (key, score) in enumerate(zip(keys[:limit], scores[:limit])):
        if not math.isfinite(score) or score < 0:
            raise SearchInputError('Invalid Episode rank score')
        group, episode_id = key.split(':', 1)
        hits.append({'episode_id': episode_id, 'group': group, 'rank': index + 1, 'score': score})
    return hits


async def search_copy(job, source):
    core.deny_network_connections()
    from redislite.async_falkordb_client import AsyncFalkorDB
    from graphiti_core.driver.falkordb_driver import FalkorDriver
    from graphiti_core.search.search_utils import rrf

    with tempfile.TemporaryDirectory(prefix='graphiti-episode-search-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        copied = directory / 'graph.rdb'
        shutil.copyfile(source, copied)
        copied.chmod(0o600)
        client = AsyncFalkorDB(dbfilename=str(copied), serverconfig={'port': '0'})
        redis_directory = Path(client.client._sync_client.redis_dir)
        try:
            existing = set(await client.list_graphs())
            rankings, count = [], 0
            allowed = {partition['group']: set(partition['episode_ids']) for partition in job['partitions']}
            for partition in job['partitions']:
                group = partition['group']
                if group not in existing:
                    raise MissingGenerationError('Authorized evidence partition unavailable')
                driver = FalkorDriver(falkor_db=client, database=group)
                ids = await episode_fulltext_search(
                    driver, job['query'], group, partition['episode_ids'], 2 * job['limit']
                )
                rankings.append((group, ids))
                count += len(ids)
            return {
                'protocol': PROTOCOL, 'strategy': STRATEGY,
                'hits': fuse_rankings(rankings, allowed, job['limit'], rrf),
                'diagnostics': {'partitions': len(job['partitions']), 'keyword_candidates': count},
            }
        finally:
            try:
                try:
                    await client.client.shutdown(nosave=True)
                finally:
                    await client.close()
            finally:
                shutil.rmtree(redis_directory, ignore_errors=True)


async def run(job):
    job = validate_request(job)
    source = core.generation_file(os.environ['GRAPHITI_DATA_DIR'], job)
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, task.cancel)
    return await asyncio.wait_for(search_copy(job, source), timeout=110)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(core.MAX_INPUT_BYTES + 1)
        if len(raw) > core.MAX_INPUT_BYTES:
            raise SearchInputError('Request too large')
        job = json.loads(raw)
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = asyncio.run(run(job))
        print(json.dumps(result, ensure_ascii=False))
    except BaseException as error:
        print(json.dumps({'error': 'Graphiti Episode search failed', 'code': type(error).__name__}))
        sys.exit(1)
