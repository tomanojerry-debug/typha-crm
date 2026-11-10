"""One-job, offline search of an immutable Graphiti generation's private copy.

The CRM supplies authorized evidence partitions and fact UUIDs. Graphiti applies
both filters before its per-method LIMIT; the response contains identities only.
No source text, query, provider credentials, or generated answer is printed.
"""
import asyncio
import contextlib
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sys
import tempfile
from uuid import UUID

os.umask(0o077)
os.environ['GRAPHITI_TELEMETRY_ENABLED'] = 'false'
os.environ['ANONYMIZED_TELEMETRY'] = 'false'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['EMBEDDING_DIM'] = '384'
logging.disable(logging.CRITICAL)

MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
PROTOCOL = 'graphiti-hybrid-search-v1'
STRATEGY = 'graphiti-bm25-cosine-rrf'
SIM_MIN_SCORE = 0.6  # Installed Graphiti's default; business quality is not yet calibrated.
MAX_INPUT_BYTES = 5_000_000


class SearchInputError(ValueError):
    pass


class MissingGenerationError(FileNotFoundError):
    pass


def uuid_string(value):
    if not isinstance(value, str):
        raise SearchInputError('Invalid identity')
    try:
        canonical = str(UUID(value))
    except (ValueError, AttributeError):
        raise SearchInputError('Invalid identity') from None
    if canonical != value:
        raise SearchInputError('Noncanonical identity')
    return canonical


def validate_request(job):
    if not isinstance(job, dict) or set(job) != {
        'workspace_id', 'customer_id', 'generation', 'query', 'partitions', 'limit'
    }:
        raise SearchInputError('Invalid request')
    for field in ('workspace_id', 'customer_id', 'generation'):
        uuid_string(job[field])
    if not isinstance(job['query'], str) or not 1 <= len(job['query'].strip()) <= 12000:
        raise SearchInputError('Invalid query')
    if '\x00' in job['query']:
        raise SearchInputError('Invalid query')
    if type(job['limit']) is not int or not 1 <= job['limit'] <= 30:
        raise SearchInputError('Invalid limit')
    partitions = job['partitions']
    if not isinstance(partitions, list) or not 1 <= len(partitions) <= 64:
        raise SearchInputError('Invalid partitions')
    groups = set()
    total = 0
    for partition in partitions:
        if not isinstance(partition, dict) or set(partition) != {'group', 'fact_ids'}:
            raise SearchInputError('Invalid partition')
        group, ids = partition['group'], partition['fact_ids']
        if not isinstance(group, str) or not re.fullmatch(r'evidence_[a-f0-9]{32}', group) or group in groups:
            raise SearchInputError('Invalid evidence group')
        groups.add(group)
        if not isinstance(ids, list) or not 1 <= len(ids) <= 50000:
            raise SearchInputError('Invalid fact allowlist')
        for fact_id in ids:
            uuid_string(fact_id)
        if len(set(ids)) != len(ids):
            raise SearchInputError('Duplicate fact identity')
        total += len(ids)
    if total > 50000:
        raise SearchInputError('Fact allowlist too large')
    return job


def generation_file(root, job):
    # Root is operator configuration; every remaining path component is a UUID.
    root = Path(root).resolve()
    directory = root / job['workspace_id'] / job['customer_id'] / job['generation']
    if directory.resolve() != directory:
        raise SearchInputError('Generation symlinks are not allowed')
    source = directory / 'graph.rdb'
    if source.is_symlink() or not source.is_file():
        raise MissingGenerationError('Published graph unavailable')
    return source


def deny_network_connections():
    """Defense in depth: only the embedded server's private Unix socket is usable."""
    connect, connect_ex = socket.socket.connect, socket.socket.connect_ex

    def local_connect(self, address):
        if self.family != socket.AF_UNIX:
            raise PermissionError('Search runner is offline')
        return connect(self, address)

    def local_connect_ex(self, address):
        if self.family != socket.AF_UNIX:
            raise PermissionError('Search runner is offline')
        return connect_ex(self, address)

    socket.socket.connect = local_connect
    socket.socket.connect_ex = local_connect_ex


