import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { sourceEmbeddingModel, type LocalEmbeddingTransport } from '../shared/source-search.js';

export function validateEmbeddingVectors(vectors: number[][], count: number) {
  if (
    vectors.length !== count ||
    vectors.some(
      (vector) =>
        vector.length !== 384 ||
        vector.some((number) => !Number.isFinite(number)) ||
        !vector.some((number) => number !== 0),
    )
  )
    throw new Error('Invalid local embedding vectors');
}

export function localEmbeddingTransport(options: {
  python: string;
  dataDir: string;
  timeoutMs?: number;
}): LocalEmbeddingTransport {
  return {
    async embed(input) {
      const request = z
        .strictObject({ texts: z.array(z.string().min(1).max(12000)).min(1).max(128) })
        .parse(input);
      const result = await new Promise<unknown>((accept, reject) => {
        const child = spawn(resolve(options.python), [resolve('scripts/graphiti/embed.py')], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            HOME: process.env.HOME,
            GRAPHITI_DATA_DIR: resolve(options.dataDir),
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
            GRAPHITI_TELEMETRY_ENABLED: 'false',
          },
        });
        let text = '',
          failed = false;
        const timer = setTimeout(
          () => {
            failed = true;
            child.kill('SIGKILL');
          },
          Math.max(50, Math.min(options.timeoutMs ?? 120000, 120000)),
        );
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          text += chunk;
          if (Buffer.byteLength(text) > 2500000) {
            failed = true;
            child.kill('SIGKILL');
          }
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => {
          clearTimeout(timer);
          reject(new Error('Local embedding runner unavailable'));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failed || code !== 0) return reject(new Error('Local embedding failed'));
          try {
            accept(JSON.parse(text));
          } catch {
            reject(new Error('Invalid local embedding output'));
          }
        });
        child.stdin.end(JSON.stringify({ protocol: 'local-text-embedding-v1', ...request }));
      });
      const parsed = z
        .strictObject({
          protocol: z.literal('local-text-embedding-v1'),
          model: z.literal(sourceEmbeddingModel),
          dimensions: z.literal(384),
          vectors: z.array(z.array(z.number().finite()).length(384)).max(128),
        })
        .parse(result);
      validateEmbeddingVectors(parsed.vectors, request.texts.length);
      return { model: parsed.model, dimensions: parsed.dimensions, vectors: parsed.vectors };
    },
  };
}
