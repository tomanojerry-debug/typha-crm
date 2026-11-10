import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createEvaluationEnvironment,
  type EvaluationActor,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';
import type { AgentModelInput } from '../server/agent-model.js';
import type { HomeWorkflow, WorkflowConfig } from '../shared/home-workflows.js';
import { mailVariableText, type MailVariableDocument } from '../shared/mail-variables.js';
import { ApiError, scoped } from '../server/security.js';

// Actual product APIs and disposable fictional data, with deterministic models.
// These regressions are engineering evidence, not MiniMax quality trials.
let env: EvaluationEnvironment;
let cancelMode = false;
let failExplanation = false;
let beforeAnswer: (() => Promise<void>) | undefined;
const seen: AgentModelInput[] = [];
const privatePersonDescription = 'PRIVATE_PERSON_BUSINESS_DESCRIPTION_NOT_A_DIRECTORY_FIELD';
const privateProjectDescription = 'PRIVATE_PROJECT_BUSINESS_DESCRIPTION_NOT_A_DIRECTORY_FIELD';

beforeAll(async () => {
  env = await createEvaluationEnvironment({
    agent: {
      transport: {
        async generate(input) {
          seen.push(structuredClone(input));
          if (input.phase === 'classify')
            return {
              intent: cancelMode ? '一般对话' : '起草内容',
              action: 'respond',
              entity_type: 'unknown',
              target: null,
              match_mode: null,
              candidate_index: null,
              data_source: 'records',
              missing: [],
              reply: cancelMode ? '停止本次任务。' : '继续已绑定对象的当前任务。',
              mail_action: null,
              turn_action: cancelMode ? 'cancel' : 'continue',
              ...(cancelMode ? { turn_evidence: '取消这次写信' } : {}),
              slot_updates: [],
            };
          if (beforeAnswer) {
            const hook = beforeAnswer;
            beforeAnswer = undefined;
            await hook();
          }
          if (cancelMode && failExplanation)
            throw new ApiError(503, 'Synthetic explanation service unavailable');
          const template = input.snapshot.sources.find((source) =>
            source.id.startsWith('mail-template:'),
          );
          const primary = input.snapshot.sources.find(
            (source) => source.ref?.kind === 'record' && source.title.startsWith('本次来信 · '),
          );
          const masked = template ? JSON.parse(template.body) : null;
          return {
            answer: JSON.stringify({
              body: cancelMode
                ? '已停止本任务的后续步骤；实际发送结果以发件记录为准。'
                : '已准备可编辑的虚构草稿，尚未发送。',
              decisions: [],
              draft_subject: cancelMode ? undefined : masked?.subject || '虚构邮件草稿',
              draft_body: cancelMode
                ? null
                : masked?.body || '林老师您好：这是一封虚构测试草稿，具体交期待确认。',
              changes: [],
              issues: [],
              mail_decisions: [],
              coverage: [],
              ...(primary
                ? {
                    issues: [
                      {
                        id: 'primary',
                        question: '来信内容已纳入核对',
                        source_ids: [primary.id],
                        quote: primary.body,
                        status: 'answerable',
                        response: '按来信内容核对。',
                      },
                    ],
                    coverage: [{ issue_id: 'primary', status: 'pending', draft_quote: null }],
                  }
                : {}),
            }),
            source_ids: [...(template ? [template.id] : []), ...(primary ? [primary.id] : [])],
          };
        },
      },
    },
  });
  await scoped(env.db, env.ids.boss, env.ids.workspace, async (ctx) => {
    await ctx.tx.query('UPDATE people SET description=$1 WHERE id=$2', [
      privatePersonDescription,
      env.ids.export_person,
    ]);
    await ctx.tx.query('UPDATE projects SET description=$1 WHERE id=$2', [
      privateProjectDescription,
      env.ids.export_project,
    ]);
  });
}, 30000);
afterAll(() => env?.cleanup());
beforeEach(() => {
  cancelMode = false;
  failExplanation = false;
  beforeAnswer = undefined;
  seen.length = 0;
});

