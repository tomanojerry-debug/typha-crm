import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import type { AgentModelInput } from '../server/agent-model.js';
import type { HomeWorkflow, WorkflowConfig } from '../shared/home-workflows.js';
import { runInput, prepareRun } from '../server/home-workflows.js';
import { mailVariableText, type MailVariableDocument } from '../shared/mail-variables.js';
import { mailTemplates } from '../shared/mail-templates.js';
import type { ChatClassification } from '../shared/chat-intent.js';

const origin = 'http://localhost:3100',
  password = 'workflow-synthetic-test-password';
let db: Database,
  workspace: string,
  actor: string,
  member: string,
  a: string,
  b: string,
  project: string,
  otherProject: string,
  person: string,
  mailA: string,
  mailOld: string,
  mailB: string,
  account: string;
let client: Agent, reader: Agent;
let fixtureApp: () => ReturnType<typeof createApp>;
const seen: AgentModelInput[] = [];
let answerFactory: (input: AgentModelInput) => Record<string, unknown>;
let hook: (() => Promise<void>) | undefined;
let classifyIntent = '分析建议',
  target: string | null = null;
let mailAction: 'compose' | 'reply' | null = null;
let classifyDataSource: 'records' | 'wechat_device' = 'records';
let outerSources: string[] = [];
let classificationExtra: Partial<ChatClassification> = {};
let completeMailStructure = true;
let wechatReads = 0;
let wechatTalker = randomUUID();
const h = () => ({ origin, 'x-workspace-id': workspace });
const pack = (extra: Record<string, unknown> = {}) => ({
  body: '已根据所选原文整理。',
  decisions: [],
  draft_body: null,
  changes: [],
  ...extra,
});
const chat = async () =>
  (
    await client
      .post('/api/chats')
      .set(h())
      .send({ id: randomUUID(), title: '工作流程测试', customer_id: null })
      .expect(201)
  ).body.id as string;
const task = async (kind: 'summary' | 'reply' | 'compose' | 'update' = 'summary') => {
  const id = await chat();
  const w = (await client.post(`/api/chats/${id}/workflow`).set(h()).send({ kind }).expect(201))
    .body as HomeWorkflow;
  return configure(w, {
    customer_id: a,
    date_start: '2026-10-26',
    date_end: '2026-10-26',
    source_kinds: ['mail'],
    mail_id: null,
    ...(kind === 'reply' ? { template_choice: { kind: 'none' as const } } : {}),
  });
};
const configure = async (w: HomeWorkflow, changes: Partial<WorkflowConfig>) =>
  (
    await client
      .patch(`/api/chats/${w.chat_id}/workflow`)
      .set(h())
      .send({ version: w.version, config: { ...w.config, ...changes } })
      .expect(200)
  ).body as HomeWorkflow;
const run = (w: HomeWorkflow, body = '总结沟通', extra: Record<string, unknown> = {}) =>
  client
    .post(`/api/chats/${w.chat_id}/workflow/run`)
    .set(h())
    .send({ version: w.version, request_id: randomUUID(), body, ...extra });
const fieldProposal = (value: string, quote: string) =>
  pack({
    body: '发现邮箱需要更新。',
    changes: [
      { key: 'email', value, reason: '本人明确修改', source_ids: ['user:instruction'], quote },
    ],
  });

async function variableTemplate(kind: 'compose' | 'reply' = 'compose') {
  const variable_document: MailVariableDocument = {
    version: 1,
    subject: [
      { type: 'text', text: '关于' },
      {
        type: 'variable',
        id: randomUUID(),
        root: 'customer',
        field: 'customers:name',
        label: '当前公司 › 公司名称',
      },
    ],
    body: [
      {
        type: 'variable',
        id: randomUUID(),
        root: 'recipient',
        field: 'people:name',
        label: '收件人 › 姓名',
        fallback: '',
      },
      { type: 'text', text: '您好，请核对需求。' },
    ],
  };
  const saved = (
    await client
      .post(`/api/customers/${a}/mail-templates`)
      .set(h())
      .send({
        name: '未绑定变量合成模板',
        subject: mailVariableText(variable_document.subject),
        body: mailVariableText(variable_document.body),
        variable_document,
      })
      .expect(201)
  ).body;
  const w = await configure(await task(kind), {
    person_id: person,
    ...(kind === 'reply' ? { mail_id: mailA } : {}),
  });
  return {
    picked: await selectTemplate(w, { kind: 'saved', id: saved.id }),
    saved,
    variable_document,
  };
}
function maskedTemplate(input: AgentModelInput): { subject: string; body: string } {
  return JSON.parse(
    input.snapshot.sources.find((source) => source.id.startsWith('mail-template:'))!.body,
  );
}
function starterDraft(input: AgentModelInput, body: string, subject?: string) {
  const masked = maskedTemplate(input);
  const markers = (text: string) =>
    [...text.matchAll(/\[\[CRM_SLOT:[^\]]+\]\]/g)].map((match) => match[0]);
  return pack({
    draft_subject: subject ? [subject, ...markers(masked.subject)].join(' ') : masked.subject,
    draft_body: [body, ...markers(masked.body)].join('\n'),
  });
}
const productTemplateVariables = () =>
  mailTemplates
    .find((template) => template.id === 'product-size-inquiry')!
    .variable_document!.body.filter((node) => node.type === 'variable');

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Workflow fixture',
    email: 'workflow-admin@fixture.invalid',
    password,
    displayName: 'Tester',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const transport = {
    async generate(input: AgentModelInput) {
      seen.push(input);
      expect(input.entry_context).toMatchObject({ entry: 'home_workflow', scope_kind: 'workflow' });
      if (input.phase === 'classify')
        return {
          intent: classifyIntent,
          action: 'respond',
          target,
          entity_type: 'company',
          match_mode: target ? 'name' : null,
          candidate_index: null,
          data_source: classifyDataSource,
          missing: [],
          reply: '执行当前流程',
          mail_action: mailAction,
          ...classificationExtra,
        };
      if (hook) {
        const current = hook;
        hook = undefined;
        await current();
      }
      const value = answerFactory(input);
      const primary = input.snapshot.sources.find(
        (source) => source.ref?.kind === 'record' && source.title.startsWith('本次来信 · '),
      );
      if (primary && value.issues === undefined) {
        value.issues = [
          {
            id: 'primary',
            question: '确认收到来信',
            source_ids: [primary.id],
            quote: primary.body,
            status: 'answerable',
            response: '确认收到',
          },
        ];
        value.mail_decisions = [];
        value.coverage =
          typeof value.draft_body === 'string'
            ? [{ issue_id: 'primary', status: 'covered', draft_quote: value.draft_body }]
            : [];
      }
      if (completeMailStructure && ['compose', 'reply'].includes(input.entry_context?.task || '')) {
        value.issues ??= [];
        value.mail_decisions ??= [];
        value.coverage ??= [];
      }
      return {
        answer: JSON.stringify(value),
        source_ids: [
          ...input.snapshot.sources
            .filter((s) => s.ref)
            .slice(0, 2)
            .map((s) => s.id),
          ...outerSources,
        ],
      };
    },
    async stream(input: AgentModelInput, stream: { onText: (text: string) => Promise<void> }) {
      const value = await this.generate(input);
      await stream.onText(JSON.stringify(JSON.parse(value.answer as string)));
      return value;
    },
  };
  fixtureApp = () =>
    createApp(db, {
      origin,
      agent: { transport },
      outgoing: { key: Buffer.alloc(32, 7) },
      wechat: {
        actorId: actor,
        transport: {
          async status() {
            return {
              state: 'ready',
              message: 'synthetic',
              account_key: 'workflow-fixture-account',
            };
          },
          async resolve() {
            return [
              {
                id: wechatTalker,
                name: '微信合成联系人',
                remark: '微信合成',
                wechat_id: wechatTalker,
              },
            ];
          },
          async history(_talker, start) {
            wechatReads++;
            return {
              messages: [
                {
                  id: `${wechatTalker}-${start}`,
                  at: `${start}T02:00:00Z`,
                  speaker: '微信合成联系人',
                  from_me: false,
                  text: '合成微信需求：请提供尺码表。',
                },
              ],
              warnings: [],
            };
          },
          async openApp() {},
        },
      },
    });
  const app = fixtureApp();
  client = request.agent(app);
  reader = request.agent(app);
  await client
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'workflow-admin@fixture.invalid', password })
    .expect(200);
  member = (
    await client
      .post('/api/members')
      .set(h())
      .send({ email: 'workflow-reader@fixture.invalid', display_name: 'Reader', password })
      .expect(201)
  ).body.actor_id;
  await reader
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'workflow-reader@fixture.invalid', password })
    .expect(200);
  a = (
    await client
      .post('/api/customers')
      .set(h())
      .send({ name: '甲公司', type: 'group', source: 'email', email: 'a@fixture.invalid' })
      .expect(201)
  ).body.id;
  b = (
    await client
      .post('/api/customers')
      .set(h())
      .send({ name: '乙公司', type: 'group', source: 'email', email: 'b@fixture.invalid' })
      .expect(201)
  ).body.id;
  await client
    .put(`/api/customers/${a}/access/${member}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
  project = (
    await client
      .post(`/api/customers/${a}/projects`)
      .set(h())
      .send({ name: '甲项目', type: 'custom' })
      .expect(201)
  ).body.id;
  otherProject = (
    await client
      .post(`/api/customers/${b}/projects`)
      .set(h())
      .send({ name: '乙项目', type: 'custom' })
      .expect(201)
  ).body.id;
  person = (
    await client
      .post('/api/people')
      .set(h())
      .send({ customer_id: a, name: '沈老师', email: 'person@fixture.invalid' })
      .expect(201)
  ).body.id;
  account = randomUUID();
  await scoped(db, actor, workspace, async (ctx) => {
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [workspace, account, 'sender@163.com', 'synthetic-unused-secret', actor],
    );
    for (const [customerId, date, body, linked] of [
      [a, '2026-10-25T16:00:00Z', '甲当前来信：需要确认尺码。', true],
      [a, '2026-10-25T15:59:59Z', '甲旧来信，不应进入本日。', false],
      [b, '2026-10-26T02:00:00Z', '乙客户专属信息，禁止混入。', false],
    ] as const) {
      const id = randomUUID();
      await ctx.tx.query(
        `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
        VALUES($1,$2,$3,'sender@163.com',$4,$5,$2::uuid::text,$6,$7::jsonb,$8::jsonb,'[]','[]',$9,'inbound',$6,'fixture')`,
        [
          workspace,
          id,
          account,
          customerId,
          customerId === a ? project : otherProject,
          body,
          JSON.stringify([
            { name: '客户', address: customerId === a ? 'a@fixture.invalid' : 'b@fixture.invalid' },
          ]),
          JSON.stringify([{ name: '本公司', address: 'sender@163.com' }]),
          date,
        ],
      );
      if (customerId === b) mailB = id;
      else if (linked) {
        mailA = id;
        await ctx.tx.query(
          'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id)VALUES($1,$2,$3,$4)',
          [workspace, a, id, person],
        );
      } else mailOld = id;
    }
    await ctx.tx.query(
      "INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,occurred_at)VALUES($1,$2,$3,$4,'customer_quote','甲微信原文', $5,'wechat','2026-10-26T02:00:00Z')",
      [workspace, a, project, randomUUID(), actor],
    );
  });
}, 30000);
beforeEach(async () => {
  wechatReads = 0;
  wechatTalker = randomUUID();
  seen.length = 0;
  hook = undefined;
  classifyIntent = '分析建议';
  target = null;
  mailAction = null;
  classifyDataSource = 'records';
  outerSources = [];
  classificationExtra = {};
  completeMailStructure = true;
  answerFactory = () => pack();
  // Each test gets a fresh HTTP limiter, without changing production limits or
  // making unrelated cases depend on the number of prior model requests.
  const app = fixtureApp();
  client = request.agent(app);
  reader = request.agent(app);
  await client
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'workflow-admin@fixture.invalid', password })
    .expect(200);
  await reader
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'workflow-reader@fixture.invalid', password })
    .expect(200);
});
afterAll(() => db.close());

it('persists only evidenced slot changes, restores them across turns and redrafts without resetting the selected recipient', async () => {
  const w = await configure(await task('compose'), {
    person_id: person,
    instruction: '请对方补充尺码',
  });
  classifyIntent = '起草内容';
  mailAction = 'compose'; // The more specific continuation must win over coarse compose.
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [
      { slot: 'template_choice', op: 'set', value: 'none', evidence: '不用模板' },
      { slot: 'language', op: 'set', value: 'en', evidence: '英文' },
      { slot: 'style', op: 'set', value: '简短', evidence: '简短' },
    ],
  };
  answerFactory = () => pack({ draft_body: 'Please confirm the sizes.' });
  const first = (await run(w, '不用模板，英文，简短一点').expect(200)).body as {
    workflow: HomeWorkflow;
  };
  expect(first.workflow).toMatchObject({
    kind: 'compose',
    step: 'ready',
    config: { person_id: person, customer_id: a, template_choice: { kind: 'none' } },
  });
  expect(first.workflow.config.task_slots).toHaveLength(3);
  expect(first.workflow.result?.draft_body).toBe('Please confirm the sizes.');
  const initialInput = seen.find((i) => i.phase === 'classify')!;
  expect(initialInput.snapshot.task_state).toMatchObject({
    kind: 'compose',
    template: 'unprovided',
    bindings: { person: true },
  });
  expect(initialInput.snapshot.sources).toEqual([]);
  const restored = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200))
    .body as HomeWorkflow;
  expect(restored.result?.draft_body).toBe('Please confirm the sizes.');
  seen.length = 0;
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [{ slot: 'language', op: 'set', value: 'zh', evidence: '中文' }],
  };
  answerFactory = () => pack({ draft_body: '您好，请补充尺码。' });
  const second = (await run(restored, '改成中文，其他不变').expect(200)).body
    .workflow as HomeWorkflow;
  expect(second.config.task_slots?.find((s) => s.slot === 'style')).toEqual(
    restored.config.task_slots?.find((s) => s.slot === 'style'),
  );
  expect(second.config.task_slots?.find((s) => s.slot === 'language')?.value).toBe('zh');
  expect(seen.find((i) => i.phase === 'answer')?.question).toContain('文风：简短');
  expect(second.config.template_choice).toEqual({ kind: 'none' });
  const detail = (await client.get(`/api/chats/${w.chat_id}`).set(h()).expect(200)).body;
  expect(detail.messages.at(-1).classification.diagnostics).toMatchObject({
    contract_version: 'task-slots-v1',
  });
  expect(
    (await db.query('SELECT id FROM outgoing_mail WHERE customer_id=$1', [a])).rows,
  ).toHaveLength(0);
});

it('holds template clearing as a missing input and never reads old customer text or generates a draft', async () => {
  const picked = await selectTemplate(await task('compose'), { kind: 'none' });
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [{ slot: 'template_choice', op: 'clear', value: null, evidence: '重新选择模板' }],
  };
  answerFactory = () => pack({ body: '请重新选择模板。' });
  const next = (await run(picked, '重新选择模板', { phase: 'draft' }).expect(200)).body
    .workflow as HomeWorkflow;
  expect(next).toMatchObject({
    step: 'template',
    result: { draft_body: null },
    config: { template_choice: null },
  });
  expect(seen.find((i) => i.phase === 'answer')?.snapshot.sources.filter((s) => s.ref)).toEqual([]);
});

it('rejects fabricated model slot evidence before business reads and leaves the task unchanged', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [{ slot: 'language', op: 'set', value: 'en', evidence: '不存在的原话' }],
  };
  await run(w, '保持中文').expect(502);
  expect(seen.filter((i) => i.phase === 'answer')).toHaveLength(0);
  const next = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(next.version).toBe(w.version);
  expect(next.config.task_slots).toBeUndefined();
});

it('keeps old drafts intact on generation failure and invalidates them only when a valid replacement commits', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  answerFactory = () => pack({ draft_body: '您好，请补充尺码。' });
  const ready = (await run(w, '拟稿', { phase: 'draft' }).expect(200)).body.workflow;
  const opened = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: ready.version })
      .expect(200)
  ).body;
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [{ slot: 'style', op: 'set', value: '简短', evidence: '简短' }],
  };
  answerFactory = () => {
    throw new Error('synthetic model failure');
  };
  await run(opened.workflow, '简短一点', { phase: 'draft' }).expect(502);
  let current = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(current.version).toBe(opened.workflow.version);
  expect(current.config.task_slots).toBeUndefined();
  expect(
    (await client.get(`/api/outgoing/${opened.draft.id}`).set(h()).expect(200)).body.status,
  ).toBe('draft');
  hook = async () => {
    expect(
      (await client.get(`/api/outgoing/${opened.draft.id}`).set(h()).expect(200)).body.status,
    ).toBe('draft');
  };
  answerFactory = () => pack({ draft_body: '请补充尺码。' });
  const replaced = (await run(current, '简短一点', { phase: 'draft' }).expect(200)).body.workflow;
  expect(replaced.config.task_slots[0]).toMatchObject({ slot: 'style', value: '简短' });
  expect(
    (await client.get(`/api/outgoing/${opened.draft.id}`).set(h()).expect(200)).body.status,
  ).toBe('cancelled');
});

it('does not allow config round-trips to invent extraction provenance and drops old customer wording on rebinding', async () => {
  const w = await configure(await task('compose'), { instruction: '甲公司的尺码要求' });
  classifyIntent = '起草内容';
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [
      { slot: 'language', op: 'set', value: 'en', evidence: '英文' },
      {
        slot: 'writing_requirements',
        op: 'set',
        value: '甲公司的尺码要求',
        evidence: '甲公司的尺码要求',
      },
    ],
  };
  const filled = (await run(w, '英文，甲公司的尺码要求').expect(200)).body.workflow as HomeWorkflow;
  const changed = await configure(filled, {
    customer_id: b,
    instruction: filled.config.instruction,
    task_slots: [
      { slot: 'style', op: 'set', value: '伪造', evidence: '伪造', request_id: randomUUID() },
    ],
  });
  expect(changed.config.task_slots?.map((s) => s.slot)).toEqual(['language']);
  expect(changed.config.instruction).toBe('');
  expect(changed.result).toBeNull();
});

it('requires a persisted template choice before composing a draft', async () => {
  const w = await configure(await task('reply'), {
    mail_id: mailA,
    date_start: null,
    date_end: null,
    template_choice: null,
  });
  await run(w, '写一封回复', { phase: 'draft' }).expect(409);
  expect(seen.filter((input) => input.phase !== 'classify')).toHaveLength(0);
  const picked = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/template`)
      .set(h())
      .send({ version: w.version, choice: { kind: 'none' } })
      .expect(200)
  ).body as HomeWorkflow;
  expect(picked.config.template_choice).toEqual({ kind: 'none' });
  answerFactory = () => pack({ draft_body: '您好，收到尺码需求。' });
  const result = (await run(picked, '拟稿', { phase: 'draft' }).expect(200)).body.workflow;
  expect(result.result.draft_body).toContain('尺码');
});

