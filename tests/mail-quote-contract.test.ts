import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createEvaluationEnvironment,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';
import type { AgentModelInput } from '../server/agent-model.js';
import type { HomeWorkflow } from '../shared/home-workflows.js';
import { mailVariableText, type MailVariableDocument } from '../shared/mail-variables.js';
import { scoped } from '../server/security.js';

// Deterministic model output against real isolated APIs. These checks are not
// MiniMax trials and never open the daily database or a real mail transport.
let env: EvaluationEnvironment;
const seen: AgentModelInput[] = [];
type Issue = Record<string, unknown>;
const missing = (changes: Issue = {}): Issue => ({
  id: 'missing_details',
  question: '待补充的款式和数量是什么？',
  source_ids: [],
  quote: '',
  status: 'missing',
  response: null,
  ...changes,
});
let issueFactory: (input: AgentModelInput) => Issue[] = () => [missing()];
let beforeAnswer: (() => Promise<void>) | undefined;

beforeAll(async () => {
  env = await createEvaluationEnvironment({
    agent: {
      transport: {
        async generate(input) {
          seen.push(structuredClone(input));
          if (input.phase === 'classify')
            return {
              intent: '起草内容',
              action: 'respond',
              entity_type: 'unknown',
              target: null,
              match_mode: null,
              candidate_index: null,
              data_source: 'records',
              missing: [],
              reply: '继续当前已绑定的虚构邮件任务。',
              mail_action: null,
              turn_action: 'continue',
              slot_updates: [],
            };
          const issues = issueFactory(input);
          if (beforeAnswer) {
            const hook = beforeAnswer;
            beforeAnswer = undefined;
            await hook();
          }
          const validIds = new Set(input.snapshot.sources.map((source) => source.id));
          const template = input.snapshot.sources.find((source) =>
            source.id.startsWith('mail-template:'),
          );
          const masked = template ? JSON.parse(template.body) : null;
          const protectedTemplate = masked?.body?.includes('[[CRM_SLOT:');
          return {
            answer: JSON.stringify({
              body: '已准备待审核草稿；缺少的款式和数量保持待补充。',
              decisions: ['款式和数量待本人补充。'],
              draft_subject: protectedTemplate ? masked.subject : '虚构样衣咨询',
              draft_body: protectedTemplate
                ? masked.body
                : '您好，感谢沟通。\n款式和数量：【待补充】。\n具体报价和交期待确认。',
              changes: [],
              issues,
              mail_decisions: [],
              coverage: issues.map((issue) => ({
                issue_id: issue.id,
                status: 'pending',
                draft_quote: null,
              })),
            }),
            // Keep outer citations legitimate so invalid inner issue citations
            // are rejected by the issue contract rather than an earlier parser.
            source_ids: [
              ...new Set(
                issues.flatMap((issue) =>
                  Array.isArray(issue.source_ids)
                    ? issue.source_ids.filter(
                        (id): id is string => typeof id === 'string' && validIds.has(id),
                      )
                    : [],
                ),
              ),
            ],
          };
        },
      },
    },
  });
}, 30000);
afterAll(() => env?.cleanup());
beforeEach(() => {
  seen.length = 0;
  issueFactory = () => [missing()];
  beforeAnswer = undefined;
});