async function compose(
  changes: Partial<WorkflowConfig> = {},
  actor: EvaluationActor = env.actors.boss,
  kind: 'compose' | 'reply' = 'compose',
) {
  const chat = await actor.request('POST', '/api/chats', {
    id: randomUUID(),
    title: '评测发现修复的独立工程回归',
    customer_id: null,
  });
  expect(chat.status).toBe(201);
  const initial = await actor.request('POST', `/api/chats/${chat.body.id}/workflow`, {
    kind,
  });
  expect(initial.status).toBe(201);
  const configured = await actor.request('PATCH', `/api/chats/${chat.body.id}/workflow`, {
    version: initial.body.version,
    config: {
      ...initial.body.config,
      customer_id: env.ids.export_customer,
      person_id: env.ids.export_person,
      project_id: env.ids.export_project,
      instruction: '准备一封虚构邮件，不作价格或交期承诺。',
      history_scope: null,
      ...changes,
    },
  });
  expect(configured.status).toBe(200);
  const selected = await actor.request('POST', `/api/chats/${chat.body.id}/workflow/template`, {
    version: configured.body.version,
    choice: { kind: 'none' },
  });
  expect(selected.status).toBe(200);
  return selected.body as HomeWorkflow;
}
function generate(w: HomeWorkflow, actor: EvaluationActor = env.actors.boss) {
  return actor.request('POST', `/api/chats/${w.chat_id}/workflow/run`, {
    version: w.version,
    request_id: randomUUID(),
    body: '生成当前邮件草稿',
    phase: 'draft',
    task_action: 'draft_current',
  });
}
async function openedDraft(w: HomeWorkflow, actor: EvaluationActor = env.actors.boss) {
  const generated = await generate(w, actor);
  expect(generated.status).toBe(200);
  const opened = await actor.request('POST', `/api/chats/${w.chat_id}/workflow/reply-draft`, {
    version: generated.body.workflow.version,
  });
  expect(opened.status).toBe(200);
  return opened.body as { workflow: HomeWorkflow; draft: { id: string; status: string } };
}
const stored = async (chatId: string) =>
  (
    await env.db.query<{
      step: string;
      result: unknown;
      result_digest: string | null;
      draft_id: string | null;
      config_generation: string;
      version: number;
    }>(
      'SELECT step,result,result_digest,draft_id,config_generation,version FROM home_workflows WHERE chat_id=$1',
      [chatId],
    )
  ).rows[0];

it('projects only authorized bound directory fields, separately from history and business evidence', async () => {
  const w = await compose();
  expect((await generate(w)).status).toBe(200);
  const input = seen.find((item) => item.phase === 'answer')!;
  expect(input.snapshot.mail_directory).toMatchObject({
    source_nature: 'authorized_basic_directory',
    current_company: { id: env.ids.export_customer, name: '虚构海风舞蹈' },
    recipient: {
      kind: 'person',
      id: env.ids.export_person,
      name: '林老师',
      email: 'lin.export@eval.invalid',
      job_title: '采购',
      company_id: env.ids.export_customer,
    },
    recipient_company: { id: env.ids.export_customer, name: '虚构海风舞蹈' },
    project: {
      id: env.ids.export_project,
      name: '虚构秋季样衣',
      type: 'sample',
      stage: 'waiting_customer',
    },
  });
  expect(input.snapshot.mail_directory!.current_company).not.toBe(
    input.snapshot.mail_directory!.recipient_company,
  );
  expect(input.snapshot.sources.some((source) => source.ref)).toBe(false);
  expect(input.snapshot.sources.some((source) => /directory/i.test(source.id))).toBe(false);
  const serialized = JSON.stringify(input);
  expect(serialized).not.toContain(privatePersonDescription);
  expect(serialized).not.toContain(privateProjectDescription);
  for (const record of env.fixture.records) expect(serialized).not.toContain(record.body);
  expect(serialized).not.toContain('lin.domestic@eval.invalid');
  expect(input.snapshot.warnings.join('\n')).toMatch(/目录.*不是|目录.*不.*业务证据/);
});