it('replays a completed slot update without another model call and rejects stale edits', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [{ slot: 'language', op: 'set', value: 'en', evidence: '英文' }],
  };
  answerFactory = () => pack({ draft_body: 'This is a test.' });
  const requestId = randomUUID();
  const send = () => run(w, '改成英文', { request_id: requestId });
  const first = (await send().expect(200)).body.workflow;
  const calls = seen.length;
  const replay = (await send().expect(200)).body.workflow;
  expect(replay.config.task_slots).toEqual(first.config.task_slots);
  expect(seen).toHaveLength(calls);
  await run(w, '改成英文').expect(409);
});

it('does not apply extracted slot changes after concurrent cancellation', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  classificationExtra = {
    turn_action: 'modify',
    slot_updates: [{ slot: 'style', op: 'set', value: '简短', evidence: '简短' }],
  };
  hook = async () => {
    await client
      .post(`/api/chats/${w.chat_id}/workflow/cancel`)
      .set(h())
      .send({ version: w.version })
      .expect(200);
  };
  await run(w, '简短一点').expect(409);
  const current = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(current.step).toBe('cancelled');
  expect(current.config.task_slots).toBeUndefined();
});

it('commits an explicit stop before generating its explanation, even when the model answer fails', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  answerFactory = () => pack({ draft_body: '系统测试，请核对尺码。' });
  const ready = (await run(w, '拟稿', { phase: 'draft' }).expect(200)).body.workflow;
  const opened = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: ready.version })
      .expect(200)
  ).body;
  classificationExtra = {
    turn_action: 'cancel',
    turn_evidence: '取消这个邮件任务',
    slot_updates: [],
  };
  answerFactory = () => {
    throw new Error('synthetic explanation failure');
  };
  await run(opened.workflow, '取消这个邮件任务').expect(500);
  const stopped = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(stopped.step).toBe('cancelled');
  expect(
    (await client.get(`/api/outgoing/${opened.draft.id}`).set(h()).expect(200)).body.status,
  ).toBe('cancelled');
});

it('never includes old task wording in answer context after a target switch', async () => {
  const w = await configure(await task('compose'), { instruction: '甲客户专用旧口径：样衣说明' });
  target = '乙公司';
  classificationExtra = { turn_action: 'modify' };
  await run(w, '先看乙公司的资料').expect(200);
  const input = seen.find((i) => i.phase === 'answer')!;
  expect(JSON.stringify(input.snapshot)).not.toContain('甲客户专用旧口径');
  expect(input.snapshot.task_state).toBeUndefined();
  expect(input.history).toEqual([]);
});