async function task(kind: 'compose' | 'reply' = 'compose', withTemplate = false) {
  const chat = await env.actors.boss.request('POST', '/api/chats', {
    id: randomUUID(),
    title: '邮件事项引文合同回归（虚构）',
    customer_id: null,
  });
  expect(chat.status).toBe(201);
  const created = await env.actors.boss.request('POST', `/api/chats/${chat.body.id}/workflow`, {
    kind,
  });
  expect(created.status).toBe(201);
  const configured = await env.actors.boss.request('PATCH', `/api/chats/${chat.body.id}/workflow`, {
    version: created.body.version,
    config: {
      ...created.body.config,
      customer_id: env.ids.export_customer,
      person_id: env.ids.export_person,
      project_id: env.ids.export_project,
      instruction: '请核对蓝色面料，报价与交期仍待确认。',
      history_scope: null,
      ...(kind === 'reply' ? { mail_id: env.ids.mail_latest } : {}),
    },
  });
  expect(configured.status).toBe(200);
  const selected = await env.actors.boss.request(
    'POST',
    `/api/chats/${chat.body.id}/workflow/template`,
    {
      version: configured.body.version,
      choice: withTemplate ? { kind: 'saved', id: env.ids.template } : { kind: 'none' },
    },
  );
  expect(selected.status).toBe(200);
  return selected.body as HomeWorkflow;
}
function generate(w: HomeWorkflow) {
  return env.actors.boss.request('POST', `/api/chats/${w.chat_id}/workflow/run`, {
    version: w.version,
    request_id: randomUUID(),
    body: '生成当前邮件草稿',
    phase: 'draft',
    task_action: 'draft_current',
  });
}
async function assertRejected(w: HomeWorkflow, expectedStatus = 502) {
  const response = await generate(w);
  expect(response.status).toBe(expectedStatus);
  const row = (
    await env.db.query<{ result: unknown; result_digest: string | null; draft_id: string | null }>(
      'SELECT result,result_digest,draft_id FROM home_workflows WHERE chat_id=$1',
      [w.chat_id],
    )
  ).rows[0];
  expect(row).toEqual({ result: null, result_digest: null, draft_id: null });
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(1);
  expect(env.counters.fake_transport_submissions).toBe(0);
  return response;
}
const primary = (input: AgentModelInput) =>
  input.snapshot.sources.find(
    (source) => source.ref?.kind === 'record' && source.title.startsWith('本次来信 · '),
  )!;

it('accepts a source-free missing issue with an empty string quote and preserves it without coercion', async () => {
  const w = await task();
  const result = await generate(w);
  expect(result.status).toBe(200);
  expect(result.body.workflow.result.issues).toEqual([missing()]);
  expect(result.body.workflow.result.coverage).toEqual([
    { issue_id: 'missing_details', status: 'pending', draft_quote: null },
  ]);
  const input = seen.find((item) => item.phase === 'answer')!;
  expect(input.snapshot.sources.some((source) => source.ref?.kind === 'record')).toBe(false);
  expect(input.snapshot.mail_directory?.recipient?.email).toBe('lin.export@eval.invalid');
  for (const record of env.fixture.records)
    expect(JSON.stringify(input)).not.toContain(record.body);
  expect(env.counters.fake_transport_submissions).toBe(0);
});

it('passes the actual model a non-nullable quote contract and an explicit empty-evidence example', async () => {
  const w = await task();
  expect((await generate(w)).status).toBe(200);
  const input = seen.find((item) => item.phase === 'answer')!;
  const hints = input.snapshot.warnings.join('\n');
  expect(hints).toMatch(/quote\s*:\s*string/);
  expect(hints).toMatch(/不允许\s*null|不能为\s*null/);
  expect(hints).toMatch(/"source_ids"\s*:\s*\[\s*\]/);
  expect(hints).toMatch(/"quote"\s*:\s*""/);
  expect(hints).toMatch(/"status"\s*:\s*"missing"/);
  expect(hints).toMatch(/"response"\s*:\s*null/);
});

it.each([
  ['null quote', { quote: null }],
  ['whitespace quote', { quote: ' \t ' }],
  ['source-free answerable claim', { status: 'answerable' }],
  ['source-free decision claim', { status: 'needs_decision' }],
  ['source-free conflict claim', { status: 'conflict' }],
  ['an unexplained declared source', { source_ids: ['user:instruction'] }],
  ['a model-written unsupported response', { response: '款式已由公司确认' }],
] as const)(
  'rejects %s before adopting any task result and does not add a repair retry',
  async (_label, change) => {
    issueFactory = () => [missing(change)];
    await assertRejected(await task());
  },
);

