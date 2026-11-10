import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { KnowledgeTransport } from './knowledge.js';
import {
  extractSnapshot,
  minimaxExtractor,
  extractionRevision,
  type ExtractionTrace,
  type ExtractionGenerate,
} from './communication-pipeline.js';

export function graphitiTransport(options: {
  python: string;
  dataDir: string;
  apiKey: string;
  region: 'cn' | 'global';
  trace?: ExtractionTrace;
  extract?: ExtractionGenerate;
}): KnowledgeTransport {
  const root = resolve(options.dataDir);
  return {
    async sync(snapshot, generation, previous, cached = []) {
      const extraction = await extractSnapshot(
        snapshot,
        cached,
        options.extract || minimaxExtractor(options),
        options.trace,
      );
      const job = {
        snapshot,
        generation,
        previous,
        protocol: extractionRevision,
        records: extraction.records,
      };
      await options.trace?.('graphiti-input', job);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const persisted = await new Promise<unknown>((accept, reject) => {
        const child = spawn(resolve(options.python), [resolve('scripts/graphiti/bridge.py')], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            HOME: process.env.HOME,
            GRAPHITI_DATA_DIR: root,
            GRAPHITI_TELEMETRY_ENABLED: 'false',
            HF_HUB_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
          },
        });
        let output = '',
          oversized = false;
        const timeout = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
        // Decode UTF-8 across buffer boundaries: one Chinese character may be
        // split between stdout writes in a large graph readback.
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          output += chunk;
          if (Buffer.byteLength(output) > 5000000) {
            oversized = true;
            child.kill('SIGKILL');
          }
        });
        child.stderr.resume(); // No raw model/source/credential diagnostics in application logs.
        child.on('error', () => {
          clearTimeout(timeout);
          reject(new Error('Graphiti runner unavailable'));
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0 || oversized) {
            const kind = output.match(/"code":\s*"([A-Za-z]{1,60})"/)?.[1] || 'ProcessError';
            reject(new Error('Graphiti sync failed: ' + kind));
            return;
          }
          try {
            accept(JSON.parse(output));
          } catch {
            reject(new Error('Invalid Graphiti output'));
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(job));
      });
      const result = z.strictObject({ facts: z.unknown(), graph: z.unknown() }).parse(persisted);
      await options.trace?.('graphiti-output', result);
      return { ...result, extractions: extraction.extractions };
    },
    async discard(workspace, customer, generation) {
      [workspace, customer, generation].forEach((value) => z.uuid().parse(value));
      await new Promise<void>((accept, reject) => {
        const child = spawn(
          resolve(options.python),
          [resolve('scripts/graphiti/bridge.py'), '--discard'],
          {
            stdio: ['pipe', 'ignore', 'ignore'],
            env: { PATH: process.env.PATH, GRAPHITI_DATA_DIR: root },
          },
        );
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        child.on('error', () => {
          clearTimeout(timer);
          reject(new Error('Graph cleanup failed'));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) accept();
          else reject(new Error('Graph cleanup failed'));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ workspace, customer, generation }));
      });
    },
  };
}