it('preserves selected template references through model copy, workflow restore and one outgoing draft', async () => {
  const { picked, variable_document } = await variableTemplate();
  answerFactory = (input) => {
    const masked = maskedTemplate(input);
    expect(masked.body).not.toContain('沈老师');
    expect(masked.body).not.toContain('people:name');
    return pack({ draft_subject: `请核对：${masked.subject}`, draft_body: `${masked.body}谢谢。` });
  };
  const next = (
    await run(picked, '生成当前邮件草稿', { phase: 'draft', task_action: 'draft_current' }).expect(
      200,
    )
  ).body.workflow as HomeWorkflow;
  expect(next.result?.variable_document?.body[0]).toEqual(variable_document.body[0]);
  expect(next.result?.draft_body).toBe('{收件人 › 姓名}您好，请核对需求。谢谢。');
  expect(JSON.stringify(next.result)).not.toContain('[[CRM_SLOT:');
  const restored = (await client.get(`/api/chats/${picked.chat_id}/workflow`).set(h()).expect(200))
    .body as HomeWorkflow;
  expect(restored.result?.variable_document).toEqual(next.result?.variable_document);
  const opened = (
    await client
      .post(`/api/chats/${picked.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  expect(opened.draft.variable_document).toEqual(next.result?.variable_document);
  expect(opened.draft.subject).toBe('请核对：关于{当前公司 › 公司名称}');
  expect(opened.draft.status).toBe('draft');
  expect(opened.draft.approved_version).toBeNull();
  const duplicate = (
    await client
      .post(`/api/chats/${picked.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  expect(duplicate.draft.id).toBe(opened.draft.id);
});

it('makes all three starter slots mandatory on the first system-test draft request', async () => {
  const base = await configure(await task('compose'), {
    person_id: person,
    instruction: '只写系统测试、无需业务操作，不提出报价或交期承诺；保留姓名与公司变量。',
  });
  const picked = await selectTemplate(base, { kind: 'starter', id: 'group-custom-requirements' });
  answerFactory = (input) => {
    const masked = maskedTemplate(input),
      warnings = input.snapshot.warnings.join('\n');
    expect(warnings).not.toContain('"draft_subject":"邮件主题，可省略"');
    expect(warnings).toContain('本轮 draft_subject 必填，不可省略');
    for (const marker of `${masked.subject}${masked.body}`.match(/\[\[CRM_SLOT:[^\]]+\]\]/g)!)
      expect(warnings).toContain(marker);
    const bodyMarkers = masked.body.match(/\[\[CRM_SLOT:[^\]]+\]\]/g)!;
    return pack({
      body: '测试草稿已拟好，请核对。',
      draft_subject: `${masked.subject.match(/\[\[CRM_SLOT:[^\]]+\]\]/)![0]} 系统测试邮件`,
      draft_body: `${bodyMarkers[0]}您好，本邮件仅用于系统测试，无需业务操作。\n${bodyMarkers[1]}`,
    });
  };
  const result = (
    await run(picked, '生成当前邮件草稿', { phase: 'draft', task_action: 'draft_current' }).expect(
      200,
    )
  ).body.workflow as HomeWorkflow;
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(1);
  expect(result.config.template_choice).toEqual(picked.config.template_choice);
  expect(result.result?.draft_subject).toBe('{收件人 › 所属公司 › 公司名称} 系统测试邮件');
  expect(result.result?.variable_document?.body.filter((node) => node.type === 'variable')).toEqual(
    mailTemplates
      .find((template) => template.id === 'group-custom-requirements')!
      .variable_document!.body.filter((node) => node.type === 'variable'),
  );
  expect(result.draft_id).toBeNull();
});

it('corrects a missing template slot once inside the same guarded run without saving the invalid draft', async () => {
  const { picked, variable_document } = await variableTemplate();
  let attempts = 0;
  answerFactory = (input) => {
    attempts++;
    const masked = maskedTemplate(input);
    if (attempts === 1) return pack({ draft_body: '只写系统测试，不含变量的错误草稿。' });
    expect(input.snapshot.warnings.at(-1)).toContain('唯一一次变量纠正');
    expect(input.snapshot.warnings.at(-1)).toContain('missing_subject');
    expect(input.history.some((turn) => turn.content.includes('不含变量的错误草稿'))).toBe(false);
    return pack({
      draft_subject: masked.subject,
      draft_body: `${masked.body}本邮件仅用于系统测试。`,
    });
  };
  const response = await run(picked, '生成当前邮件草稿', {
    phase: 'draft',
    task_action: 'draft_current',
  }).expect(200);
  const result = response.body.workflow as HomeWorkflow;
  expect(attempts).toBe(2);
  expect(result.result?.variable_document?.body[0]).toEqual(variable_document.body[0]);
  expect(result.config.template_choice).toEqual(picked.config.template_choice);
  expect(result.draft_id).toBeNull();
  expect(result.result?.draft_body).not.toContain('错误草稿');
  expect(response.body.detail.messages).toHaveLength(2);
  const trace = result.result!.harness!.trace;
  expect(
    trace.filter((event) => event.step_id === 'compose_mail' && event.status === 'succeeded'),
  ).toHaveLength(2);
  expect(
    trace.filter((event) => event.step_id === 'validate_result' && event.status === 'failed'),
  ).toHaveLength(1);
  expect(
    trace.filter((event) => event.step_id === 'validate_result' && event.status === 'succeeded'),
  ).toHaveLength(1);
  expect(Math.max(...trace.map((event) => event.sequence))).toBeLessThanOrEqual(8);
  expect(JSON.stringify(trace)).not.toContain('错误草稿');
});

it('does not use the variable correction for invalid evidence or after cancellation', async () => {
  const first = await variableTemplate();
  answerFactory = (input) => {
    const masked = maskedTemplate(input);
    return pack({ draft_subject: masked.subject, draft_body: masked.body });
  };
  outerSources = ['unauthorized:source'];
  await run(first.picked, '生成当前邮件草稿', {
    phase: 'draft',
    task_action: 'draft_current',
  }).expect(502);
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(1);
  outerSources = [];
  seen.length = 0;
  const second = await variableTemplate();
  hook = async () => {
    await client
      .post(`/api/chats/${second.picked.chat_id}/workflow/cancel`)
      .set(h())
      .send({ version: second.picked.version })
      .expect(200);
  };
  answerFactory = () => pack({ draft_body: '缺少固定槽位。' });
  await run(second.picked, '生成当前邮件草稿', {
    phase: 'draft',
    task_action: 'draft_current',
  }).expect(409);
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(1);
  const current = (
    await client.get(`/api/chats/${second.picked.chat_id}/workflow`).set(h()).expect(200)
  ).body as HomeWorkflow;
  expect(current.result).toBeNull();
  expect(current.draft_id).toBeNull();
});

it('revalidates configuration while correcting and never persists a late corrected draft', async () => {
  const { picked } = await variableTemplate();
  let attempts = 0;
  answerFactory = (input) => {
    attempts++;
    if (attempts === 1) {
      hook = async () => {
        await configure(picked, { instruction: '本人已修改的下一版要求' });
      };
      return pack({ draft_body: '缺少固定槽位。' });
    }
    const masked = maskedTemplate(input);
    return pack({ draft_subject: masked.subject, draft_body: masked.body });
  };
  await run(picked, '生成当前邮件草稿', {
    phase: 'draft',
    task_action: 'draft_current',
  }).expect(409);
  expect(attempts).toBe(2);
  const current = (await client.get(`/api/chats/${picked.chat_id}/workflow`).set(h()).expect(200))
    .body as HomeWorkflow;
  expect(current.result).toBeNull();
  expect(current.draft_id).toBeNull();
  expect(current.config.instruction).toBe('本人已修改的下一版要求');
  expect(
    (await client.get(`/api/chats/${picked.chat_id}`).set(h()).expect(200)).body.messages,
  ).toHaveLength(0);
});

it('rejects missing, repeated, invented and cross-part model slots while preserving the selected template', async () => {
  const { picked } = await variableTemplate();
  for (const failure of ['missing', 'duplicate', 'cross', 'invented', 'missing-subject']) {
    const callsBefore = seen.filter((input) => input.phase === 'answer').length;
    answerFactory = (input) => {
      const masked = maskedTemplate(input),
        marker = masked.body.match(/\[\[CRM_SLOT:[^\]]+\]\]/)![0];
      return pack({
        ...(failure === 'missing-subject'
          ? {}
          : { draft_subject: masked.subject + (failure === 'cross' ? marker : '') }),
        draft_body:
          failure === 'missing' || failure === 'cross'
            ? '普通正文'
            : masked.body +
              (failure === 'duplicate'
                ? marker
                : failure === 'invented'
                  ? '[[CRM_SLOT:body:invented]]'
                  : ''),
      });
    };
    await run(picked, '生成当前邮件草稿', { phase: 'draft', task_action: 'draft_current' }).expect(
      502,
    );
    expect(seen.filter((input) => input.phase === 'answer').length - callsBefore).toBe(2);
    const current = (await client.get(`/api/chats/${picked.chat_id}/workflow`).set(h()).expect(200))
      .body as HomeWorkflow;
    expect(current.config.template_choice).toEqual(picked.config.template_choice);
    expect(current.result).toBeNull();
    expect(current.draft_id).toBeNull();
  }
});