it('does not use the template-variable correction retry for an invalid nullable issue quote', async () => {
  const document: MailVariableDocument = {
    version: 1,
    subject: [{ type: 'text', text: '虚构固定主题' }],
    body: [
      {
        type: 'variable',
        id: randomUUID(),
        root: 'recipient',
        field: 'people:name',
        label: '收件人姓名',
      },
      { type: 'text', text: '您好，款式与数量待补充。' },
    ],
  };
  const saved = await env.actors.boss.request(
    'POST',
    `/api/customers/${env.ids.export_customer}/mail-templates`,
    {
      name: '引文错误不扩大变量纠正范围（虚构）',
      subject: mailVariableText(document.subject),
      body: mailVariableText(document.body),
      variable_document: document,
    },
  );
  expect(saved.status).toBe(201);
  const base = await task();
  const selected = await env.actors.boss.request(
    'POST',
    `/api/chats/${base.chat_id}/workflow/template`,
    { version: base.version, choice: { kind: 'saved', id: saved.body.id } },
  );
  expect(selected.status).toBe(200);
  issueFactory = () => [missing({ quote: null })];
  await assertRejected(selected.body);
  expect(
    JSON.stringify(seen.find((input) => input.phase === 'answer')!.snapshot.sources),
  ).toContain('[[CRM_SLOT:');
});

it('accepts a real user instruction quote with its actual current source', async () => {
  issueFactory = () => [
    missing({
      status: 'answerable',
      source_ids: ['user:instruction'],
      quote: '请核对蓝色面料',
      response: '本人的写信要求，尚不代表公司批准。',
    }),
  ];
  const result = await generate(await task());
  expect(result.status).toBe(200);
  expect(result.body.workflow.result.issues[0]).toMatchObject({
    quote: '请核对蓝色面料',
    source_ids: ['user:instruction'],
  });
});

it('requires every reply issue to quote the actual selected primary message, even for missing details', async () => {
  const rejected = await assertRejected(await task('reply'));
  expect(rejected.body.error).toMatch(/所选来信|逐字依据/);
});

it('accepts an exact current primary-message quote and rejects a fabricated quote from that same ID', async () => {
  issueFactory = (input) => [
    missing({ source_ids: [primary(input).id], quote: primary(input).body }),
  ];
  const accepted = await generate(await task('reply'));
  expect(accepted.status).toBe(200);
  seen.length = 0;
  issueFactory = (input) => [
    missing({ source_ids: [primary(input).id], quote: '当前原文根本不存在的虚构引文' }),
  ];
  await assertRejected(await task('reply'));
});

it('does not treat a template or the bound basic directory as business evidence', async () => {
  for (const kind of ['template', 'directory'] as const) {
    seen.length = 0;
    issueFactory = (input) => {
      const source = input.snapshot.sources.find((item) => item.id.startsWith('mail-template:'));
      return [
        missing({
          source_ids: [kind === 'template' ? source!.id : 'mail_directory:recipient'],
          quote: kind === 'template' ? '{recipient.name}' : '林老师',
          status: 'answerable',
          response: '公司已批准具体报价和交期。',
        }),
      ];
    };
    const rejected = await assertRejected(await task('compose', true));
    expect(rejected.body.error).toMatch(/无效业务依据/);
  }
});

it('rejects an invented issue citation even when the outer response cites no invented source', async () => {
  issueFactory = () => [missing({ source_ids: [`record:${randomUUID()}`], quote: '不存在的依据' })];
  await assertRejected(await task());
});

it('does not adopt an exact quote from a source that changes while the model is generating', async () => {
  const w = await task('reply');
  const old = (
    await env.db.query<{ body: string }>('SELECT body FROM mail_messages WHERE id=$1', [
      env.ids.mail_latest,
    ])
  ).rows[0].body;
  issueFactory = (input) => [
    missing({ source_ids: [primary(input).id], quote: primary(input).body }),
  ];
  beforeAnswer = async () => {
    await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
      ctx.tx.query('UPDATE mail_messages SET body=$1 WHERE id=$2', [
        `${old}\n来源已发生明确修订。`,
        env.ids.mail_latest,
      ]),
    );
  };
  try {
    await assertRejected(w, 409);
  } finally {
    await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
      ctx.tx.query('UPDATE mail_messages SET body=$1 WHERE id=$2', [old, env.ids.mail_latest]),
    );
  }
});
