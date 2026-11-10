"""Pure request/path/rank checks: no Graphiti model, database, or network needed."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

spec = importlib.util.spec_from_file_location('graphiti_search', Path(__file__).parents[1] / 'scripts/graphiti/search.py')
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


def request():
    return {'workspace_id': str(uuid4()), 'customer_id': str(uuid4()), 'generation': str(uuid4()),
            'query': '怎样支付费用？', 'limit': 5,
            'partitions': [{'group': 'evidence_' + 'a' * 32, 'fact_ids': [str(uuid4())]}]}


class SearchContractTests(unittest.TestCase):
    def test_valid_identity_and_nonempty_allowlists_are_required(self):
        job = request()
        self.assertEqual(search.validate_request(job), job)
        invalid = [
            {**job, 'workspace_id': '../outside'}, {**job, 'query': ' '},
            {**job, 'limit': True}, {**job, 'partitions': []},
            {**job, 'query': 'x' * 12001}, {**job, 'extra': 'untrusted'},
            {**job, 'partitions': [{'group': 'crm', 'fact_ids': [str(uuid4())]}]},
            {**job, 'partitions': [{'group': job['partitions'][0]['group'], 'fact_ids': []}]},
            {**job, 'partitions': job['partitions'] * 2},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(search.SearchInputError):
                search.validate_request(value)

    def test_only_exact_generation_file_is_accepted_and_settings_are_not_needed(self):
        with tempfile.TemporaryDirectory() as root:
            job = request()
            with self.assertRaises(search.MissingGenerationError):
                search.generation_file(root, job)
            directory = Path(root) / job['workspace_id'] / job['customer_id'] / job['generation']
            directory.mkdir(parents=True)
            graph = directory / 'graph.rdb'
            graph.write_bytes(b'private-test-file')
            self.assertEqual(search.generation_file(root, job), graph.resolve())
            graph.unlink()
            graph.symlink_to(directory / 'other-file')
            with self.assertRaises(search.MissingGenerationError):
                search.generation_file(root, job)

    def test_generation_directory_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            job = request()
            parent = Path(root) / job['workspace_id'] / job['customer_id']
            parent.mkdir(parents=True)
            other = Path(root) / 'other'
            other.mkdir()
            (parent / job['generation']).symlink_to(other)
            with self.assertRaises(search.SearchInputError):
                search.generation_file(root, job)

    def test_rrf_uses_partition_scoped_identity_and_rejects_foreign_fact_ids(self):
        first, second = 'evidence_' + 'a' * 32, 'evidence_' + 'b' * 32
        fact = str(uuid4())
        calls = []
        def rrf(lists):
            calls.extend(lists)
            return [first + ':' + fact, second + ':' + fact], [2.0, 1.0]
        result = search.fuse_rankings([(first, [fact]), (second, [fact])], {first: {fact}, second: {fact}}, 5, rrf)
        self.assertEqual(len(calls), 2)
        self.assertEqual([hit['rank'] for hit in result], [1, 2])
        self.assertEqual(result[0]['fact_id'], result[1]['fact_id'])
        self.assertNotEqual(result[0]['group'], result[1]['group'])
        with self.assertRaises(search.SearchInputError):
            search.fuse_rankings([(first, [str(uuid4())])], {first: {fact}}, 5, rrf)


if __name__ == '__main__':
    unittest.main()