it('keeps reply issue coverage and template references while opening the existing reply composer', async () => {
  const { picked, variable_document } = await variableTemplate('reply');
  answerFactory = (input) => {
    const masked = maskedTemplate(input);
    return pack({ draft_subject: masked.subject, draft_body: `${masked.body}已收到尺码问题。` });
  };
  const generated = (
    await run(picked, '生成当前回复草稿', { phase: 'draft', task_action: 'draft_current' }).expect(
      200,
    )
  ).body.workflow as HomeWorkflow;
  expect(generated.result?.variable_document?.body[0]).toEqual(variable_document.body[0]);
  expect(generated.result?.coverage?.[0].draft_quote).toBe(generated.result?.draft_body);
  expect(JSON.stringify(generated.result)).not.toContain('[[CRM_SLOT:');
  const opened = (
    await client
      .post(`/api/chats/${picked.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: generated.version })
      .expect(200)
  ).body;
  expect(opened.draft.reply_to_message_id).toBe(mailA);
  expect(opened.draft.variable_document).toEqual(generated.result?.variable_document);
  expect(opened.draft.approved_version).toBeNull();
});

it('includes reference changes in the selected template digest even when its visible labels are unchanged', async () => {
  const { picked, saved, variable_document } = await variableTemplate();
  const changed = structuredClone(variable_document);
  changed.subject[1] = {
    ...changed.subject[1],
    root: 'recipient_company',
  } as (typeof changed.subject)[1];
  await db.query('UPDATE mail_templates SET variable_document=$2::jsonb WHERE id=$1', [
    saved.id,
    JSON.stringify(changed),
  ]);
  const current = (await client.get(`/api/chats/${picked.chat_id}/workflow`).set(h()).expect(200))
    .body as HomeWorkflow;
  expect(current.step).toBe('template');
  expect(current.result).toBeNull();
  await run(current, '生成当前邮件草稿', { phase: 'draft', task_action: 'draft_current' }).expect(
    409,
  );
});

const selectTemplate = async (
  w: HomeWorkflow,
  choice: { kind: 'none' } | { kind: 'starter' | 'saved'; id: string },
) =>
  (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/template`)
      .set(h())
      .send({ version: w.version, choice })
      .expect(200)
  ).body as HomeWorkflow;

it('persists compose in the template stage without reading sources or creating outgoing mail', async () => {
  const id = await chat();
  const w = (
    await client.post(`/api/chats/${id}/workflow`).set(h()).send({ kind: 'compose' }).expect(201)
  ).body as HomeWorkflow;
  expect(w).toMatchObject({
    kind: 'compose',
    step: 'template',
    config: { template_choice: null },
    draft_id: null,
  });
  const templates = (await client.get(`/api/chats/${id}/workflow/templates`).set(h()).expect(200))
    .body;
  expect(
    templates.some(
      (item: { kind: string; id: string }) =>
        item.kind === 'starter' && item.id === 'product-size-inquiry',
    ),
  ).toBe(true);
  expect(seen).toHaveLength(0);
  expect((await client.get(`/api/chats/${id}/workflow`).set(h()).expect(200)).body.step).toBe(
    'template',
  );
  const picked = await selectTemplate(w, { kind: 'none' });
  await run(picked, '拟稿', { phase: 'draft' }).expect(400);
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(0);
});

it('continues an existing compose template wait as a normal answer without reading business sources', async () => {
  const w = await configure(await task('compose'), { person_id: person });
  classifyIntent = '起草内容';
  classificationExtra = { turn_action: 'continue' };
  completeMailStructure = false;
  answerFactory = () => pack({ body: '请从任务卡选择模板，或选择不使用模板。' });
  const outgoingCount = () =>
    scoped(
      db,
      actor,
      workspace,
      async (ctx) =>
        (
          await ctx.tx.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM outgoing_mail WHERE workspace_id=$1',
            [workspace],
          )
        ).rows[0].count,
    );
  const before = await outgoingCount();
  const result = (await run(w, '给当前联系人写邮件').expect(200)).body.workflow as HomeWorkflow;
  expect(result).toMatchObject({
    step: 'template',
    draft_id: null,
    config: { template_choice: null },
    result: { draft_body: null, issues: [], mail_decisions: [], coverage: [] },
  });
  const input = seen.find((value) => value.phase === 'answer')!;
  expect(input.snapshot.sources.map((source) => source.id)).toEqual(['user:instruction']);
  expect(input.snapshot.warnings.join('\n')).toContain('这是正常等待，不是执行错误');
  expect(input.snapshot.warnings.join('\n')).toContain('本轮不要求邮件事项三数组');
  expect(seen.filter((value) => value.phase === 'answer')).toHaveLength(1);
  expect(await outgoingCount()).toBe(before);
});

it('still rejects a draft from the template-wait explanation and an explicit unselected draft request', async () => {
  const w = await task('compose');
  classifyIntent = '起草内容';
  classificationExtra = { turn_action: 'continue' };
  completeMailStructure = false;
  answerFactory = () => pack({ draft_body: '不应在选择模板前生成。' });
  await run(w, '先看看模板').expect(502);
  const current = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(current).toMatchObject({
    step: 'template',
    result: null,
    draft_id: null,
    version: w.version,
  });
  expect((await client.get(`/api/chats/${w.chat_id}`).set(h()).expect(200)).body.messages).toEqual(
    [],
  );
  seen.length = 0;
  await run(w, '直接拟稿', { phase: 'draft' }).expect(409);
  expect(seen.filter((value) => value.phase === 'answer')).toEqual([]);
});

it.each(['issues', 'mail_decisions', 'coverage'])(
  'rejects omitted %s during actual compose processing without retrying',
  async (omitted) => {
    const w = await selectTemplate(await task('compose'), { kind: 'none' });
    completeMailStructure = false;
    answerFactory = () => {
      const value: Record<string, unknown> = pack({
        draft_body: '本轮信息已完整的虚构草稿。',
        issues: [],
        mail_decisions: [],
        coverage: [],
      });
      delete value[omitted];
      return value;
    };
    const failed = await run(w, '生成当前邮件草稿', { phase: 'draft' }).expect(502);
    expect(failed.body.error).toContain('事项、口径或覆盖数组');
    expect(seen.filter((value) => value.phase === 'answer')).toHaveLength(1);
    expect(
      (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body,
    ).toMatchObject({ version: w.version, result: null, draft_id: null });
    expect(
      (await client.get(`/api/chats/${w.chat_id}`).set(h()).expect(200)).body.messages,
    ).toEqual([]);
  },
);

it('allows explicitly empty mail arrays and includes them in the actual final prompt example', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  completeMailStructure = false;
  answerFactory = () =>
    pack({ draft_body: '这是信息完整的虚构通知。', issues: [], mail_decisions: [], coverage: [] });
  const result = (await run(w, '生成当前邮件草稿', { phase: 'draft' }).expect(200)).body
    .workflow as HomeWorkflow;
  expect(result.result).toMatchObject({ issues: [], mail_decisions: [], coverage: [] });
  const warnings = seen.find((value) => value.phase === 'answer')!.snapshot.warnings;
  const finalExample = warnings.find((warning) => warning.startsWith('本流程需要结构化结果：'))!;
  expect(finalExample).toContain('"issues":[],"mail_decisions":[],"coverage":[]');
  expect(finalExample).toContain('没有对应事项时返回[]，不得省略字段');
  expect(warnings.join('\n')).toContain('不为填满结构而制造缺口');
});

it('preserves separate pending placeholders and one coverage entry for each declared missing detail', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  const issues = ['款式', '数量'].map((name, i) => ({
    id: `missing_${i}`,
    question: `${name}是什么？`,
    source_ids: [],
    quote: '',
    status: 'missing',
    response: null,
  }));
  answerFactory = () =>
    pack({
      body: '已准备草稿，款式和数量仍待补充。',
      draft_body: '您好，请核对【待填写：款式】和【待填写：数量】。',
      issues,
      mail_decisions: issues.map((issue) => ({
        issue_id: issue.id,
        question: issue.question,
        answer: null,
      })),
      coverage: issues.map((issue) => ({
        issue_id: issue.id,
        status: 'pending',
        draft_quote: null,
      })),
    });
  const result = (await run(w, '先拟草稿，款式数量稍后填写', { phase: 'draft' }).expect(200)).body
    .workflow as HomeWorkflow;
  expect(result.result?.draft_body).toContain('【待填写：款式】');
  expect(result.result?.draft_body).toContain('【待填写：数量】');
  expect(result.result?.issues).toHaveLength(2);
  expect(result.result?.coverage).toEqual(
    issues.map((issue) => ({ issue_id: issue.id, status: 'pending', draft_quote: null })),
  );
});