def fuse_rankings(rankings, allowed, limit, rrf):
    """One official RRF over all partition/method ranks, keyed by group + UUID."""
    accepted = []
    for group, ids in rankings:
        permitted = allowed[group]
        if len(ids) != len(set(ids)) or any(fact_id not in permitted for fact_id in ids):
            raise SearchInputError('Graph returned an unauthorized fact')
        accepted.append([group + ':' + fact_id for fact_id in ids])
    keys, scores = rrf(accepted)
    hits = []
    for index, (key, score) in enumerate(zip(keys[:limit], scores[:limit])):
        if not math.isfinite(score) or score < 0:
            raise SearchInputError('Invalid rank score')
        group, fact_id = key.split(':', 1)
        hits.append({'fact_id': fact_id, 'group': group, 'rank': index + 1, 'score': score})
    return hits


async def search_copy(job, source, model_cache):
    from fastembed import TextEmbedding
    from redislite.async_falkordb_client import AsyncFalkorDB
    from graphiti_core.driver.falkordb_driver import FalkorDriver
    from graphiti_core.search.search_filters import SearchFilters
    from graphiti_core.search.search_utils import edge_fulltext_search, edge_similarity_search, rrf

    deny_network_connections()
    model = TextEmbedding(MODEL, cache_dir=str(model_cache), threads=2, local_files_only=True)
    vector = await asyncio.to_thread(lambda: next(iter(model.embed([job['query'].replace('\n', ' ')]))).tolist())
    if len(vector) != 384 or not all(math.isfinite(number) for number in vector):
        raise SearchInputError('Invalid local query embedding')
    # Never copy .settings: it contains the writer's original Unix socket path.
    with tempfile.TemporaryDirectory(prefix='graphiti-search-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        copied = directory / 'graph.rdb'
        shutil.copyfile(source, copied)
        copied.chmod(0o600)
        client = AsyncFalkorDB(dbfilename=str(copied), serverconfig={'port': '0'})
        # Pinned redislite also creates a second private socket/log directory.
        # Its async close can leave that directory after an explicit shutdown.
        redis_directory = Path(client.client._sync_client.redis_dir)
        try:
            existing = set(await client.list_graphs())
            rankings, keyword_count, vector_count = [], 0, 0
            allowed = {partition['group']: set(partition['fact_ids']) for partition in job['partitions']}
            for partition in job['partitions']:
                group = partition['group']
                if group not in existing:
                    raise MissingGenerationError('Authorized evidence partition unavailable')
                driver = FalkorDriver(falkor_db=client, database=group)
                filters = SearchFilters(edge_uuids=partition['fact_ids'])
                # Official utilities include group + UUID predicates before ORDER/LIMIT.
                keyword = await edge_fulltext_search(driver, job['query'], filters, [group], 2 * job['limit'])
                semantic = await edge_similarity_search(
                    driver, vector, None, None, filters, [group], 2 * job['limit'], SIM_MIN_SCORE
                )
                keyword_ids = [edge.uuid for edge in keyword]
                semantic_ids = [edge.uuid for edge in semantic]
                rankings.extend([(group, keyword_ids), (group, semantic_ids)])
                keyword_count += len(keyword_ids)
                vector_count += len(semantic_ids)
            return {
                'protocol': PROTOCOL,
                'strategy': STRATEGY,
                'hits': fuse_rankings(rankings, allowed, job['limit'], rrf),
                'diagnostics': {
                    'embedding_dimensions': 384,
                    'partitions': len(job['partitions']),
                    'keyword_candidates': keyword_count,
                    'vector_candidates': vector_count,
                },
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
    root = Path(os.environ['GRAPHITI_DATA_DIR']).resolve()
    source = generation_file(root, job)
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, task.cancel)
    return await asyncio.wait_for(search_copy(job, source, root / 'models'), timeout=110)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise SearchInputError('Request too large')
        job = json.loads(raw)
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = asyncio.run(run(job))
        print(json.dumps(result, ensure_ascii=False))
    except BaseException as error:
        print(json.dumps({'error': 'Graphiti search failed', 'code': type(error).__name__}))
        sys.exit(1)
