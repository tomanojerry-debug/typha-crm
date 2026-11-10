"""Offline embedding window contract tests; no weights or network required."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('source_embedding', Path(__file__).parents[1] / 'scripts/graphiti/embed.py')
embedding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(embedding)

class Tokenizer:
    def __init__(self):
        self.truncation = {'max_length': 128, 'stride': 0, 'strategy': 'longest_first', 'direction': 'right'}
    def no_truncation(self):
        self.truncation = None
    def enable_truncation(self, **value):
        self.truncation = value
    def encode(self, text, add_special_tokens):
        assert self.truncation is None
        return SimpleNamespace(offsets=[(i, i + 1) for i in range(len(text))])

class Vector:
    def __init__(self, tail): self.tail = tail
    def tolist(self): return [1.0, float(self.tail)] + [0.0] * 382

class WindowTests(unittest.TestCase):
    def test_all_offsets_including_long_tail_are_covered_and_truncation_restored(self):
        tokenizer = Tokenizer()
        previous = dict(tokenizer.truncation)
        text = ''.join(chr(0x4e00 + i) for i in range(550))
        windows = embedding.token_windows(tokenizer, text)
        self.assertGreater(len(windows), 1)
        self.assertTrue(all(len(w) <= 126 for w in windows))
        self.assertEqual(set(''.join(windows)), set(text))
        self.assertIn(text[-1], windows[-1])
        self.assertEqual(tokenizer.truncation, previous)

    def test_pool_sends_all_windows_to_the_model_and_normalizes_one_vector_per_input(self):
        seen = []
        def embed(texts):
            seen.extend(texts)
            return [Vector('尾' in text) for text in texts]
        model = SimpleNamespace(model=SimpleNamespace(tokenizer=Tokenizer()), embed=embed)
        result = embedding.pooled_vectors(model, ['甲' * 500 + '尾', '短文'])
        self.assertEqual(len(result), 2)
        self.assertGreater(result[0][1], 0)
        self.assertEqual(result[1][1], 0)
        self.assertTrue(any('尾' in w for w in seen))
        for vector in result:
            self.assertEqual(len(vector), 384)
            self.assertAlmostEqual(sum(n*n for n in vector), 1)

    def test_rejects_requests_before_loading_a_model(self):
        for job in ({}, {'protocol': 'local-text-embedding-v1', 'texts': []}, {'protocol': 'local-text-embedding-v1', 'texts': ['x'] * 129}):
            with self.subTest(job=job), self.assertRaises(ValueError):
                embedding.run(job)

if __name__ == '__main__': unittest.main()