it('rejects a missing coverage entry for a declared pending detail instead of saving a partial checklist', async () => {
  const w = await selectTemplate(await task('compose'), { kind: 'none' });
  answerFactory = () =>
    pack({
      draft_body: '请补充【待填写：款式】和【待填写：数量】。',
      issues: ['款式', '数量'].map((name, i) => ({
        id: `missing_${i}`,
        question: `${name}是什么？`,
        source_ids: [],
        quote: '',
        status: 'missing',
        response: null,
      })),
      mail_decisions: [],
      coverage: [{ issue_id: 'missing_0', status: 'pending', draft_quote: null }],
    });
  await run(w, '先拟草稿', { phase: 'draft' }).expect(502);
  expect(seen.filter((value) => value.phase === 'answer')).toHaveLength(1);
  expect(
    (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body.result,
  ).toBeNull();
});

it('composes from a selected template and opens one ordinary draft without reply metadata or send side effects', async () => {
  const w = await configure(await task('compose'), {
    person_id: person,
    project_id: project,
    instruction: '请向沈老师确认已收到尺码需求。',
  });
  const picked = await selectTemplate(w, { kind: 'starter', id: 'product-size-inquiry' });
  answerFactory = (input) => ({
    ...starterDraft(input, '沈老师您好，已收到您的尺码需求。', '尺码需求确认'),
    body: '邮件正文已准备。',
  });
  const next = (await run(picked, '生成邮件草稿', { phase: 'draft' }).expect(200)).body
    .workflow as HomeWorkflow;
  const model = seen.find((input) => input.phase === 'answer')!;
  expect(model.task_instructions).toContain('邮件');
  expect(
    model.snapshot.sources.some(
      (source) => source.id === 'mail-template:starter:product-size-inquiry',
    ),
  ).toBe(true);
  expect(model.snapshot.sources.some((source) => source.ref?.kind === 'record')).toBe(false);
  expect(next.result?.draft_subject).toBe('尺码需求确认');
  expect(next.result?.draft_body).toBe(
    '沈老师您好，已收到您的尺码需求。\n{收件人 › 姓名}\n{发件账号 › 发件邮箱}',
  );
  expect(next.result?.variable_document?.body.filter((node) => node.type === 'variable')).toEqual(
    productTemplateVariables(),
  );
  const first = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  const second = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  expect(first.draft.id).toBe(second.draft.id);
  expect(first.draft.variable_document).toEqual(next.result?.variable_document);
  expect(second.draft.variable_document).toEqual(first.draft.variable_document);
  expect(first.draft).toMatchObject({
    status: 'draft',
    person_id: person,
    customer_id: a,
    project_id: project,
    to: ['person@fixture.invalid'],
    reply_to_message_id: null,
    in_reply_to: null,
    reference_ids: [],
    approved_version: null,
    scheduled_at: null,
  });
  expect(first.workflow.result.harness.skill.id).toBe('handle-incoming-mail');
  expect(
    first.workflow.result.harness.trace.some(
      (entry: { step_id: string }) => entry.step_id === 'save_draft',
    ),
  ).toBe(true);
  expect(JSON.stringify(first.workflow.result.harness.trace)).not.toContain('沈老师您好');
});

it('only lists and accepts the current actor templates authorized for the chosen customer', async () => {
  const own = (
    await client
      .post(`/api/customers/${a}/mail-templates`)
      .set(h())
      .send({ name: '甲专用模板', body: '甲表达参考', subject: '甲主题', scope: 'customer' })
      .expect(201)
  ).body;
  const other = (
    await client
      .post(`/api/customers/${b}/mail-templates`)
      .set(h())
      .send({ name: '乙专用模板', body: '乙私有表达', subject: '乙主题', scope: 'customer' })
      .expect(201)
  ).body;
  const foreign = randomUUID();
  await scoped(db, member, workspace, (ctx) =>
    ctx.tx.query(
      "INSERT INTO mail_templates(workspace_id,actor_id,id,scope,customer_id,name,subject,body) VALUES($1,$2,$3,'personal',NULL,'另一人的模板','私有主题','另一人的私有模板正文')",
      [workspace, member, foreign],
    ),
  );
  const w = await task('compose');
  const listed = (
    await client.get(`/api/chats/${w.chat_id}/workflow/templates`).set(h()).expect(200)
  ).body;
  expect(listed.some((item: { id: string }) => item.id === own.id)).toBe(true);
  expect(JSON.stringify(listed)).not.toContain('乙私有表达');
  expect(JSON.stringify(listed)).not.toContain('另一人的私有模板正文');
  for (const id of [other.id, foreign, randomUUID()])
    await client
      .post(`/api/chats/${w.chat_id}/workflow/template`)
      .set(h())
      .send({ version: w.version, choice: { kind: 'saved', id } })
      .expect(404);
  const picked = await selectTemplate(w, { kind: 'saved', id: own.id });
  expect(picked.config.selected_template_name).toBe('甲专用模板');
});

it('changing a selected template invalidates an already approved draft and its schedule', async () => {
  const picked = await selectTemplate(await task('compose'), { kind: 'none' });
  answerFactory = () => pack({ draft_body: '您好，请补充尺码。' });
  const next = (await run(picked, '拟稿', { phase: 'draft' }).expect(200)).body.workflow;
  const opened = (
    await client
      .post(`/api/chats/${picked.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  const approved = (
    await client
      .post(`/api/outgoing/${opened.draft.id}/approve`)
      .set(h())
      .send({ version: opened.draft.version })
      .expect(200)
  ).body;
  await client
    .post(`/api/outgoing/${opened.draft.id}/schedule`)
    .set(h())
    .send({
      version: approved.version,
      mode: 'later',
      at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'Asia/Shanghai',
    })
    .expect(200);
  const changed = await selectTemplate(opened.workflow, {
    kind: 'starter',
    id: 'product-size-inquiry',
  });
  expect(changed.draft_id).toBeNull();
  expect(changed.result?.draft_body).toBeNull();
  const old = (await client.get(`/api/outgoing/${opened.draft.id}`).set(h()).expect(200)).body;
  expect(old).toMatchObject({ status: 'cancelled', approved_version: null, scheduled_at: null });
  await client
    .post(`/api/chats/${picked.chat_id}/workflow/template`)
    .set(h())
    .send({ version: opened.workflow.version, choice: { kind: 'none' } })
    .expect(409);
});

it('requires selecting a changed saved template again before drafting or opening an old result', async () => {
  const template = (
    await client
      .post(`/api/customers/${a}/mail-templates`)
      .set(h())
      .send({ name: '版本模板', body: '原始表达', subject: '主题', scope: 'customer' })
      .expect(201)
  ).body;
  const picked = await selectTemplate(await task('compose'), { kind: 'saved', id: template.id });
  answerFactory = () => pack({ draft_body: '您好。' });
  const next = (await run(picked, '拟稿', { phase: 'draft' }).expect(200)).body.workflow;
  await db.query('UPDATE mail_templates SET body=$2 WHERE id=$1', [template.id, '更新后的表达']);
  const restored = (await client.get(`/api/chats/${picked.chat_id}/workflow`).set(h()).expect(200))
    .body;
  expect(restored).toMatchObject({ step: 'template', result: null });
  await run(next, '继续拟稿', { phase: 'draft' }).expect(409);
  await client
    .post(`/api/chats/${picked.chat_id}/workflow/reply-draft`)
    .set(h())
    .send({ version: next.version })
    .expect(409);
});

it('keeps the selected primary mail separate from explicitly authorized historical dates', async () => {
  const w = await configure(await task('reply'), { mail_id: mailA });
  await run(w, '分析本封来信').expect(200);
  const primary = seen.find((input) => input.phase === 'answer')!;
  expect(JSON.stringify(primary.snapshot.sources)).toContain('甲当前来信');
  expect(JSON.stringify(primary.snapshot.sources)).not.toContain('甲旧来信');
  const current = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  const expanded = await configure(current, {
    history_scope: {
      enabled: true,
      date_start: '2026-10-25',
      date_end: '2026-10-25',
      source_kinds: ['mail'],
      person_id: null,
      project_id: null,
    },
  });
  seen.length = 0;
  await run(expanded, '参考明确选择的历史').expect(200);
  const joined = seen.find((input) => input.phase === 'answer')!;
  expect(JSON.stringify(joined.snapshot.sources)).toContain('甲当前来信');
  expect(JSON.stringify(joined.snapshot.sources)).toContain('甲旧来信');
  expect(JSON.stringify(joined.snapshot.sources)).not.toContain('乙客户专属');
  expect(joined.snapshot.sources.filter((source) => source.ref?.kind === 'record').length).toBe(2);
});

it('does not broaden a chosen person or project through the historical source configuration', async () => {
  const w = await configure(await task('reply'), {
    person_id: person,
    project_id: project,
    mail_id: mailA,
  });
  await client
    .patch(`/api/chats/${w.chat_id}/workflow`)
    .set(h())
    .send({
      version: w.version,
      config: {
        ...w.config,
        history_scope: {
          enabled: true,
          date_start: null,
          date_end: null,
          source_kinds: ['mail'],
          person_id: null,
          project_id: null,
        },
      },
    })
    .expect(400);
});

it('validates issue evidence and literal draft coverage while preserving legacy result compatibility', async () => {
  const w = await configure(await task('reply'), { mail_id: mailA });
  answerFactory = (input) => {
    const source = input.snapshot.sources.find((item) => item.ref?.kind === 'record')!;
    return pack({
      draft_body: '您好，尺码需求已收到。',
      issues: [
        {
          id: 'size',
          question: '尺码需求',
          source_ids: [source.id],
          quote: '甲当前来信：需要确认尺码。',
          status: 'answerable',
          response: '确认收到',
        },
      ],
      mail_decisions: [],
      coverage: [{ issue_id: 'size', status: 'covered', draft_quote: '尺码需求已收到' }],
    });
  };
  const result = (await run(w, '拟稿', { phase: 'draft' }).expect(200)).body.workflow;
  expect(result.result.issues[0].id).toBe('size');
  expect(result.result.coverage[0].status).toBe('covered');
  const current = result as HomeWorkflow;
  answerFactory = () =>
    pack({
      draft_body: '您好。',
      issues: [
        {
          id: 'size',
          question: '尺码需求',
          source_ids: ['forged:record'],
          quote: '假造原文',
          status: 'answerable',
          response: '假造答复',
        },
      ],
      coverage: [{ issue_id: 'size', status: 'covered', draft_quote: '不存在的正文' }],
    });
  await run(current, '重写', { phase: 'draft' }).expect(502);
  expect(
    (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body.result
      .draft_body,
  ).toBe('您好，尺码需求已收到。');
});

it('hands an explicit new-mail intent from an existing workflow into a fresh template stage without old sources', async () => {
  const w = await configure(await task('reply'), { mail_id: mailA });
  mailAction = 'compose';
  classifyIntent = '起草内容';
  target = '甲公司';
  answerFactory = () => pack({ body: '请先选择模板，或明确不使用模板。' });
  const result = (await run(w, '另写一封邮件给甲公司', { phase: 'draft' }).expect(200)).body
    .workflow;
  expect(result).toMatchObject({
    kind: 'compose',
    step: 'template',
    result: null,
    draft_id: null,
    config: {
      customer_id: a,
      mail_id: null,
      template_choice: null,
      history_scope: null,
      instruction: '另写一封邮件给甲公司',
    },
  });
  const input = seen.find((item) => item.phase === 'answer')!;
  expect(JSON.stringify(input.snapshot.sources)).not.toContain('甲当前来信');
  expect(input.history).toEqual([]);
});

it('does not reset a selected template when continuing to draft the same compose task', async () => {
  const picked = await selectTemplate(await task('compose'), {
    kind: 'starter',
    id: 'product-size-inquiry',
  });
  answerFactory = (input) => starterDraft(input, '您好，请补充尺码。');
  const result = (await run(picked, '生成当前邮件草稿', { phase: 'draft' }).expect(200)).body
    .workflow;
  expect(result).toMatchObject({
    kind: 'compose',
    step: 'ready',
    config: { template_choice: { kind: 'starter', id: 'product-size-inquiry' } },
  });
  expect(result.result.draft_body).toBe(
    '您好，请补充尺码。\n{收件人 › 姓名}\n{发件账号 › 发件邮箱}',
  );
  expect(
    result.result.variable_document.body.filter(
      (node: { type: string }) => node.type === 'variable',
    ),
  ).toEqual(productTemplateVariables());
});

it('continues a confirmed template draft even when the model classifies the original instruction as compose again', async () => {
  const original = '给甲公司发一封邮件，请对方补充尺码。';
  const configured = await configure(await task('compose'), { instruction: original });
  const picked = await selectTemplate(configured, { kind: 'starter', id: 'product-size-inquiry' });
  classifyIntent = '起草内容';
  mailAction = 'compose';
  target = '甲公司';
  answerFactory = (input) => starterDraft(input, '您好，请补充尺码。');
  const request_id = randomUUID();
  const result = (
    await run(picked, original, {
      request_id,
      phase: 'draft',
      task_action: 'draft_current',
    }).expect(200)
  ).body.workflow as HomeWorkflow;
  expect(result).toMatchObject({
    kind: 'compose',
    step: 'ready',
    config: { template_choice: { kind: 'starter', id: 'product-size-inquiry' } },
  });
  expect(result.result?.draft_body).toBe(
    '您好，请补充尺码。\n{收件人 › 姓名}\n{发件账号 › 发件邮箱}',
  );
  expect(result.result?.variable_document?.body.filter((node) => node.type === 'variable')).toEqual(
    productTemplateVariables(),
  );
  const answered = seen.find((input) => input.phase === 'answer')!;
  expect(
    answered.snapshot.sources.some(
      (source) => source.id === 'mail-template:starter:product-size-inquiry',
    ),
  ).toBe(true);
  expect(seen.filter((input) => input.phase === 'classify')).toHaveLength(1);
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(1);
  const calls = seen.length;
  const repeated = (
    await run(picked, original, {
      request_id,
      phase: 'draft',
      task_action: 'draft_current',
    }).expect(200)
  ).body.workflow;
  expect(repeated.result.draft_body).toBe(result.result?.draft_body);
  expect(repeated.result.variable_document).toEqual(result.result?.variable_document);
  expect(seen).toHaveLength(calls);
});

it('does not let a current-draft action skip the selected template, mailing kind or draft phase', async () => {
  const mailing = await task('compose');
  await run(mailing, '给甲公司发一封邮件', { phase: 'draft', task_action: 'draft_current' }).expect(
    409,
  );
  const picked = await selectTemplate(mailing, { kind: 'none' });
  await run(picked, '当前邮件', { phase: 'analyze', task_action: 'draft_current' }).expect(400);
  const summary = await task('summary');
  await run(summary, '给甲公司发一封邮件', { phase: 'draft', task_action: 'draft_current' }).expect(
    400,
  );
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(0);
});

it('rejects a different target in a current-draft request without replacing the selected scope or template', async () => {
  const picked = await selectTemplate(await task('compose'), { kind: 'none' });
  classifyIntent = '起草内容';
  mailAction = 'compose';
  target = '乙公司';
  await run(picked, '改成给乙公司发邮件', { phase: 'draft', task_action: 'draft_current' }).expect(
    409,
  );
  const restored = (await client.get(`/api/chats/${picked.chat_id}/workflow`).set(h()).expect(200))
    .body;
  expect(restored).toMatchObject({
    kind: 'compose',
    config: { customer_id: a, template_choice: { kind: 'none' } },
    result: null,
    draft_id: null,
  });
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(0);
});

it('treats an explicit new user message as a new email even after a template was selected', async () => {
  const picked = await selectTemplate(await task('compose'), { kind: 'none' });
  classifyIntent = '起草内容';
  mailAction = 'compose';
  target = '甲公司';
  answerFactory = () => pack({ body: '请为新邮件选择模板。' });
  const result = (
    await run(picked, '另写一封邮件给甲公司', { phase: 'draft', task_action: 'message' }).expect(
      200,
    )
  ).body.workflow;
  expect(result).toMatchObject({
    kind: 'compose',
    step: 'template',
    config: { customer_id: a, template_choice: null },
    result: null,
    draft_id: null,
  });
});

it('keeps omitted action fingerprints compatible with legacy completed request replay', async () => {
  const w = await configure(await task('reply'), { mail_id: mailA });
  const request_id = randomUUID();
  const legacy = { version: w.version, request_id, body: '分析本封来信', phase: 'analyze' };
  expect(runInput.parse(legacy)).not.toHaveProperty('task_action');
  await run(w, legacy.body, { request_id, phase: 'analyze' }).expect(200);
  const stored = await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query<{ fingerprint: string }>(
      'SELECT fingerprint FROM home_workflow_requests WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
      [workspace, actor, request_id],
    ),
  );
  expect(stored.rows[0].fingerprint).toBe(
    createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
  );
  const calls = seen.length;
  await run(w, legacy.body, { request_id, phase: 'analyze' }).expect(200);
  expect(seen).toHaveLength(calls);
});

it('applies the same draft-current gate before a background run is accepted', async () => {
  const w = await task('compose');
  const input = {
    version: w.version,
    request_id: randomUUID(),
    body: '继续当前邮件',
    phase: 'draft',
    task_action: 'draft_current',
  };
  await expect(
    scoped(db, actor, workspace, (ctx) => prepareRun(ctx, w.chat_id, input)),
  ).rejects.toMatchObject({ status: 409 });
  const picked = await selectTemplate(w, { kind: 'none' });
  const prepared = await scoped(db, actor, workspace, (ctx) =>
    prepareRun(ctx, picked.chat_id, { ...input, version: picked.version }),
  );
  expect(prepared.value.task_action).toBe('draft_current');
  expect(prepared.value.phase).toBe('draft');
  await expect(
    scoped(db, actor, workspace, (ctx) =>
      prepareRun(ctx, picked.chat_id, { ...input, version: picked.version, phase: 'analyze' }),
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it('uses a verified current-draft action when coarse intent is general while preserving the raw classification audit', async () => {
  const picked = await selectTemplate(await task('compose'), { kind: 'none' });
  classifyIntent = '一般对话';
  answerFactory = () => pack({ draft_body: '您好，请补充尺码。' });
  const result = (
    await run(picked, '按当前确认继续拟稿', {
      phase: 'draft',
      task_action: 'draft_current',
    }).expect(200)
  ).body;
  expect(result.workflow).toMatchObject({
    kind: 'compose',
    step: 'ready',
    config: { template_choice: { kind: 'none' } },
  });
  expect(result.workflow.result.draft_body).toBe('您好，请补充尺码。');
  expect(seen.find((input) => input.phase === 'answer')?.classification?.intent).toBe('起草内容');
  expect(result.detail.messages.at(-1).classification.intent).toBe('一般对话');
});

it('rejects cancellation or device-reading requests disguised as a current-draft action without changing the template', async () => {
  const picked = await selectTemplate(await task('compose'), { kind: 'none' });
  await run(picked, '取消任务', { phase: 'draft', task_action: 'draft_current' }).expect(409);
  classifyDataSource = 'wechat_device';
  await run(picked, '读取新的设备微信再拟稿', {
    phase: 'draft',
    task_action: 'draft_current',
  }).expect(409);
  const restored = (await client.get(`/api/chats/${picked.chat_id}/workflow`).set(h()).expect(200))
    .body;
  expect(restored).toMatchObject({
    kind: 'compose',
    step: 'ready',
    config: { template_choice: { kind: 'none' } },
    result: null,
    draft_id: null,
  });
  expect(seen.filter((input) => input.phase === 'answer')).toHaveLength(0);
  expect(wechatReads).toBe(0);
});

it('rejects missing primary-mail issues, empty quotes, historical-only issues and incomplete draft coverage', async () => {
  const w = await configure(await task('reply'), {
    mail_id: mailA,
    history_scope: {
      enabled: true,
      date_start: '2026-10-25',
      date_end: '2026-10-25',
      source_kinds: ['mail'],
      person_id: null,
      project_id: null,
    },
  });
  for (const invalid of ['no_issues', 'empty_quote', 'history_only', 'no_coverage']) {
    answerFactory = (input) => {
      const primary = input.snapshot.sources.find((source) =>
        source.title.startsWith('本次来信 · '),
      )!;
      const history = input.snapshot.sources.find((source) =>
        source.title.startsWith('授权历史 · '),
      )!;
      return pack({
        draft_body: '您好，已收到。',
        issues:
          invalid === 'no_issues'
            ? []
            : [
                {
                  id: 'primary',
                  question: '确认收到',
                  source_ids: [invalid === 'history_only' ? history.id : primary.id],
                  quote:
                    invalid === 'empty_quote'
                      ? ''
                      : invalid === 'history_only'
                        ? history.body
                        : primary.body,
                  status: 'answerable',
                  response: '确认收到',
                },
              ],
        coverage:
          invalid === 'no_coverage'
            ? []
            : invalid === 'no_issues'
              ? []
              : [{ issue_id: 'primary', status: 'covered', draft_quote: '已收到' }],
      });
    };
    await run(w, '拟稿', { phase: 'draft' }).expect(502);
  }
  expect(
    (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body.result,
  ).toBeNull();
});

it('does not restamp stale source analysis when choosing a new template', async () => {
  const w = await configure(await task('reply'), { mail_id: mailA });
  const analyzed = (await run(w, '分析这封来信').expect(200)).body.workflow;
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query('UPDATE mail_messages SET body=$2 WHERE id=$1', [
      mailA,
      '这封来信的内容已经变化。',
    ]),
  );
  try {
    const changed = await selectTemplate(analyzed, { kind: 'starter', id: 'product-size-inquiry' });
    expect(changed.result).toBeNull();
    expect(changed.step).toBe('ready');
  } finally {
    await scoped(db, actor, workspace, (ctx) =>
      ctx.tx.query('UPDATE mail_messages SET body=$2 WHERE id=$1', [
        mailA,
        '甲当前来信：需要确认尺码。',
      ]),
    );
  }
});

it('invalidates an old scheduled draft when explicitly starting a different email in the same chat', async () => {
  const w = await configure(await task('reply'), { mail_id: mailA });
  answerFactory = () => pack({ draft_body: '您好，请补充尺码。' });
  const ready = (await run(w, '起草回复', { phase: 'draft' }).expect(200)).body.workflow;
  const opened = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: ready.version })
      .expect(200)
  ).body;
  const approved = (
    await client
      .post(`/api/outgoing/${opened.draft.id}/approve`)
      .set(h())
      .send({ version: opened.draft.version })
      .expect(200)
  ).body;
  await client
    .post(`/api/outgoing/${opened.draft.id}/schedule`)
    .set(h())
    .send({
      version: approved.version,
      mode: 'later',
      at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'Asia/Shanghai',
    })
    .expect(200);
  mailAction = 'compose';
  classifyIntent = '起草内容';
  answerFactory = () => pack({ body: '请先选择模板。' });
  const result = (await run(opened.workflow, '另写一封新邮件', { phase: 'draft' }).expect(200)).body
    .workflow;
  expect(result).toMatchObject({
    kind: 'compose',
    step: 'template',
    draft_id: null,
    config: { template_choice: null },
  });
  expect(
    (await client.get(`/api/outgoing/${opened.draft.id}`).set(h()).expect(200)).body,
  ).toMatchObject({ status: 'cancelled', approved_version: null, scheduled_at: null });
});

it('refuses to replace a workflow whose outgoing mail has already started sending', async () => {
  const w = await configure(await task('reply'), { mail_id: mailA });
  answerFactory = () => pack({ draft_body: '您好，请补充尺码。' });
  const ready = (await run(w, '起草回复', { phase: 'draft' }).expect(200)).body.workflow;
  const opened = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: ready.version })
      .expect(200)
  ).body;
  const approved = (
    await client
      .post(`/api/outgoing/${opened.draft.id}/approve`)
      .set(h())
      .send({ version: opened.draft.version })
      .expect(200)
  ).body;
  await client
    .post(`/api/outgoing/${opened.draft.id}/schedule`)
    .set(h())
    .send({
      version: approved.version,
      mode: 'later',
      at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'Asia/Shanghai',
    })
    .expect(200);
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query("UPDATE outgoing_mail SET status='sending',started_at=now() WHERE id=$1", [
      opened.draft.id,
    ]),
  );
  mailAction = 'compose';
  classifyIntent = '起草内容';
  answerFactory = () => pack({ body: '请先选择模板。' });
  await run(opened.workflow, '另写一封新邮件', { phase: 'draft' }).expect(409);
  const restored = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(restored.kind).toBe('reply');
  expect(restored.draft_id).toBe(opened.draft.id);
});

it('rejects own outbound mail as the primary customer message while keeping it eligible for explicit history', async () => {
  const w = await task('reply');
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query("UPDATE mail_messages SET direction='outbound' WHERE id=$1", [mailOld]),
  );
  try {
    await client
      .patch(`/api/chats/${w.chat_id}/workflow`)
      .set(h())
      .send({
        version: w.version,
        config: { ...w.config, mail_id: mailOld, date_start: null, date_end: null },
      })
      .expect(400);
    const historical = await configure(w, {
      mail_id: mailA,
      history_scope: {
        enabled: true,
        date_start: '2026-10-25',
        date_end: '2026-10-25',
        source_kinds: ['mail'],
        person_id: null,
        project_id: null,
      },
    });
    await run(historical, '分析主信及明确选择的历史').expect(200);
    const model = seen.find((input) => input.phase === 'answer')!;
    expect(
      model.snapshot.sources.some((source) => source.title.startsWith('授权历史 · 本方发信 · ')),
    ).toBe(true);
  } finally {
    await scoped(db, actor, workspace, (ctx) =>
      ctx.tx.query("UPDATE mail_messages SET direction='inbound' WHERE id=$1", [mailOld]),
    );
  }
});

it('creates a private resumable task with explicit defaults and no model call on click', async () => {
  const id = await chat();
  expect((await client.get(`/api/chats/${id}/workflow`).set(h()).expect(200)).body).toBeNull();
  const w = (
    await client.post(`/api/chats/${id}/workflow`).set(h()).send({ kind: 'summary' }).expect(201)
  ).body;
  expect(w).toMatchObject({
    kind: 'summary',
    step: 'configure',
    version: 1,
    config: { customer_id: null, project_id: null, document_id: null },
  });
  expect((await client.get(`/api/chats/${id}/workflow`).set(h()).expect(200)).body.id).toBe(w.id);
  expect(seen).toHaveLength(0);
  await reader.get(`/api/chats/${id}/workflow`).set(h()).expect(404);
});
it('directory reads only authorized basics and supports one-character fragments', async () => {
  const r = await reader.get('/api/home-workflows/directory?q=沈').set(h()).expect(200);
  expect(r.body.some((c: { id: string }) => c.id === person)).toBe(true);
  expect(JSON.stringify(r.body)).not.toContain('需要确认');
  expect(
    (await reader.get('/api/home-workflows/directory?q=乙').set(h()).expect(200)).body,
  ).toHaveLength(0);
  expect(seen).toHaveLength(0);
});
it('validates project, contact and mail ownership before configuring or loading options', async () => {
  const w = await task();
  for (const patch of [{ project_id: otherProject }, { mail_id: mailB }])
    await client
      .patch(`/api/chats/${w.chat_id}/workflow`)
      .set(h())
      .send({ version: w.version, config: { ...w.config, ...patch } })
      .expect(404);
  await reader.get(`/api/home-workflows/options?customer_id=${b}`).set(h()).expect(404);
  const o = (await client.get(`/api/home-workflows/options?customer_id=${a}`).set(h()).expect(200))
    .body;
  expect(o.projects.map((p: { id: string }) => p.id)).toEqual([project]);
  expect(o.mails.some((m: { id: string }) => m.id === mailB)).toBe(false);
});
it('rejects stale configuration versions and unknown source kinds', async () => {
  const w = await task(),
    next = await configure(w, { instruction: '只看数量' });
  await client
    .patch(`/api/chats/${w.chat_id}/workflow`)
    .set(h())
    .send({ version: w.version, config: next.config })
    .expect(409);
  await client
    .patch(`/api/chats/${w.chat_id}/workflow`)
    .set(h())
    .send({ version: next.version, config: { ...next.config, source_kinds: ['all'] } })
    .expect(400);
});
it('classifies first without business text, then strictly filters customer, Beijing day, source, person and project', async () => {
  const w = await configure(await task(), { project_id: project, person_id: person });
  const result = await run(w).expect(200);
  expect(seen.map((i) => i.phase)).toEqual(['classify', 'answer']);
  expect(seen[0].snapshot.sources).toHaveLength(0);
  const text = JSON.stringify(seen[1].snapshot.sources);
  expect(text).toContain('甲当前来信');
  expect(text).not.toContain('甲旧来信');
  expect(text).not.toContain('乙客户');
  expect(text).not.toContain('甲微信');
  expect(result.body.workflow.result.body).toBe('已根据所选原文整理。');
  expect(result.body.detail.messages).toHaveLength(2);
});
it('persists completed output and replays the same request without another model call', async () => {
  const w = await task(),
    request_id = randomUUID();
  const first = (await run(w, '总结沟通', { request_id }).expect(200)).body;
  const second = (await run(w, '总结沟通', { request_id }).expect(200)).body;
  expect(second.workflow.id).toBe(first.workflow.id);
  expect(second.detail.messages).toHaveLength(2);
  expect(seen).toHaveLength(2);
  const resumed = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(resumed.result.message_id).toBe(first.workflow.result.message_id);
  await run(w, '另一阶段', { request_id, phase: 'draft' }).expect(409);
});
it('cancellation and changed configuration stop old model output from being persisted', async () => {
  const w = await task();
  hook = async () => {
    await client
      .post(`/api/chats/${w.chat_id}/workflow/cancel`)
      .set(h())
      .send({ version: w.version })
      .expect(200);
  };
  await run(w).expect(409);
  expect(
    (await client.get(`/api/chats/${w.chat_id}`).set(h()).expect(200)).body.messages,
  ).toHaveLength(0);
  const cancelled = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200))
    .body;
  await run(cancelled).expect(409);
  const other = await task();
  hook = async () => {
    await configure(other, { date_start: '2026-10-25' });
  };
  await run(other).expect(409);
});
it('streams only the visible body and finishes with the normal workflow/detail result', async () => {
  const w = await task();
  const response = await client
    .post(`/api/chats/${w.chat_id}/workflow/run`)
    .set(h())
    .set('accept', 'text/event-stream')
    .send({ version: w.version, request_id: randomUUID(), body: '总结沟通' })
    .expect(200);
  const frames = response.text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  expect(frames.some((frame) => frame.type === 'thinking')).toBe(true);
  expect(frames.find((frame) => frame.type === 'answer')).toEqual({
    type: 'answer',
    text: '已根据所选原文整理。',
  });
  expect(frames.find((frame) => frame.type === 'done').result.workflow.kind).toBe('summary');
});
it('never carries old workflow history after the selected range changes', async () => {
  const w = (await run(await task()).expect(200)).body.workflow as HomeWorkflow;
  const same = (await run(w, '继续解释').expect(200)).body.workflow as HomeWorkflow;
  expect(seen.at(-1)?.history).toHaveLength(2);
  const next = await configure(same, { date_start: '2026-10-25' });
  await run(next).expect(200);
  expect(seen.at(-1)?.history).toHaveLength(0);
});
it('switching topic or naming another customer does not read old business sources', async () => {
  const w = await task();
  classifyIntent = '一般对话';
  answerFactory = () => pack({ body: '可以，当前流程暂停。' });
  await run(w, '介绍一下产品').expect(200);
  expect(seen.at(-1)?.snapshot.sources.filter((s) => s.id !== 'user:instruction')).toHaveLength(0);
  classifyIntent = '分析建议';
  target = '乙公司';
  await run(
    (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h())).body,
    '查看乙公司',
  ).expect(200);
  expect(seen.at(-1)?.snapshot.sources.filter((s) => s.id !== 'user:instruction')).toHaveLength(0);
});
it('rejects malformed output, unknown fields and fabricated citations without saving changes', async () => {
  const w = await task('update');
  answerFactory = () =>
    pack({
      changes: [
        {
          key: 'unknown_business',
          value: 'x',
          reason: 'x',
          source_ids: ['user:instruction'],
          quote: '修改',
        },
      ],
    });
  await run(w, '修改').expect(502);
  answerFactory = () =>
    pack({
      changes: [
        {
          key: 'email',
          value: 'new@fixture.invalid',
          reason: 'x',
          source_ids: ['invented'],
          quote: '修改',
        },
      ],
    });
  await run(w, '修改').expect(502);
  expect(
    (await client.get(`/api/chats/${w.chat_id}`).set(h()).expect(200)).body.messages,
  ).toHaveLength(0);
});
it('only applies explicitly selected, grounded field changes once and checks current edit access', async () => {
  const w = await task('update'),
    quote = '邮箱改为 new@fixture.invalid';
  answerFactory = () => fieldProposal('new@fixture.invalid', quote);
  const next = (await run(w, quote).expect(200)).body.workflow as HomeWorkflow;
  expect((await client.get(`/api/customers/${a}`).set(h()).expect(200)).body.email).not.toBe(
    'new@fixture.invalid',
  );
  const applied = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/apply`)
      .set(h())
      .send({ version: next.version, keys: ['email'] })
      .expect(200)
  ).body;
  expect(applied.step).toBe('completed');
  const c = (await client.get(`/api/customers/${a}`).set(h()).expect(200)).body;
  expect(c.email).toBe('new@fixture.invalid');
  await client
    .post(`/api/chats/${w.chat_id}/workflow/apply`)
    .set(h())
    .send({ version: next.version, keys: ['email'] })
    .expect(200);
  expect((await client.get(`/api/customers/${a}`).set(h())).body.version).toBe(c.version);
  const id = (
    await reader
      .post('/api/chats')
      .set(h())
      .send({ id: randomUUID(), title: '只读资料', customer_id: a })
      .expect(201)
  ).body.id;
  const rw = (
    await reader.post(`/api/chats/${id}/workflow`).set(h()).send({ kind: 'update' }).expect(201)
  ).body;
  await reader
    .post(`/api/chats/${id}/workflow/fill`)
    .set(h())
    .send({ version: rw.version, field_ids: ['attr:' + randomUUID()] })
    .expect(403);
});
it('stale business values invalidate old suggestions before apply and after refresh', async () => {
  const w = await task('update'),
    quote = '邮箱改为 next@fixture.invalid';
  answerFactory = () => fieldProposal('next@fixture.invalid', quote);
  const next = (await run(w, quote).expect(200)).body.workflow as HomeWorkflow;
  const c = (await client.get(`/api/customers/${a}`).set(h())).body;
  await client
    .patch(`/api/customers/${a}`)
    .set(h())
    .send({ version: c.version, region: '杭州' })
    .expect(200);
  await client
    .post(`/api/chats/${w.chat_id}/workflow/apply`)
    .set(h())
    .send({ version: next.version, keys: ['email'] })
    .expect(409);
  const resumed = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(resumed.result).toBeNull();
  expect(resumed.notice).toContain('变化');
});
it('rejects fill for nonempty numeric zero and preserves the existing value', async () => {
  const f = (
    await client
      .post('/api/attributes')
      .set(h())
      .send({ name: '已填数字', kind: 'number', ai_enabled: true, guidance: '根据资料填写' })
      .expect(201)
  ).body;
  await client
    .patch(`/api/customers/${a}/attribute-values/${f.id}`)
    .set(h())
    .send({ value: 0, version: 0, attribute_version: f.version })
    .expect(200);
  const w = await task('update');
  await client
    .post(`/api/chats/${w.chat_id}/workflow/fill`)
    .set(h())
    .send({ version: w.version, field_ids: [`attr:${f.id}`] })
    .expect(409);
  expect(seen).toHaveLength(0);
});
it('creates one saved reply draft, with no confirmation, scheduling or send side effect', async () => {
  const w = await configure(await task('reply'), {
    mail_id: mailA,
    date_start: null,
    date_end: null,
  });
  answerFactory = () =>
    pack({
      body: '回复正文已准备。',
      draft_body: '您好，感谢补充尺码信息。报价和交期仍待内部确认。',
    });
  const next = (await run(w, '请生成邮件正文', { phase: 'draft' }).expect(200)).body
    .workflow as HomeWorkflow;
  const first = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  const second = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  expect(first.draft.id).toBe(second.draft.id);
  expect(first.draft).toMatchObject({
    status: 'draft',
    approved_version: null,
    scheduled_at: null,
    reply_to_message_id: mailA,
  });
});
it('requires explicit source ownership for a document and keeps unassociated documents private', async () => {
  const document = randomUUID();
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query(
      `INSERT INTO documents(workspace_id,id,uploaded_by,task_actor_id,request_id,name,format,size,content_hash,original_base64,status,sections)VALUES($1,$2,$3,$3,$4,'客户介绍.docx','docx',10,$5,'Zml4dHVyZQ==','pending_association',$6::jsonb)`,
      [
        workspace,
        document,
        actor,
        randomUUID(),
        'a'.repeat(64),
        JSON.stringify([{ label: '第1段', text: '这是本人尚未关联的文档原文。' }]),
      ],
    ),
  );
  const id = await chat(),
    w = (await client.post(`/api/chats/${id}/workflow`).set(h()).send({ kind: 'summary' })).body;
  const selected = await configure(w, { document_id: document, source_kinds: ['pasted'] });
  await run(selected).expect(200);
  expect(JSON.stringify(seen.at(-1)?.snapshot.sources)).toContain('尚未关联的文档');
  expect(JSON.stringify(seen.at(-1)?.snapshot.sources)).not.toContain('甲当前');
  const version = (await client.get(`/api/chats/${id}/workflow`).set(h())).body.version;
  await client
    .patch(`/api/chats/${id}/workflow`)
    .set(h())
    .send({
      version,
      config: { ...selected.config, customer_id: a },
    })
    .expect(409);
});

