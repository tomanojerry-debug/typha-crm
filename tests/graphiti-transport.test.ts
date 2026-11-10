import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { graphitiTransport } from '../server/graphiti-transport.js';
import type { KnowledgeSnapshot } from '../shared/knowledge.js';

it('preserves Chinese fact text when subprocess stdout splits a UTF-8 character', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'graphiti-utf8-'));
  const executable = resolve(directory, 'fake-graphiti');
  const text = '林悦老师：下单要求：不要代为下单';
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nconst text=${JSON.stringify(text)};const buffer=Buffer.from(JSON.stringify({facts:[{fact:text}],graph:{fact:text}}));const split=buffer.indexOf(Buffer.from('下单要求'))+Buffer.byteLength('下单要')+1;process.stdout.write(buffer.subarray(0,split));setTimeout(()=>process.stdout.write(buffer.subarray(split)),30);`,
      { mode: 0o700 },
    );
    const transport = graphitiTransport({
      python: executable,
      dataDir: directory,
      apiKey: 'unused-synthetic-key',
      region: 'cn',
      extract: async () => {
        throw new Error('No model call expected');
      },
    });
    const snapshot = {
      sources: [],
      schema: { revision: 'synthetic-utf8-test' },
    } as unknown as KnowledgeSnapshot;
    const output = await transport.sync(snapshot, 'unused', null);
    expect(output).toEqual({ facts: [{ fact: text }], graph: { fact: text }, extractions: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