it('preserves empty directory values and a null project without inventing a contact or sender company', async () => {
  const w = await compose({ person_id: null, project_id: null });
  expect((await generate(w)).status).toBe(200);
  const directory = seen.find((item) => item.phase === 'answer')!.snapshot.mail_directory!;
  expect(directory).toMatchObject({
    current_company: { email: '', phone: '', contact_name: '' },
    recipient: {
      kind: 'company',
      id: env.ids.export_customer,
      name: '虚构海风舞蹈',
      email: '',
      phone: '',
    },
    project: null,
  });
  expect(JSON.stringify(directory)).not.toContain('lin.export@eval.invalid');
  expect(directory).not.toHaveProperty('sender_company');
});

it('rejects a foreign customer contact or project before model execution', async () => {
  const w = await compose();
  const count = seen.length;
  for (const changes of [
    { person_id: env.ids.domestic_person },
    { project_id: env.ids.domestic_project },
  ]) {
    const response = await env.actors.boss.request('PATCH', `/api/chats/${w.chat_id}/workflow`, {
      version: w.version,
      config: { ...w.config, ...changes },
    });
    expect(response.status).toBe(404);
  }
  expect(seen).toHaveLength(count);
});

it('keeps a reply source-filter contact separate from the actual envelope recipient', async () => {
  const selectedContact = env.ids.same_name_person;
  await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
    ctx.tx.query(
      'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
      [env.ids.workspace, env.ids.export_customer, env.ids.mail_latest, selectedContact],
    ),
  );
  const w = await compose(
    { person_id: selectedContact, mail_id: env.ids.mail_latest },
    env.actors.boss,
    'reply',
  );
  const generated = await generate(w);
  expect(generated.status).toBe(200);
  const directory = seen.find((item) => item.phase === 'answer')!.snapshot.mail_directory!;
  expect(directory).toMatchObject({
    recipient_basis: 'reply_envelope_not_resolved',
    selected_contact: { id: selectedContact, email: 'lin.second@eval.invalid' },
    recipient: null,
    recipient_company: null,
  });
  const opened = await env.actors.boss.request(
    'POST',
    `/api/chats/${w.chat_id}/workflow/reply-draft`,
    { version: generated.body.workflow.version },
  );
  expect(opened.status).toBe(200);
  expect(opened.body.plan.content.to).toEqual(['lin.export@eval.invalid']);
  expect(opened.body.draft.to).toEqual(['lin.export@eval.invalid']);
  expect(opened.body.draft.to).not.toContain('lin.second@eval.invalid');
});

it('keeps stable template variable identities and protected markers when directory context is added', async () => {
  const document: MailVariableDocument = {
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
      },
      { type: 'text', text: '您好，感谢来信。' },
      {
        type: 'variable',
        id: randomUUID(),
        root: 'recipient_company',
        field: 'customers:name',
        label: '收件人所属公司 › 公司名称',
      },
    ],
  };
  const saved = await env.actors.boss.request(
    'POST',
    `/api/customers/${env.ids.export_customer}/mail-templates`,
    {
      name: '目录投影不能替换稳定变量（虚构）',
      subject: mailVariableText(document.subject),
      body: mailVariableText(document.body),
      variable_document: document,
    },
  );
  expect(saved.status).toBe(201);
  const base = await compose();
  const selected = await env.actors.boss.request(
    'POST',
    `/api/chats/${base.chat_id}/workflow/template`,
    { version: base.version, choice: { kind: 'saved', id: saved.body.id } },
  );
  expect(selected.status).toBe(200);
  const result = await generate(selected.body);
  expect(result.status).toBe(200);
  const input = seen.find((item) => item.phase === 'answer')!;
  expect(input.snapshot.mail_directory?.recipient?.name).toBe('林老师');
  const masked = JSON.parse(
    input.snapshot.sources.find((source) => source.id.startsWith('mail-template:'))!.body,
  );
  expect(masked.subject.match(/\[\[CRM_SLOT:[^\]]+\]\]/g)).toHaveLength(1);
  expect(masked.body.match(/\[\[CRM_SLOT:[^\]]+\]\]/g)).toHaveLength(2);
  expect(result.body.workflow.result.variable_document).toEqual(document);
});