it('invalidates a confirmed schedule before changing task scope or generating a replacement', async () => {
  const w = await configure(await task('reply'), {
    mail_id: mailA,
    date_start: null,
    date_end: null,
  });
  answerFactory = () => pack({ body: '草稿已准备', draft_body: '您好，请先确认尺码。' });
  const next = (await run(w, '起草回复', { phase: 'draft' }).expect(200)).body.workflow;
  const prepared = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/reply-draft`)
      .set(h())
      .send({ version: next.version })
      .expect(200)
  ).body;
  const approved = (
    await client
      .post(`/api/outgoing/${prepared.draft.id}/approve`)
      .set(h())
      .send({ version: prepared.draft.version })
      .expect(200)
  ).body;
  await client
    .post(`/api/outgoing/${prepared.draft.id}/schedule`)
    .set(h())
    .send({
      version: approved.version,
      mode: 'later',
      at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'Asia/Shanghai',
    })
    .expect(200);
  await configure(prepared.workflow, { instruction: '改为只确认收到' });
  const old = (await client.get(`/api/outgoing/${prepared.draft.id}`).set(h()).expect(200)).body;
  expect(old).toMatchObject({ status: 'cancelled', scheduled_at: null, approved_version: null });
});

it('keeps company-wide AI fill out of person, project and selected-mail scopes', async () => {
  const f = (
    await client
      .post('/api/attributes')
      .set(h())
      .send({ name: '待补描述', kind: 'text', ai_enabled: true, guidance: '总结公司资料' })
      .expect(201)
  ).body;
  for (const scope of [{ project_id: project }, { mail_id: mailA }]) {
    const w = await configure(await task('update'), scope);
    await client
      .post(`/api/chats/${w.chat_id}/workflow/fill`)
      .set(h())
      .send({ version: w.version, field_ids: [`attr:${f.id}`] })
      .expect(400);
  }
  expect(seen).toHaveLength(0);
});

it('reports and persists AI fill failure without calling it missing information', async () => {
  const f = (
    await client
      .post('/api/attributes')
      .set(h())
      .send({ name: '模型失败检查', kind: 'text', ai_enabled: true, guidance: '根据公司资料填写' })
      .expect(201)
  ).body;
  const w = await task('update');
  const result = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/fill`)
      .set(h())
      .send({ version: w.version, field_ids: [`attr:${f.id}`] })
      .expect(200)
  ).body;
  expect(result.results[0].status).toBe('failed');
  expect(result.results[0].error).toBeTruthy();
  expect(result.workflow.step).toBe('ready');
  const resumed = (await client.get(`/api/chats/${w.chat_id}/workflow`).set(h()).expect(200)).body;
  expect(resumed.result.fill_results[0].status).toBe('failed');
});

