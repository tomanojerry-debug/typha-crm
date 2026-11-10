"""Episode identity, filtering, ranking and offline guards; no business data."""
import asyncio
import importlib.util
from pathlib import Path
import socket
import tempfile
import unittest
from uuid import uuid4

spec = importlib.util.spec_from_file_location('graphiti_episode_search', Path(__file__).parents[1] / 'scripts/graphiti/episode-search.py')
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


def request():
    return {'workspace_id': str(uuid4()), 'customer_id': str(uuid4()), 'generation': str(uuid4()),
            'query': '公司主打服装', 'limit': 5,
            'partitions': [{'group': 'evidence_' + 'a' * 32, 'episode_ids': [str(uuid4())]}]}


class EpisodeSearchContractTests(unittest.TestCase):
    def test_validated_episode_scopes_cannot_be_substituted_with_fact_allowlists(self):
        job = request()
        self.assertEqual(search.validate_request(job), job)
        invalid = [
            {**job, 'workspace_id': '../outside'}, {**job, 'query': ' '},
            {**job, 'query': 'a\x00b'}, {**job, 'limit': True}, {**job, 'partitions': []},
            {**job, 'query': 'x' * 12001}, {**job, 'extra': 'untrusted'},
            {**job, 'partitions': [{'group': 'crm', 'episode_ids': [str(uuid4())]}]},
            {**job, 'partitions': [{'group': job['partitions'][0]['group'], 'fact_ids': [str(uuid4())]}]},
            {**job, 'partitions': job['partitions'] * 2},
            {**job, 'partitions': [{'group': job['partitions'][0]['group'], 'episode_ids': job['partitions'][0]['episode_ids'] * 2}]},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(search.SearchInputError):
                search.validate_request(value)

    def test_generation_lookup_reuses_exact_immutable_path_guard(self):
        with tempfile.TemporaryDirectory() as root:
            job = request()
            directory = Path(root) / job['workspace_id'] / job['customer_id'] / job['generation']
            directory.mkdir(parents=True)
            graph = directory / 'graph.rdb'
            graph.write_bytes(b'synthetic immutable graph')
            self.assertEqual(search.core.generation_file(root, job), graph.resolve())
            graph.unlink()
            graph.symlink_to(directory / 'other')
            with self.assertRaises(search.MissingGenerationError):
                search.core.generation_file(root, job)

    def test_official_rrf_keeps_episode_identity_scoped_to_partition(self):
        first, second = 'evidence_' + 'a' * 32, 'evidence_' + 'b' * 32
        episode = str(uuid4())
        calls = []
        def rrf(lists):
            calls.extend(lists)
            return [first + ':' + episode, second + ':' + episode], [2.0, 1.0]
        hits = search.fuse_rankings([(first, [episode]), (second, [episode])], {first: {episode}, second: {episode}}, 2, rrf)
        self.assertEqual(len(calls), 2)
        self.assertEqual([hit['rank'] for hit in hits], [1, 2])
        self.assertNotEqual(hits[0]['group'], hits[1]['group'])
        with self.assertRaises(search.SearchInputError):
            search.fuse_rankings([(first, [str(uuid4())])], {first: {episode}}, 2, rrf)

    def test_episode_uuid_and_group_filters_are_parameterized_before_the_only_limit(self):
        from graphiti_core.driver.driver import GraphProvider
        from graphiti_core.driver.falkordb.fulltext import build_falkor_fulltext_query
        job, captured = request(), {}
        group, episode = job['partitions'][0]['group'], job['partitions'][0]['episode_ids'][0]
        class Driver:
            provider = GraphProvider.FALKORDB
            def build_fulltext_query(self, query, groups, max_query_length):
                return build_falkor_fulltext_query(query, groups, max_query_length)
            async def execute_query(self, cypher, **params):
                captured.update(cypher=cypher, params=params)
                return [{'uuid': episode, 'group_id': group, 'score': 1.0}], None, None
        result = asyncio.run(search.episode_fulltext_search(Driver(), "company ' OR injection", group, [episode], 1))
        self.assertEqual(result, [episode])
        cypher = captured['cypher']
        self.assertEqual(cypher.count('LIMIT'), 1)
        self.assertLess(cypher.index('e.uuid IN $episode_ids'), cypher.index('LIMIT'))
        self.assertLess(cypher.index('e.group_id IN $group_ids'), cypher.index('LIMIT'))
        self.assertNotIn(episode, cypher)
        self.assertNotIn('injection', cypher)
        self.assertEqual(captured['params']['episode_ids'], [episode])
        self.assertEqual(captured['params']['limit'], 1)

    def test_unexpected_database_identity_is_rejected(self):
        from graphiti_core.driver.driver import GraphProvider
        job = request()
        group, episode = job['partitions'][0]['group'], job['partitions'][0]['episode_ids'][0]
        class Driver:
            provider = GraphProvider.FALKORDB
            def build_fulltext_query(self, *args):
                return 'test'
            async def execute_query(self, *args, **kwargs):
                return [{'uuid': str(uuid4()), 'group_id': group, 'score': 1.0}], None, None
        with self.assertRaises(search.SearchInputError):
            asyncio.run(search.episode_fulltext_search(Driver(), 'test', group, [episode], 1))

    def test_non_unix_connections_are_denied_before_any_network_access(self):
        connect, connect_ex = socket.socket.connect, socket.socket.connect_ex
        try:
            search.core.deny_network_connections()
            with socket.socket(socket.AF_INET) as connection:
                with self.assertRaises(PermissionError):
                    connection.connect(('127.0.0.1', 1))
        finally:
            socket.socket.connect, socket.socket.connect_ex = connect, connect_ex


if __name__ == '__main__':
    unittest.main()