it('commits cancellation and clears the actual stored result even when explanation fails with 503', async () => {
  const opened = await openedDraft(await compose());
  const before = await stored(opened.workflow.chat_id);
  expect(before.result).not.toBeNull();
  cancelMode = true;
  failExplanation = true;
  const cancelled = await env.actors.boss.request(
    'POST',
    `/api/chats/${opened.workflow.chat_id}/workflow/run`,
    {
      version: opened.workflow.version,
      request_id: randomUUID(),
      body: '取消这次写信',
      phase: 'analyze',
    },
  );
  expect(cancelled.status).toBe(503);
  const stopped = await stored(opened.workflow.chat_id);
  expect(stopped).toMatchObject({
    step: 'cancelled',
    result: null,
    result_digest: null,
    draft_id: null,
  });
  expect(stopped.config_generation).not.toBe(before.config_generation);
  const restored = await env.actors.boss.request(
    'GET',
    `/api/chats/${opened.workflow.chat_id}/workflow`,
  );
  expect(restored.body).toMatchObject({ step: 'cancelled', result: null, draft_id: null });
  expect(JSON.stringify(restored.body)).not.toContain('这是一封虚构测试草稿');
  const outgoing = await env.actors.boss.request('GET', `/api/outgoing/${opened.draft.id}`);
  expect(outgoing.body.status).toBe('cancelled');
  const reopen = await env.actors.boss.request(
    'POST',
    `/api/chats/${opened.workflow.chat_id}/workflow/reply-draft`,
    { version: stopped.version },
  );
  expect(reopen.status).toBe(409);
  expect(env.counters.fake_transport_submissions).toBe(0);
});

it('saves a successful cancellation explanation only to chat, without recreating a workflow result', async () => {
  const opened = await openedDraft(await compose());
  cancelMode = true;
  const response = await env.actors.boss.request(
    'POST',
    `/api/chats/${opened.workflow.chat_id}/workflow/run`,
    {
      version: opened.workflow.version,
      request_id: randomUUID(),
      body: '取消这次写信',
      phase: 'analyze',
    },
  );
  expect(response.status).toBe(200);
  expect(response.body.workflow).toMatchObject({ step: 'cancelled', result: null, draft_id: null });
  expect(await stored(opened.workflow.chat_id)).toMatchObject({
    step: 'cancelled',
    result: null,
    result_digest: null,
    draft_id: null,
  });
  expect(response.body.detail.messages.at(-1)).toMatchObject({
    role: 'assistant',
    body: '已停止本任务的后续步骤；实际发送结果以发件记录为准。',
  });
  const explanation = seen.filter((item) => item.phase === 'answer').at(-1)!;
  expect(JSON.stringify(explanation.history)).not.toContain('这是一封虚构测试草稿');
});

it('hides an old cancelled result on HTTP recovery even when its old template has disappeared', async () => {
  const opened = await openedDraft(await compose());
  const old = await stored(opened.workflow.chat_id);
  const stopped = await env.actors.boss.request(
    'POST',
    `/api/chats/${opened.workflow.chat_id}/workflow/cancel`,
    { version: opened.workflow.version },
  );
  expect(stopped.status).toBe(200);
  // Simulate a pre-fix stopped row; this never occurs in a production database.
  await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
    ctx.tx.query(
      "UPDATE home_workflows SET result=$2::jsonb,result_digest=$3,draft_id=$4,config=jsonb_set(config,'{template_choice}',$5::jsonb) WHERE chat_id=$1",
      [
        opened.workflow.chat_id,
        JSON.stringify(old.result),
        old.result_digest,
        opened.draft.id,
        JSON.stringify({ kind: 'saved', id: randomUUID() }),
      ],
    ),
  );
  const restored = await env.actors.boss.request(
    'GET',
    `/api/chats/${opened.workflow.chat_id}/workflow`,
  );
  expect(restored.status).toBe(200);
  expect(restored.body).toMatchObject({ step: 'cancelled', result: null, draft_id: null });
  expect(JSON.stringify(restored.body)).not.toContain('这是一封虚构测试草稿');
  expect(
    (
      await env.actors.boss.request(
        'POST',
        `/api/chats/${opened.workflow.chat_id}/workflow/reply-draft`,
        { version: restored.body.version },
      )
    ).status,
  ).toBe(409);
});

