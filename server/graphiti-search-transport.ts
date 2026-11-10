import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  KnowledgeEpisodeSearchRequest,
  KnowledgeEpisodeSearchResponse,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeSearchTransport,
} from '../shared/knowledge-search.js';

const groupSchema = z.string().regex(/^evidence_[a-f0-9]{32}$/);
const requestSchema = z.strictObject({
  workspace_id: z.uuid(),
  customer_id: z.uuid(),
  generation: z.uuid(),
  query: z
    .string()
    .trim()
    .min(1)
    .max(12000)
    .refine((query) => !query.includes('\0')),
  partitions: z
    .array(z.strictObject({ group: groupSchema, fact_ids: z.array(z.uuid()).min(1).max(50000) }))
    .min(1)
    .max(64),
  limit: z.number().int().min(1).max(30),
});
const responseSchema = z.strictObject({
  protocol: z.literal('graphiti-hybrid-search-v1'),
  strategy: z.literal('graphiti-bm25-cosine-rrf'),
  hits: z
    .array(
      z.strictObject({
        fact_id: z.uuid(),
        group: groupSchema,
        rank: z.number().int().min(1).max(30),
        score: z.number().finite().nonnegative(),
      }),
    )
    .max(30),
  diagnostics: z.strictObject({
    embedding_dimensions: z.literal(384),
    partitions: z.number().int().min(1).max(64),
    keyword_candidates: z.number().int().min(0).max(3840),
    vector_candidates: z.number().int().min(0).max(3840),
  }),
});
const episodeRequestSchema = requestSchema.extend({
  partitions: z
    .array(z.strictObject({ group: groupSchema, episode_ids: z.array(z.uuid()).min(1).max(50000) }))
    .min(1)
    .max(64),
});
const episodeResponseSchema = z.strictObject({
  protocol: z.literal('graphiti-episode-search-v1'),
  strategy: z.literal('graphiti-episode-bm25'),
  hits: z
    .array(
      z.strictObject({
        episode_id: z.uuid(),
        group: groupSchema,
        rank: z.number().int().min(1).max(30),
        score: z.number().finite().nonnegative(),
      }),
    )
    .max(30),
  diagnostics: z.strictObject({
    partitions: z.number().int().min(1).max(64),
    keyword_candidates: z.number().int().min(0).max(3840),
  }),
});

export function graphitiSearchTransport(options: {
  python: string;
  dataDir: string;
  /** Shorter bounds support isolated process-contract tests; never exceeds 2 minutes. */
  timeoutMs?: number;
}): KnowledgeSearchTransport {
  const root = resolve(options.dataDir);
  const timeoutMs = Math.max(50, Math.min(options.timeoutMs ?? 120000, 120000));
  const run = (script: string, request: unknown) =>
    new Promise<unknown>((accept, reject) => {
      const child = spawn(resolve(options.python), [resolve('scripts/graphiti', script)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          HOME: process.env.HOME,
          GRAPHITI_DATA_DIR: root,
          GRAPHITI_TELEMETRY_ENABLED: 'false',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
      });
      let text = '';
      let stopped = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        if (stopped) return;
        stopped = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          try {
            // Last-resort process-group termination if graceful cleanup stalls.
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            // Already exited.
          }
        }, 5000);
      };
      const timer = setTimeout(terminate, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stopped) return;
        text += chunk;
        if (Buffer.byteLength(text) > 256000) terminate();
      });
      child.stderr.resume(); // Third-party diagnostics may contain private source/query text.
      child.stdin.on('error', () => {});
      child.on('error', () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        reject(new Error('Graphiti search runner unavailable'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (stopped || code !== 0) {
          reject(
            new Error(
              stopped
                ? 'Graphiti search timed out or exceeded output limit'
                : 'Graphiti search failed',
            ),
          );
          return;
        }
        try {
          accept(JSON.parse(text));
        } catch {
          reject(new Error('Invalid Graphiti search output'));
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  return {
    async search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
      const request = requestSchema.parse(input);
      const permitted = new Map<string, Set<string>>();
      let total = 0;
      for (const partition of request.partitions) {
        const ids = new Set(partition.fact_ids);
        if (permitted.has(partition.group) || ids.size !== partition.fact_ids.length) {
          throw new Error('Invalid Graphiti search allowlist');
        }
        total += ids.size;
        permitted.set(partition.group, ids);
      }
      if (total > 50000) throw new Error('Graphiti search allowlist too large');
      const output = await run('search.py', request);
      const result = responseSchema.parse(output);
      const seen = new Set<string>();
      if (
        result.hits.length > request.limit ||
        result.diagnostics.partitions !== request.partitions.length
      ) {
        throw new Error('Invalid Graphiti search result bounds');
      }
      for (const [index, hit] of result.hits.entries()) {
        const key = hit.group + ':' + hit.fact_id;
        if (
          !permitted.get(hit.group)?.has(hit.fact_id) ||
          seen.has(key) ||
          hit.rank !== index + 1
        ) {
          throw new Error('Invalid Graphiti search result identity');
        }
        seen.add(key);
      }
      return result;
    },
    async searchEpisodes(
      input: KnowledgeEpisodeSearchRequest,
    ): Promise<KnowledgeEpisodeSearchResponse> {
      const request = episodeRequestSchema.parse(input);
      const permitted = new Map<string, Set<string>>();
      let total = 0;
      for (const partition of request.partitions) {
        const ids = new Set(partition.episode_ids);
        if (permitted.has(partition.group) || ids.size !== partition.episode_ids.length) {
          throw new Error('Invalid Graphiti Episode search allowlist');
        }
        total += ids.size;
        permitted.set(partition.group, ids);
      }
      if (total > 50000) throw new Error('Graphiti Episode search allowlist too large');
      const result = episodeResponseSchema.parse(await run('episode-search.py', request));
      if (
        result.hits.length > request.limit ||
        result.diagnostics.partitions !== request.partitions.length
      ) {
        throw new Error('Invalid Graphiti Episode search result bounds');
      }
      const seen = new Set<string>();
      for (const [index, hit] of result.hits.entries()) {
        const key = hit.group + ':' + hit.episode_id;
        if (
          !permitted.get(hit.group)?.has(hit.episode_id) ||
          seen.has(key) ||
          hit.rank !== index + 1
        ) {
          throw new Error('Invalid Graphiti Episode search result identity');
        }
        seen.add(key);
      }
      return result;
    },
  };
}
