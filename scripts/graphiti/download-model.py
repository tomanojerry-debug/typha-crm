"""One-time public embedding model download; no CRM data or credentials."""
import os
from pathlib import Path
from fastembed import TextEmbedding

os.umask(0o077)
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
root = Path(os.environ.get('GRAPHITI_DATA_DIR', '.local/graphiti'))
root.mkdir(parents=True, exist_ok=True, mode=0o700)
model = TextEmbedding('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
                      cache_dir=str(root / 'models'), threads=2)
vector = next(model.embed(['合成模型就绪检查']))
assert len(vector) == 384
print('384-dimensional multilingual CPU embeddings ready')
