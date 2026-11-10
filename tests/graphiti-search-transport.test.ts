import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { graphitiSearchTransport } from '../server/graphiti-search-transport.js';
import type {
  KnowledgeEpisodeSearchRequest,
  KnowledgeSearchRequest,
} from '../shared/knowledge-search.js';

const group = 'evidence_' + 'a'.repeat(32);
const fact = '31d2b1b5-687a-47c1-b09a-d0f88312fd90';
const request: KnowledgeSearchRequest = {
  workspace_id: '62305642-f861-4707-ad72-0366422ca70a',
  customer_id: '96611186-3c36-40f2-aa45-04003f756539',
  generation: '68971554-ce9b-486a-aef8-64eb109606d1',
  query: '客户想怎样结算？',
  partitions: [{ group, fact_ids: [fact] }],
  limit: 5,
};
const response = {
  protocol: 'graphiti-hybrid-search-v1',
  strategy: 'graphiti-bm25-cosine-rrf',
  hits: [{ fact_id: fact, group, rank: 1, score: 1 }],
  diagnostics: {
    embedding_dimensions: 384,
    partitions: 1,
    keyword_candidates: 0,
    vector_candidates: 1,
  },
};

async function withRunner(body: string, check: (python: string) => Promise<void>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'graphiti-search-transport-'));
  try {
    const executable = resolve(directory, 'fake-python');
    await writeFile(executable, '#!' + process.execPath + '\n' + body);
    await chmod(executable, 0o700);
    await check(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('passes only the request and offline runtime environment to the private process', async () => {
  await withRunner(
    `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const r=JSON.parse(input);if(r.query!=='客户想怎样结算？'||process.env.HF_HUB_OFFLINE!=='1'||process.env.MINIMAX_API_KEY||process.env.GRAPHITI_DATA_DIR!=='/tmp/search-contract')process.exit(3);process.stdout.write(${JSON.stringify(JSON.stringify(response))});});`,
    async (python) => {
      const transport = graphitiSearchTransport({ python, dataDir: '/tmp/search-contract' });
      expect(await transport.search(request)).toEqual(response);
    },
  );
});

it('does not expose split UTF-8 payloads or third-party private diagnostics', async () => {
  // The only non-ASCII payload is intentionally invalid: errors must remain generic.
  await withRunner(
    `process.stderr.write('客户业务正文与密钥');const b=Buffer.from('客户业务');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),20);`,
    async (python) => {
      await expect(
        graphitiSearchTransport({ python, dataDir: '/tmp' }).search(request),
      ).rejects.toThrow('Invalid Graphiti search output');
    },
  );
});

it('rejects unauthorized hits, duplicate ranks and text fields returned by a runner', async () => {
  for (const result of [
    { ...response, hits: [{ ...response.hits[0], fact_id: request.customer_id }] },
    { ...response, hits: [{ ...response.hits[0], rank: 2 }] },
    { ...response, hits: [{ ...response.hits[0], fact: 'untrusted business text' }] },
  ]) {
    await withRunner(
      `process.stdout.write(${JSON.stringify(JSON.stringify(result))});`,
      async (python) => {
        await expect(
          graphitiSearchTransport({ python, dataDir: '/tmp' }).search(request),
        ).rejects.toThrow();
      },
    );
  }
});

it('rejects malformed scopes before attempting to start a runtime', async () => {
  const transport = graphitiSearchTransport({ python: '/nonexistent/python', dataDir: '/tmp' });
  for (const input of [
    { ...request, workspace_id: '../outside' },
    { ...request, query: ' ' },
    { ...request, partitions: [] },
    { ...request, partitions: [{ group: 'crm', fact_ids: [fact] }] },
    { ...request, partitions: [{ group, fact_ids: [fact, fact] }] },
    { ...request, partitions: [request.partitions[0], request.partitions[0]] },
  ]) {
    await expect(transport.search(input)).rejects.toThrow();
  }
});

it('fails explicitly when the runner fails or exceeds its time bound', async () => {
  await withRunner(`process.stderr.write('private');process.exit(1);`, async (python) => {
    await expect(
      graphitiSearchTransport({ python, dataDir: '/tmp' }).search(request),
    ).rejects.toThrow('Graphiti search failed');
  });
  await withRunner(`setInterval(()=>{},1000);`, async (python) => {
    await expect(
      graphitiSearchTransport({ python, dataDir: '/tmp', timeoutMs: 100 }).search(request),
    ).rejects.toThrow('Graphiti search timed out or exceeded output limit');
  });
});

it('bounds subprocess output and stops an oversized runner', async () => {
  await withRunner(
    `process.stdout.write('x'.repeat(300000));setInterval(()=>{},1000);`,
    async (python) => {
      await expect(
        graphitiSearchTransport({ python, dataDir: '/tmp' }).search(request),
      ).rejects.toThrow('Graphiti search timed out or exceeded output limit');
    },
  );
});

const episodeRequest: KnowledgeEpisodeSearchRequest = {
  ...request,
  partitions: [{ group, episode_ids: [fact] }],
};
const episodeResponse = {
  protocol: 'graphiti-episode-search-v1',
  strategy: 'graphiti-episode-bm25',
  hits: [{ episode_id: fact, group, rank: 1, score: 1 }],
  diagnostics: { partitions: 1, keyword_candidates: 1 },
};

it('runs the Episode BM25 path with a distinct protocol and no embedding request', async () => {
  await withRunner(
    `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const r=JSON.parse(input);if(!process.argv[2].endsWith('/episode-search.py')||r.partitions[0].fact_ids||r.partitions[0].episode_ids[0]!==${JSON.stringify(fact)}||process.env.MINIMAX_API_KEY||process.env.HF_HUB_OFFLINE!=='1')process.exit(3);process.stdout.write(${JSON.stringify(JSON.stringify(episodeResponse))});});`,
    async (python) => {
      const transport = graphitiSearchTransport({ python, dataDir: '/tmp/search-contract' });
      expect(await transport.searchEpisodes!(episodeRequest)).toEqual(episodeResponse);
    },
  );
});

it('rejects unauthorized Episode hits, duplicate ranks, text and protocol substitution', async () => {
  for (const result of [
    { ...episodeResponse, hits: [{ ...episodeResponse.hits[0], episode_id: request.customer_id }] },
    {
      ...episodeResponse,
      hits: [{ ...episodeResponse.hits[0], group: 'evidence_' + 'b'.repeat(32) }],
    },
    { ...episodeResponse, hits: [{ ...episodeResponse.hits[0], rank: 2 }] },
    { ...episodeResponse, hits: [{ ...episodeResponse.hits[0], content: 'untrusted text' }] },
    {
      ...episodeResponse,
      hits: [...episodeResponse.hits, { ...episodeResponse.hits[0], rank: 2 }],
    },
    { ...episodeResponse, diagnostics: { partitions: 2, keyword_candidates: 1 } },
    response,
  ]) {
    await withRunner(
      `process.stdout.write(${JSON.stringify(JSON.stringify(result))});`,
      async (python) => {
        await expect(
          graphitiSearchTransport({ python, dataDir: '/tmp' }).searchEpisodes!(episodeRequest),
        ).rejects.toThrow();
      },
    );
  }
});

it('validates Episode scopes and per-partition allowlists before starting a process', async () => {
  const transport = graphitiSearchTransport({ python: '/nonexistent/python', dataDir: '/tmp' });
  for (const input of [
    { ...episodeRequest, generation: '../outside' },
    { ...episodeRequest, query: ' ' },
    { ...episodeRequest, partitions: [] },
    { ...episodeRequest, partitions: [{ group: 'crm', episode_ids: [fact] }] },
    { ...episodeRequest, partitions: [{ group, episode_ids: [fact, fact] }] },
    { ...episodeRequest, partitions: [episodeRequest.partitions[0], episodeRequest.partitions[0]] },
  ]) {
    await expect(transport.searchEpisodes!(input)).rejects.toThrow();
  }
});