it('explicit cancellation in chat stops the task without reading its business text', async () => {
  const w = await task();
  classifyIntent = '一般对话';
  answerFactory = () => pack({ body: '已取消当前任务。' });
  const result = (await run(w, '取消任务').expect(200)).body;
  expect(result.workflow.step).toBe('cancelled');
  expect(seen.at(-1)?.entry_context).toMatchObject({ result: 'answer', policy: 'answer_only' });
  expect(seen.at(-1)?.entry_context?.provided).not.toContain('customer_id');
  expect(seen.at(-1)?.snapshot.sources.filter((s) => s.id !== 'user:instruction')).toHaveLength(0);
});

it('accepts a real user-input citation without pretending it is a CRM Record', async () => {
  const w = await task('update'),
    quote = '邮箱改为 cited@fixture.invalid';
  outerSources = ['user:instruction'];
  answerFactory = () => fieldProposal('cited@fixture.invalid', quote);
  const result = (await run(w, quote).expect(200)).body;
  expect(result.workflow.result.changes[0].value).toBe('cited@fixture.invalid');
  expect(
    result.workflow.result.sources.every((s: { kind: string }) =>
      ['record', 'entity', 'mail'].includes(s.kind),
    ),
  ).toBe(true);
  expect(seen.at(-1)?.snapshot.sources.some((s) => s.id === 'user:instruction' && !s.ref)).toBe(
    true,
  );
});

