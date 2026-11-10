import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AgentModelInput } from '../server/agent-model.js';
import type { ChatClassification } from '../shared/chat-intent.js';
import {
  createEvaluationEnvironment,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';

// Actual password-session APIs and RLS over fictional disposable data. The model
// transport is deterministic; these are routing regressions, not quality trials.
let environment: EvaluationEnvironment;
let calls: AgentModelInput[] = [];
let classification: Partial<ChatClassification>;
const normalClassification: ChatClassification = {
  intent: '查询资料',
  action: 'lookup_entity',
  entity_type: 'person',
  target: '林老师',
  match_mode: 'name',
  candidate_index: null,
  missing: [],
  reply: '查询当前授权联系人。',
  mail_action: null,
  data_source: 'records',
  turn_action: 'start',
  slot_updates: [],
};
function suppliedCandidates(input: AgentModelInput): {
  index: number;
  company_name?: string;
  directory_fields?: { label: string; value: string }[];
}[] {
  const prefix = '当前候选目录，序号从1开始：';
  const warning = input.snapshot.warnings.find((item) => item.startsWith(prefix));
  return warning ? JSON.parse(warning.slice(prefix.length)) : [];
}

beforeAll(async () => {
  environment = await createEvaluationEnvironment({
    agent: {
      transport: {
        async generate(input) {
          calls.push(structuredClone(input));
          if (input.phase === 'classify') {
            if (input.question === '选择采购那位') {
              const matched = suppliedCandidates(input).filter((candidate) =>
                candidate.directory_fields?.some(
                  (field) => field.label === '职位' && field.value === '采购',
                ),
              );
              return {
                ...normalClassification,
                action: matched.length === 1 ? 'select_candidate' : 'clarify',
                target: null,
                match_mode: null,
                candidate_index: matched.length === 1 ? matched[0].index : null,
                missing: matched.length === 1 ? [] : ['可区分的候选职位'],
                turn_action: 'continue',
              };
            }
            return classification;
          }
          return {
            answer:
              input.snapshot.retrieval?.status === 'unique'
                ? `授权资料：${input.snapshot.sources[0]?.body}`
                : input.snapshot.retrieval?.status === 'candidates'
                  ? '存在同名联系人，请选择公司和职位相符的一位。'
                  : '当前授权目录未找到匹配联系人。',
            source_ids:
              input.snapshot.retrieval?.status === 'unique'
                ? input.snapshot.sources.slice(0, 1).map((source) => source.id)
                : [],
          };
        },
      },
    },
  });
}, 30000);
afterAll(async () => {
  await environment?.cleanup();
});
beforeEach(() => {
  calls = [];
  classification = { ...normalClassification };
});

async function newChat() {
  const response = await environment.actors.export.request('POST', '/api/chats', {
    id: randomUUID(),
    title: '姓名与邮箱检索路由回归',
    customer_id: null,
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}
async function send(id: string, body: string) {
  const response = await environment.actors.export.request('POST', `/api/chats/${id}/messages`, {
    request_id: randomUUID(),
    body,
  });
  expect(response.status).toBe(200);
  return response.body.messages.at(-1);
}

it('looks up a named person asking for email, then continues the procurement selection under current ACLs', async () => {
  const chat = await newChat();
  const first = await send(chat, '林老师邮箱是什么？');
  expect(first.retrieval).toMatchObject({
    status: 'candidates',
    query: '林老师',
    match_mode: 'name',
    total: 2,
  });
  expect(first.retrieval.candidates.map((candidate: { id: string }) => candidate.id)).toEqual([
    environment.ids.export_person,
    environment.ids.same_name_person,
  ]);
  expect(first.sources).toEqual([]);
  expect(calls.map((input) => input.phase)).toEqual(['classify', 'answer']);
  expect(calls[0].snapshot.sources).toEqual([]);
  for (const source of environment.fixture.records)
    expect(JSON.stringify(calls)).not.toContain(source.body);

  // The fixture classifier must discover the index from the actual supplied
  // directory fields; a hard-coded candidate_index would hide missing context.
  const selected = await send(chat, '选择采购那位');
  expect(selected.retrieval).toMatchObject({
    status: 'unique',
    candidates: [
      { id: environment.ids.export_person, customer_id: environment.ids.export_customer },
    ],
  });
  expect(selected.body).toContain('lin.export@eval.invalid');
  expect(selected.body).not.toContain('lin.second@eval.invalid');
  expect(calls.map((input) => input.phase)).toEqual(['classify', 'answer', 'classify', 'answer']);
  expect(calls[2].history.some((turn) => turn.content.includes('林老师邮箱是什么'))).toBe(true);
  const candidates = suppliedCandidates(calls[2]);
  expect(candidates).toHaveLength(2);
  expect(candidates.map((candidate) => candidate.company_name)).toEqual([
    '虚构海风舞蹈',
    '虚构海风舞蹈',
  ]);
  expect(candidates[0].directory_fields).toContainEqual({ label: '职位', value: '采购' });
  expect(candidates[0].directory_fields).toContainEqual({
    label: '邮箱',
    value: 'lin.export@eval.invalid',
  });
  expect(candidates[1].directory_fields).toContainEqual({ label: '职位', value: '设计' });
  expect(candidates[1].directory_fields).toContainEqual({
    label: '邮箱',
    value: 'lin.second@eval.invalid',
  });
  expect(calls[2].snapshot.sources).toEqual([]);
  for (const source of environment.fixture.records)
    expect(JSON.stringify(calls[2])).not.toContain(source.body);
  expect(JSON.stringify(calls)).not.toContain('lin.domestic@eval.invalid');
  expect(JSON.stringify(calls)).not.toContain(environment.ids.domestic_person);
});

it('honors a declared surname mode even when the requested field is an email address', async () => {
  classification = {
    ...normalClassification,
    action: 'search_candidates',
    target: '林',
    match_mode: 'surname',
  };
  const result = await send(await newChat(), '姓林的老师邮件地址是什么？');
  expect(result.retrieval).toMatchObject({
    status: 'candidates',
    query: '林',
    match_mode: 'surname',
    total: 2,
  });
  expect(JSON.stringify(result)).not.toContain('lin.domestic@eval.invalid');
  expect(calls.map((input) => input.phase)).toEqual(['classify', 'answer']);
});

it.each([
  ['lin.export@eval.invalid', '查找 lin.export@eval.invalid 的联系人'],
  ['lin.export', '查找邮箱前缀 lin.export 对应联系人'],
])('keeps a declared email mode for the authorized target %s', async (target, question) => {
  classification = { ...normalClassification, target, match_mode: 'email' };
  const result = await send(await newChat(), question);
  expect(result.retrieval).toMatchObject({
    status: 'unique',
    query: target,
    match_mode: 'email',
    total: 1,
  });
  expect(result.body).toContain('lin.export@eval.invalid');
  expect(
    result.sources.some((source: { id: string }) => source.id === environment.ids.export_person),
  ).toBe(true);
  expect(JSON.stringify(calls)).not.toContain('lin.domestic@eval.invalid');
  expect(calls.map((input) => input.phase)).toEqual(['classify', 'answer']);
});

it('preserves an anchored partial-email request for a legacy classifier that omits the matching mode', async () => {
  classification = {
    intent: '查询资料',
    target: 'lin.export',
    missing: [],
    reply: '检索授权邮箱目录。',
    mail_action: null,
  };
  const result = await send(await newChat(), '查一下lin.export这个邮箱地址的客户');
  expect(result.retrieval).toMatchObject({
    status: 'unique',
    query: 'lin.export',
    match_mode: 'email',
    total: 1,
    candidates: [{ object: 'customers', id: environment.ids.export_customer }],
  });
  // Legacy entity_type is unknown: the existing email directory intentionally
  // resolves the authorized company, rather than silently changing it to person.
  expect(
    result.sources.every(
      (source: { customer_id: string }) => source.customer_id === environment.ids.export_customer,
    ),
  ).toBe(true);
  expect(JSON.stringify(calls)).not.toContain('lin.domestic@eval.invalid');
  expect(calls.map((input) => input.phase)).toEqual(['classify', 'answer']);
});

it('does not reveal an unauthorized same-name contact through a complete email lookup', async () => {
  classification = {
    ...normalClassification,
    target: 'lin.domestic@eval.invalid',
    match_mode: 'email',
  };
  const result = await send(await newChat(), '查找 lin.domestic@eval.invalid 对应联系人');
  expect(result.retrieval).toMatchObject({ status: 'no_match', total: 0, candidates: [] });
  expect(result.sources).toEqual([]);
  expect(calls[1].snapshot.sources).toEqual([]);
  expect(JSON.stringify(calls[1].snapshot.sources)).not.toContain(environment.ids.domestic_person);
  expect(calls.map((input) => input.phase)).toEqual(['classify', 'answer']);
});