it('does not resurrect a cancelled task after a delayed generation returns', async () => {
  const opened = await openedDraft(await compose());
  beforeAnswer = async () => {
    const stop = await env.actors.boss.request(
      'POST',
      `/api/chats/${opened.workflow.chat_id}/workflow/cancel`,
      { version: opened.workflow.version },
    );
    expect(stop.status).toBe(200);
  };
  expect((await generate(opened.workflow)).status).toBe(409);
  const stopped = await stored(opened.workflow.chat_id);
  expect(stopped).toMatchObject({
    step: 'cancelled',
    result: null,
    result_digest: null,
    draft_id: null,
  });
});

it('rejects a stale cancel version without invalidating the current draft', async () => {
  const opened = await openedDraft(await compose());
  const before = await stored(opened.workflow.chat_id);
  const response = await env.actors.boss.request(
    'POST',
    `/api/chats/${opened.workflow.chat_id}/workflow/cancel`,
    { version: before.version - 1 },
  );
  expect(response.status).toBe(409);
  expect(await stored(opened.workflow.chat_id)).toEqual(before);
  expect(
    (await env.actors.boss.request('GET', `/api/outgoing/${opened.draft.id}`)).body.status,
  ).toBe('draft');
});

it.each(['sending', 'uncertain'] as const)(
  'stops editing without claiming an already %s outbound was withdrawn',
  async (status) => {
    const opened = await openedDraft(await compose());
    const draft = await env.actors.boss.request('GET', `/api/outgoing/${opened.draft.id}`);
    const approved = await env.actors.boss.request(
      'POST',
      `/api/outgoing/${opened.draft.id}/approve`,
      { version: draft.body.version },
    );
    expect(approved.status).toBe(200);
    const scheduled = await env.actors.boss.request(
      'POST',
      `/api/outgoing/${opened.draft.id}/schedule`,
      { version: draft.body.version, mode: 'now', timezone: 'Asia/Shanghai' },
    );
    expect(scheduled.status).toBe(200);
    await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
      ctx.tx.query('UPDATE outgoing_mail SET status=$1,started_at=now() WHERE id=$2', [
        status,
        opened.draft.id,
      ]),
    );
    const response = await env.actors.boss.request(
      'POST',
      `/api/chats/${opened.workflow.chat_id}/workflow/cancel`,
      { version: opened.workflow.version },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ step: 'cancelled', result: null });
    expect(response.body.notice).toMatch(/核对/);
    expect(response.body.notice).not.toMatch(/已撤回|邮件已取消/);
    expect(
      (await env.actors.boss.request('GET', `/api/outgoing/${opened.draft.id}`)).body.status,
    ).toBe(status);
    expect((await stored(opened.workflow.chat_id)).result_digest).toBeNull();
    expect(
      (
        await env.actors.boss.request(
          'POST',
          `/api/chats/${opened.workflow.chat_id}/workflow/reply-draft`,
          { version: response.body.version },
        )
      ).status,
    ).toBe(409);
  },
);

it('rejects a generation after the bound directory changes before commit', async () => {
  const w = await compose();
  const person = await env.actors.boss.request('GET', `/api/people/${env.ids.export_person}`);
  beforeAnswer = async () => {
    const update = await env.actors.boss.request('PATCH', `/api/people/${env.ids.export_person}`, {
      version: person.body.version,
      phone: '18000000001',
    });
    expect(update.status).toBe(200);
  };
  expect((await generate(w)).status).toBe(409);
  expect((await stored(w.chat_id)).result).toBeNull();
});

it('rechecks current customer permission after generation before saving a directory-backed result', async () => {
  const w = await compose({}, env.actors.export);
  beforeAnswer = async () => {
    expect(
      (
        await env.actors.boss.request(
          'PUT',
          `/api/customers/${env.ids.export_customer}/access/${env.ids.export}`,
          { access: null },
        )
      ).status,
    ).toBe(200);
  };
  try {
    const response = await generate(w, env.actors.export);
    expect([404, 409]).toContain(response.status);
    expect((await stored(w.chat_id)).result).toBeNull();
  } finally {
    await env.actors.boss.request(
      'PUT',
      `/api/customers/${env.ids.export_customer}/access/${env.ids.export}`,
      { access: 'editor' },
    );
  }
});
