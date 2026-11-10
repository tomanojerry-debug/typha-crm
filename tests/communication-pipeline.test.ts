import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  communicationInputs,
  extractSnapshot,
  validateExtractions,
  minimaxExtractor,
} from '../server/communication-pipeline.js';
import type { KnowledgeSnapshot } from '../shared/knowledge.js';
import type { CommunicationExtractionInput } from '../server/communication-extraction.js';
const record = randomUUID(),
  company = randomUUID(),
  person = randomUUID();
const snapshot: KnowledgeSnapshot = {
  workspace_id: randomUUID(),
  customer_id: company,
  actor_id: randomUUID(),
  schema: {
    revision: 'first',
    entities: [],
    company_attributes: [],
    relationships: [],
    capabilities: {
      entity_types: 'fixed',
      custom_attributes: ['customers'],
      communication_facts: 'candidates_only',
      image_recognition: false,
    },
  },
  entities: [
    { id: company, object: 'customers', name: '合成公司', attributes: {} },
    { id: person, object: 'people', name: '老师', attributes: {} },
  ],
  relationships: [],
  sources: [
    {
      id: `record:${record}:part:${randomUUID()}`,
      record_id: record,
      channel: 'wechat',
      trust: 'customer_quote',
      project_id: null,
      person_ids: [person],
      occurred_at: '2026-10-22T01:00:00Z',
      title: '聊天',
      speaker: '老师',
      speaker_side: 'external',
      body: '预计80件',
      ref: { kind: 'record', id: record, customer_id: company, title: '记录', description: '合成' },
    },
  ],
};
function output(input: CommunicationExtractionInput) {
  const m = input.messages[0];
  return {
    version: input.version,
    record_id: input.record_id,
    trust: 'unconfirmed',
    entities: [
      {
        ref: 'need',
        kind: 'subject',
        name: '需求',
        canonical_id: null,
        evidence: [{ message_id: m.id, quote: m.text }],
      },
    ],
    attributes: [
      {
        id: 'quantity',
        entity_ref: 'need',
        field_id: null,
        field_label: '数量',
        value: { type: 'number', value: 80, unit: '件' },
        speaker_id: m.speaker_id,
        modality: 'estimated',
        effective_at: null,
        evidence: [{ message_id: m.id, quote: m.text }],
      },
    ],
    relations: [],
    changes: [],
    uncertainties: [],
  };
}
it('groups complete authorized messages into a Record and keeps actual speaker sides', () => {
  const data = structuredClone(snapshot);
  data.sources.push({
    ...data.sources[0],
    id: 'second-source',
    speaker: '我',
    speaker_side: 'internal',
    body: '先核对',
  });
  const inputs = communicationInputs(data);
  expect(inputs).toHaveLength(1);
  expect(inputs[0].messages).toHaveLength(2);
  expect(inputs[0].speakers.map((s) => s.side)).toEqual(['external', 'internal']);
  expect(inputs[0].known_entities.map((e) => e.id)).toEqual([company, person]);
});
it('reuses unchanged validated candidates and re-extracts after source or schema changes', async () => {
  let calls = 0;
  const generate = async (i: CommunicationExtractionInput) => {
    calls++;
    return output(i);
  };
  const a = await extractSnapshot(snapshot, [], generate);
  await extractSnapshot(snapshot, a.extractions, generate);
  expect(calls).toBe(1);
  const b = structuredClone(snapshot);
  b.schema.revision = 'second';
  const second = await extractSnapshot(b, a.extractions, generate);
  expect(calls).toBe(2);
  b.sources[0].body += '，尚未确认';
  await extractSnapshot(b, second.extractions, generate);
  expect(calls).toBe(3);
});
it('retries invalid quotes with specific feedback and fails closed after two invalid outputs', async () => {
  let calls = 0;
  const good = await extractSnapshot(snapshot, [], async (i, issues) => {
    calls++;
    const data = output(i);
    if (calls === 1) data.attributes[0].evidence[0].quote = '造出的原文';
    else expect(issues.join()).toContain('quote not in original');
    return data;
  });
  expect(calls).toBe(2);
  expect(good.extractions).toHaveLength(1);
  await expect(
    extractSnapshot(snapshot, [], async (i) => ({ ...output(i), record_id: randomUUID() })),
  ).rejects.toThrow();
});
it('rejects incomplete, tampered and cross-record stored candidate projections', async () => {
  const result = await extractSnapshot(snapshot, [], async (i) => output(i));
  await expect(validateExtractions(snapshot, [])).rejects.toThrow();
  const altered = structuredClone(result.extractions);
  altered[0].output.attributes[0].evidence[0].quote = '伪造';
  await expect(validateExtractions(snapshot, altered)).rejects.toThrow();
  const moved = structuredClone(snapshot);
  moved.sources[0].record_id = randomUUID();
  await expect(validateExtractions(moved, result.extractions)).rejects.toThrow();
});
it('does not expose prior claims across project or person partitions', async () => {
  const data = structuredClone(snapshot),
    other = randomUUID();
  data.sources.push({
    ...data.sources[0],
    id: 'another',
    record_id: randomUUID(),
    person_ids: [other],
    speaker: '别人',
  });
  await extractSnapshot(data, [], async (input) => {
    expect(input.prior_claims).toEqual([]);
    return output(input);
  });
});
it('requires a complete provider stream and ignores reasoning content', async () => {
  const input = communicationInputs(snapshot)[0];
  let requestBody: any;
  const make = (done: boolean) =>
    minimaxExtractor({
      apiKey: 'fixture',
      region: 'cn',
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        const frame = {
          choices: [
            {
              delta: {
                content: JSON.stringify(output(input)),
                reasoning_content: 'PRIVATE_REASONING',
              },
              finish_reason: 'stop',
            },
          ],
        };
        return new Response(
          'data: ' + JSON.stringify(frame) + '\n\n' + (done ? 'data: [DONE]\n\n' : ''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
  const value = await make(true)(input, []);
  expect(JSON.stringify(value)).not.toContain('PRIVATE_REASONING');
  expect(requestBody.response_format).toEqual({ type: 'json_object' });
  expect(requestBody.messages[0].content).toContain('逐字');
  await expect(make(false)(input, [])).rejects.toThrow('Incomplete');
});
