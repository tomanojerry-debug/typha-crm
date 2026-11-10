"""Bounded offline text embedding using the same local model as Graphiti."""
import json
import logging
import math
import os
from pathlib import Path
import socket
import sys

os.umask(0o077)
for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
    os.environ[key] = '1'
logging.disable(logging.CRITICAL)
MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'

def token_windows(tokenizer, text):
    """The installed model truncates at 128 tokens. Cover every token explicitly."""
    previous = tokenizer.truncation
    tokenizer.no_truncation()
    try:
        encoded = tokenizer.encode(text, add_special_tokens=False)
        offsets = encoded.offsets
        if len(offsets) <= 126:
            return [text]
        windows, start = [], 0
        while start < len(offsets):
            end = min(start + 124, len(offsets))
            # SentencePiece can tokenize the start of a substring differently
            # from its position in the full text. Verify every actual window.
            while end > start:
                candidate = text[offsets[start][0]:offsets[end - 1][1]]
                if len(tokenizer.encode(candidate, add_special_tokens=False).offsets) <= 126:
                    break
                end -= 1
            if end <= start or not candidate:
                raise ValueError('Unable to create a bounded token window')
            windows.append(candidate)
            if end == len(offsets):
                break
            start = max(start + 1, end - 16)
        return windows
    finally:
        if previous:
            tokenizer.enable_truncation(**previous)

def pooled_vectors(model, texts):
    windows, sizes = [], []
    for text in texts:
        parts = token_windows(model.model.tokenizer, text.replace('\n', ' '))
        sizes.append(len(parts))
        windows.extend(parts)
    if len(windows) > 4096:
        raise ValueError('Embedding token window capacity exceeded')
    embedded = [v.tolist() for v in model.embed(windows)]
    output, cursor = [], 0
    for size in sizes:
        vector = [sum(v[d] for v in embedded[cursor:cursor + size]) / size for d in range(384)]
        norm = math.sqrt(sum(n * n for n in vector))
        if not math.isfinite(norm) or norm == 0:
            raise ValueError('Invalid pooled embedding')
        output.append([n / norm for n in vector])
        cursor += size
    return output

def run(job):
    if not isinstance(job, dict) or set(job) != {'protocol', 'texts'} or job['protocol'] != 'local-text-embedding-v1':
        raise ValueError('Invalid embedding request')
    texts = job['texts']
    if not isinstance(texts, list) or not 1 <= len(texts) <= 128 or any(not isinstance(t, str) or not 1 <= len(t) <= 12000 for t in texts):
        raise ValueError('Invalid embedding texts')
    # The cache is provisioned separately. This runner must never download or call a provider.
    def deny_connect(self, address):
        raise PermissionError('Embedding runner is offline')
    socket.socket.connect = deny_connect
    socket.socket.connect_ex = deny_connect
    from fastembed import TextEmbedding
    root = Path(os.environ['GRAPHITI_DATA_DIR']).resolve()
    model = TextEmbedding(MODEL, cache_dir=str(root / 'models'), threads=2, local_files_only=True)
    vectors = pooled_vectors(model, texts)
    if len(vectors) != len(texts) or any(len(v) != 384 or any(not math.isfinite(n) for n in v) or not any(v) for v in vectors):
        raise ValueError('Invalid embeddings')
    return {'protocol': 'local-text-embedding-v1', 'model': MODEL, 'dimensions': 384, 'vectors': vectors}

if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('Input too large')
        print(json.dumps(run(json.loads(raw)), ensure_ascii=False, allow_nan=False))
    except Exception:
        # Never expose a source, query or library diagnostic.
        print('{"error":"LocalEmbeddingError"}')
        sys.exit(1)
