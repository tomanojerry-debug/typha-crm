import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localEmbeddingTransport } from '../server/local-embedding-transport.js';
import { sourceEmbeddingModel } from '../shared/source-search.js';
async function runner(body: string, check: (python: string) => Promise<void>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'source-embedding-'));
  try {
    const executable = resolve(directory, 'fake-python');
    await writeFile(executable, '#!' + process.execPath + '\n' + body);
    await chmod(executable, 0o700);
    await check(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const response = {
  protocol: 'local-text-embedding-v1',
  model: sourceEmbeddingModel,
  dimensions: 384,
  vectors: [[1, ...Array(383).fill(0)]],
};
it('uses an offline child with no provider secret and preserves the exact text', async () => {
  await runner(
    `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const r=JSON.parse(s);if(r.texts[0]!=='虚构服装资料'||r.protocol!=='local-text-embedding-v1'||process.env.HF_HUB_OFFLINE!=='1'||process.env.TRANSFORMERS_OFFLINE!=='1'||process.env.MINIMAX_API_KEY)process.exit(4);process.stdout.write(${JSON.stringify(JSON.stringify(response))});});`,
    async (python) => {
      expect(
        (
          await localEmbeddingTransport({ python, dataDir: '/tmp/local-model' }).embed({
            texts: ['虚构服装资料'],
          })
        ).vectors,
      ).toHaveLength(1);
    },
  );
});
it('rejects empty, malformed, zero and mismatched vectors without exposing private diagnostics', async () => {
  for (const value of [
    { ...response, vectors: [] },
    { ...response, vectors: [[1]] },
    { ...response, vectors: [Array(384).fill(0)] },
    { ...response, model: 'other-model' },
  ])
    await runner(
      `process.stderr.write('PRIVATE SOURCE');process.stdout.write(${JSON.stringify(JSON.stringify(value))});`,
      async (python) => {
        await expect(
          localEmbeddingTransport({ python, dataDir: '/tmp/local-model' }).embed({
            texts: ['虚构资料'],
          }),
        ).rejects.toThrow();
      },
    );
});
it('rejects oversized input before spawning and explicitly fails an unavailable runtime', async () => {
  const transport = localEmbeddingTransport({
    python: '/missing/python',
    dataDir: '/tmp/local-model',
  });
  await expect(transport.embed({ texts: ['x'.repeat(12001)] })).rejects.toThrow();
  await expect(transport.embed({ texts: ['虚构资料'] })).rejects.toThrow(
    'Local embedding runner unavailable',
  );
});