it.each(['不用了', '算了', '取消吧', '停止处理', '先不处理了，谢谢'])(
  'persists an explicit stop phrase as cancelled: %s',
  async (body) => {
    const w = await task();
    classifyIntent = '一般对话';
    answerFactory = () => pack({ body: '已停止本任务。' });
    const result = (await run(w, body).expect(200)).body;
    expect(result.workflow.step).toBe('cancelled');
    expect(seen.at(-1)?.snapshot.sources.filter((s) => s.id !== 'user:instruction')).toHaveLength(
      0,
    );
  },
);

it('honors an explicit original stop phrase even when the classifier mislabels the intent', async () => {
  const w = await task('reply');
  classifyIntent = '起草内容';
  answerFactory = () => pack({ body: '已取消当前任务。' });
  const result = (await run(w, '不用了').expect(200)).body;
  expect(result.workflow.step).toBe('cancelled');
  expect(seen.map((i) => i.phase)).toEqual(['classify', 'answer']);
  expect(seen.at(-1)?.snapshot.sources.filter((s) => s.id !== 'user:instruction')).toHaveLength(0);
});

it('finishes one selected update batch and leaves unselected changes untouched', async () => {
  const w = await task('update'),
    quote = '邮箱改为 selected@fixture.invalid，地区改为苏州';
  answerFactory = () =>
    pack({
      changes: [
        {
          key: 'email',
          value: 'selected@fixture.invalid',
          reason: '明确修改',
          source_ids: ['user:instruction'],
          quote,
        },
        {
          key: 'region',
          value: '苏州',
          reason: '明确修改',
          source_ids: ['user:instruction'],
          quote,
        },
      ],
    });
  const next = (await run(w, quote).expect(200)).body.workflow;
  const saved = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/apply`)
      .set(h())
      .send({ version: next.version, keys: ['email'] })
      .expect(200)
  ).body;
  await client
    .post(`/api/chats/${w.chat_id}/workflow/apply`)
    .set(h())
    .send({ version: saved.version, keys: ['region'] })
    .expect(409);
  const current = (await client.get(`/api/customers/${a}`).set(h())).body;
  expect(current.region).not.toBe('苏州');
  expect(saved.result.applied_keys).toEqual(['email']);
});

it('company update retains person source filters but never silently creates a primary person', async () => {
  const w = await task('update');
  await client
    .patch(`/api/chats/${w.chat_id}/workflow`)
    .set(h())
    .send({ version: w.version, config: { ...w.config, person_id: person } })
    .expect(200);
  const current = (await client.get(`/api/customers/${b}`).set(h())).body;
  const other = await configure(await task('update'), { customer_id: b });
  const quote = '主要联系人名称改为 新名称';
  answerFactory = () =>
    pack({
      changes: [
        {
          key: 'contact_name',
          value: '新名称',
          reason: '本人指定',
          source_ids: ['user:instruction'],
          quote,
        },
      ],
    });
  const next = (await run(other, quote).expect(200)).body.workflow;
  const before = (await client.get(`/api/people?customer_id=${b}`).set(h())).body.total;
  await client
    .post(`/api/chats/${other.chat_id}/workflow/apply`)
    .set(h())
    .send({ version: next.version, keys: ['contact_name'] })
    .expect(200);
  expect((await client.get(`/api/people?customer_id=${b}`).set(h())).body.total).toBe(before);
  expect((await client.get(`/api/customers/${b}`).set(h())).body.contact_name).toBe('新名称');
  expect(current.contact_name).not.toBe('新名称');
});

it('filters mixed legacy WeChat evidence by actual person and message date', async () => {
  const second = (
    await client.post('/api/people').set(h()).send({ customer_id: a, name: '周老师' }).expect(201)
  ).body.id;
  const record = randomUUID();
  await scoped(db, actor, workspace, async (ctx) => {
    await ctx.tx.query(
      "INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,occurred_at)VALUES($1,$2,$3,$4,'customer_quote','允许甲；禁止乙；过期甲',$5,'wechat','2026-10-26T02:00:00Z')",
      [workspace, a, project, record, actor],
    );
    for (const [who, date, body] of [
      [person, '2026-10-26T02:00:00Z', '允许的本日甲消息'],
      [second, '2026-10-26T03:00:00Z', '禁止的同公司乙消息'],
      [person, '2026-10-25T02:00:00Z', '不在日期范围的甲消息'],
    ] as const)
      await ctx.tx.query(
        "INSERT INTO knowledge_wechat_evidence(workspace_id,customer_id,id,source_key,record_id,project_id,person_id,occurred_at,speaker,body,created_by)VALUES($1,$2,$3,$3::uuid::text,$4,$5,$6,$7,'客户',$8,$9)",
        [workspace, a, randomUUID(), record, project, who, date, body, actor],
      );
  });
  const w = await configure(await task(), {
    person_id: person,
    project_id: project,
    source_kinds: ['wechat'],
  });
  await run(w).expect(200);
  const body = JSON.stringify(seen.at(-1)?.snapshot.sources);
  expect(body).toContain('允许的本日甲消息');
  expect(body).not.toContain('禁止的同公司乙消息');
  expect(body).not.toContain('不在日期范围的甲消息');
});

it('preserves person source scope while blocking a request to edit the person as company fields', async () => {
  const w = await configure(await task('update'), { person_id: person });
  answerFactory = () => pack({ body: '本任务更新公司资料；请从联系人档案编辑沈老师。' });
  await run(w, '把沈老师的邮箱修改为 person-new@fixture.invalid').expect(200);
  const input = seen.at(-1)!;
  expect(input.snapshot.sources.some((s) => s.ref)).toBe(false);
  expect(JSON.stringify(input.snapshot.sources)).not.toContain('甲当前来信');
  expect(input.snapshot.warnings.join('')).toContain('通过联系人档案编辑');
  expect((await client.get(`/api/customers/${a}`).set(h())).body.email).not.toBe(
    'person-new@fixture.invalid',
  );
});

it('workflow WeChat uses the explicit batch customer and project without fixing the chat or future project', async () => {
  const w = await configure(await task(), {
    person_id: person,
    project_id: project,
    source_kinds: ['wechat'],
  });
  const query = {
    version: w.version,
    request_id: randomUUID(),
    identity: '微信合成',
    start: '2026-10-26',
    end: '2026-10-26',
  };
  const response = (
    await client.post(`/api/chats/${w.chat_id}/workflow/wechat`).set(h()).send(query).expect(200)
  ).body;
  expect(response.preview).toMatchObject({
    state: 'associated',
    customer_id: a,
    person_id: person,
    project_id: project,
  });
  expect(wechatReads).toBe(1);
  expect((await client.get(`/api/chats/${w.chat_id}`).set(h())).body.chat.customer_id).toBe(null);
  await client.post(`/api/chats/${w.chat_id}/workflow/wechat`).set(h()).send(query).expect(200);
  expect(wechatReads).toBe(1);
  const next = (
    await client
      .post('/api/wechat/queries')
      .set(h())
      .send({
        request_id: randomUUID(),
        identity: '微信合成',
        start: '2026-10-27',
        end: '2026-10-27',
      })
      .expect(200)
  ).body.preview;
  expect(next).toMatchObject({
    state: 'associated',
    customer_id: a,
    person_id: person,
    project_id: null,
  });
});

it('workflow WeChat refuses stale, cancelled and conflicting source scopes before history reads', async () => {
  const w = await configure(await task(), {
    person_id: person,
    project_id: project,
    source_kinds: ['wechat'],
  });
  const query = {
    version: w.version,
    request_id: randomUUID(),
    identity: '微信合成',
    start: '2026-10-26',
    end: '2026-10-26',
  };
  await client
    .post(`/api/chats/${w.chat_id}/workflow/wechat`)
    .set(h())
    .send({ ...query, version: w.version - 1 })
    .expect(409);
  expect(wechatReads).toBe(0);
  await client.post(`/api/chats/${w.chat_id}/workflow/wechat`).set(h()).send(query).expect(200);
  const other = await configure(await task(), { customer_id: b, project_id: null });
  await client
    .post(`/api/chats/${other.chat_id}/workflow/wechat`)
    .set(h())
    .send({ ...query, request_id: randomUUID(), version: other.version })
    .expect(409);
  expect(wechatReads).toBe(1);
  const cancelled = (
    await client
      .post(`/api/chats/${w.chat_id}/workflow/cancel`)
      .set(h())
      .send({ version: w.version })
      .expect(200)
  ).body;
  await client
    .post(`/api/chats/${w.chat_id}/workflow/wechat`)
    .set(h())
    .send({ ...query, request_id: randomUUID(), version: cancelled.version })
    .expect(409);
  expect(wechatReads).toBe(1);
});

it('searches older inbound mails by subject or sender before limiting, with actual totals and project scope', async () => {
  const company = (
    await client
      .post('/api/customers')
      .set(h())
      .send({
        name: '邮件检索测试公司',
        type: 'group',
        source: 'email',
      })
      .expect(201)
  ).body.id;
  const scopedProject = (
    await client
      .post(`/api/customers/${company}/projects`)
      .set(h())
      .send({
        name: '邮件检索项目',
        type: 'custom',
      })
      .expect(201)
  ).body.id;
  const old = randomUUID();
  await scoped(db, actor, workspace, async (ctx) => {
    for (let index = 0; index < 55; index++) {
      const id = index === 0 ? old : randomUUID();
      await ctx.tx.query(
        `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
         VALUES($1,$2,$3,'sender@163.com',$4,$5,$2::uuid::text,$6,$7::jsonb,'[]','[]','[]',$8,'inbound','BODY_SHOULD_NOT_LEAVE_OPTIONS','fixture')`,
        [
          workspace,
          id,
          account,
          company,
          index === 0 ? scopedProject : null,
          index === 0 ? '早期尺码清单归档' : `普通咨询${index}`,
          JSON.stringify([
            {
              name: index === 0 ? '旧来信联系人' : '普通联系人',
              address: index === 0 ? 'Old-Search@fixture.invalid' : 'normal@fixture.invalid',
            },
          ]),
          index === 0 ? '2026-09-01T00:00:00Z' : '2026-10-26T00:00:00Z',
        ],
      );
    }
  });
  const endpoint = `/api/home-workflows/options?customer_id=${company}`;
  const initial = (await client.get(endpoint).set(h()).expect(200)).body;
  expect(initial.mails).toHaveLength(50);
  expect(initial.mails_total).toBe(55);
  expect(initial.mails.some((m: { id: string }) => m.id === old)).toBe(false);
  for (const query of ['早期尺码', 'OLD-SEARCH@FIXTURE.INVALID', '旧来信联系人']) {
    const found = (
      await client
        .get(`${endpoint}&mail_query=${encodeURIComponent(query)}`)
        .set(h())
        .expect(200)
    ).body;
    expect(found.mails.map((m: { id: string }) => m.id)).toEqual([old]);
    expect(found.mails_total).toBe(1);
    expect(JSON.stringify(found)).not.toContain('BODY_SHOULD_NOT_LEAVE_OPTIONS');
  }
  const onlyProject = (
    await client.get(`${endpoint}&project_id=${scopedProject}`).set(h()).expect(200)
  ).body;
  expect(onlyProject.mails_total).toBe(1);
  expect(onlyProject.mails[0].id).toBe(old);
  await client.get(`${endpoint}&project_id=${otherProject}`).set(h()).expect(404);
  await client
    .get(`${endpoint}&mail_query=${'x'.repeat(201)}`)
    .set(h())
    .expect(400);
  const none = (await client.get(`${endpoint}&mail_query=不存在的主题`).set(h()).expect(200)).body;
  expect(none.mails).toEqual([]);
  expect(none.mails_total).toBe(0);
});
