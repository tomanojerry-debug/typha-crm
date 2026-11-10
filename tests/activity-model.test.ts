import { expect, it } from 'vitest';
import {
  callActivityModel,
  type ActivityModelInput,
  type ActivityModelOutput,
} from '../server/activity-model.js';

const firstId = '90f0dcef-cf3e-4cc4-a404-65af237a9f60';
const secondId = 'f48865d5-096a-44a6-8cc0-0ad8497e2aac';
const schemaId = 'cae9f227-516f-4470-91a9-d24551fd2847';
const input: ActivityModelInput = {
  mode: 'extract',
  type: { name: '用户配置的售前沟通', guidance: '按本次采购目标分别整理。' },
  fields: [
    {
      id: firstId,
      name: '需求数量',
      kind: 'number',
      options: [],
      required: true,
      ai_enabled: true,
      guidance: '只填原文明示的本次套数。',
      inherited: true,
      source_schema_id: schemaId,
      source_schema_name: '父结构',
    },
    {
      id: secondId,
      name: '需要Logo',
      kind: 'checkbox',
      options: [],
      required: false,
      ai_enabled: true,
      guidance: '明确不要为false，未提及为null。',
      source_schema_id: schemaId,
    },
  ],
  sources: [
    {
      id: 'S1',
      body: '需要20套，不要Logo。',
      speaker: '虚构客户',
      speaker_side: 'external',
      occurred_at: '2026-10-26T06:00:00Z',
    },
  ],
};
const candidate: ActivityModelOutput = {
  events: [
    {
      event_id: 'event-1',
      source_ids: ['S1'],
      fields: [
        { field_id: firstId, value: 20, evidence: [{ source_id: 'S1', quote: '需要20套' }] },
        {
          field_id: secondId,
          value: false,
          evidence: [{ source_id: 'S1', quote: '不要Logo' }],
        },
      ],
    },
  ],
};

// Exercise the real fetch/SSE boundary rather than the injected transport path.
function streamed(output: unknown) {
  const content = JSON.stringify(output);
  const split = Math.floor(content.length / 2);
  const frames = [
    { choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING' } }] },
    { choices: [{ delta: { content: content.slice(0, split) } }] },
    { choices: [{ delta: { content: content.slice(split) }, finish_reason: 'stop' }] },
  ];
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
function requestFor(output: unknown) {
  let body: { messages: { role: string; content: string }[] };
  const request: typeof fetch = async (_target, options) => {
    body = JSON.parse(String(options?.body));
    return streamed(output);
  };
  return {
    request,
    wire: () => JSON.parse(body.messages.find((message) => message.role === 'user')!.content),
    body: () => JSON.stringify(body),
  };
}

it('maps extraction fields through short wire references and restores stable IDs without changing values or order', async () => {
  const before = JSON.stringify(input);
  const wireOutput = {
    events: [
      {
        event_id: 'event-1',
        source_ids: ['S1'],
        fields: [
          { ...candidate.events[0].fields[1], field_id: 'F2' },
          { ...candidate.events[0].fields[0], field_id: 'F1' },
        ],
      },
    ],
  };
  const mock = requestFor(wireOutput);
  const output = (await callActivityModel(
    input,
    'fixture-key',
    'cn',
    mock.request,
  )) as ActivityModelOutput;
  expect(mock.wire().input.fields.map((field: { id: string }) => field.id)).toEqual(['F1', 'F2']);
  expect(output.events[0].fields).toEqual([
    candidate.events[0].fields[1],
    candidate.events[0].fields[0],
  ]);
  expect(output.events[0].fields[0].value).toBe(false);
  expect(output.events[0].source_ids).toEqual(['S1']);
  expect(JSON.stringify(input)).toBe(before);
  expect(JSON.stringify(output)).not.toContain('PRIVATE_REASONING');
});

it('uses the same field mapping for review definitions, candidate fields and returned decisions', async () => {
  const reviewInput: ActivityModelInput = { ...input, mode: 'verify', candidate };
  const before = JSON.stringify(reviewInput);
  const mock = requestFor({
    events: [
      {
        event_id: 'event-1',
        supported: false,
        reason: '独立核对示例',
        fields: [
          { field_id: 'F2', supported: true, reason: '否定正确' },
          { field_id: 'F1', supported: false, reason: '数量须核对' },
        ],
      },
    ],
  });
  const output = await callActivityModel(reviewInput, 'fixture-key', 'cn', mock.request);
  expect(mock.wire().input.fields.map((field: { id: string }) => field.id)).toEqual(['F1', 'F2']);
  expect(
    mock
      .wire()
      .input.candidate.events[0].fields.map((field: { field_id: string }) => field.field_id),
  ).toEqual(['F1', 'F2']);
  expect(output).toEqual({
    events: [
      {
        event_id: 'event-1',
        supported: false,
        reason: '独立核对示例',
        fields: [
          { field_id: secondId, supported: true, reason: '否定正确' },
          { field_id: firstId, supported: false, reason: '数量须核对' },
        ],
      },
    ],
  });
  expect(JSON.stringify(reviewInput)).toBe(before);
});

it('leaves unknown or mistyped aliases invalid instead of guessing from their position', async () => {
  for (const mode of ['extract', 'verify'] as const) {
    const fields =
      mode === 'extract'
        ? [
            { field_id: 'F999', value: 20, evidence: [] },
            { field_id: 'F02', value: false, evidence: [] },
          ]
        : [
            { field_id: 'F999', supported: true, reason: 'test' },
            { field_id: 'F02', supported: true, reason: 'test' },
          ];
    const mock = requestFor({ events: [{ event_id: 'event-1', source_ids: ['S1'], fields }] });
    const output = (await callActivityModel(
      { ...input, mode, ...(mode === 'verify' ? { candidate } : {}) },
      'fixture-key',
      'cn',
      mock.request,
    )) as ActivityModelOutput;
    expect(output.events[0].fields.map((field) => field.field_id)).toEqual(['F999', 'F02']);
    expect(
      output.events[0].fields.some((field) => [firstId, secondId].includes(field.field_id)),
    ).toBe(false);
  }
});

it('keeps stable field and Schema IDs out of both extraction and review model payloads', async () => {
  const amountId = '5dcba383-1dd0-48b3-9c28-d406553f42b8';
  const fields: ActivityModelInput['fields'] = [
    ...input.fields,
    { ...input.fields[0], id: amountId, name: '预算金额', kind: 'currency', currency: 'USD' },
  ];
  for (const mode of ['extract', 'verify'] as const) {
    const mock = requestFor({ events: [] });
    await callActivityModel(
      { ...input, fields, mode, ...(mode === 'verify' ? { candidate } : {}) },
      'fixture-key',
      'cn',
      mock.request,
    );
    for (const id of [firstId, secondId, amountId, schemaId]) expect(mock.body()).not.toContain(id);
    expect(mock.body()).not.toContain('source_schema_id');
    expect(mock.wire().input.sources).toEqual(input.sources);
    expect(mock.wire().input.fields[0]).toMatchObject({
      id: 'F1',
      name: '需求数量',
      kind: 'number',
      guidance: '只填原文明示的本次套数。',
    });
    expect(mock.wire().input.fields[2]).toMatchObject({
      id: 'F3',
      kind: 'currency',
      currency: 'USD',
    });
  }
});
