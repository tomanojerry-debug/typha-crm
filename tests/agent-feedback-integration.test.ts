import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createEvaluationEnvironment,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';
import { callAgent, type AgentModelInput } from '../server/agent-model.js';
import type { AgentRunResult } from '../shared/agent-runs.js';
import type { HomeWorkflow } from '../shared/home-workflows.js';
import { scoped } from '../server/security.js';
import { mailVariableText, type MailVariableDocument } from '../shared/mail-variables.js';

// In-memory product APIs, native HTTP protocol fixtures and fake communications.
// A fixture HTTP503 is not an actual provider outage or a semantic quality trial.
let env: EvaluationEnvironment;
let remainingFailures = 0;
let failClassification = false;
let forgedCitation = false;
let exhaustCorrectionRetry = false;
let onFailure: (() => Promise<void>) | undefined;
const seen: AgentModelInput[] = [];
const classification = (workflow: boolean) => ({
  intent: workflow ? '起草内容' : '一般对话',
  action: 'respond',
  target: null,
  missing: [],
  reply: '处理当前已绑定任务。',
  mail_action: null,
  turn_action: 'continue',
  slot_updates: [],
});
function output(input: AgentModelInput) {
  if (input.phase === 'classify')
    return classification(input.entry_context?.entry === 'home_workflow');
  const workflow = input.entry_context?.entry === 'home_workflow';
  const template = input.snapshot.sources.find((source) => source.id.startsWith('mail-template:'));
  const masked = template ? JSON.parse(template.body) : undefined;
  return {
    answer: workflow
      ? JSON.stringify({
          body: '已准备虚构草稿供本人核对，尚未发送。',
          decisions: [],
          draft_subject: masked?.subject || '隔离反馈路由测试',
          draft_body:
            exhaustCorrectionRetry && typeof masked?.body === 'string'
              ? masked.body.replace(/\[\[CRM_SLOT:[^\]]+\]\]/g, '')
              : masked?.body || '您好，这是一封虚构草稿；交期及价格均待确认。',
          changes: [],
          issues: [],
          mail_decisions: [],
          coverage: [],
        })
      : '这是按当前授权范围完成的隔离测试回答。',
    source_ids: forgedCitation ? ['record:OUTSIDE_CURRENT_SCOPE'] : [],
  };
}
beforeAll(async () => {
  env = await createEvaluationEnvironment({
    agent: {
      transport: {
        async generate(input, runtime) {
          seen.push(input);
          return callAgent(
            input,
            'synthetic-provider-key',
            'cn',
            async () => {
              if (
                exhaustCorrectionRetry &&
                input.snapshot.warnings.some((warning) => warning.includes('唯一一次变量纠正'))
              )
                return new Response('', { status: 503 });
              if (remainingFailures > 0 && (failClassification || input.phase !== 'classify')) {
                remainingFailures--;
                const hook = onFailure;
                onFailure = undefined;
                await hook?.();
                return new Response('', { status: 503 });
              }
              return new Response(
                JSON.stringify({
                  choices: [
                    { finish_reason: 'stop', message: { content: JSON.stringify(output(input)) } },
                  ],
                  usage: { prompt_tokens: 7, completion_tokens: 3 },
                }),
              );
            },
            undefined,
            runtime,
          );
        },
      },
    },
  });
}, 60000);
afterAll(() => env?.cleanup());
beforeEach(() => {
  remainingFailures = 1;
  failClassification = false;
  forgedCitation = false;
  exhaustCorrectionRetry = false;
  onFailure = undefined;
  seen.length = 0;
});
async function chat() {
  const created = await env.actors.boss.request('POST', '/api/chats', {
    id: randomUUID(),
    title: '反馈路由独立测试',
    customer_id: null,
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}
async function begin(id: string, kind: 'message' | 'workflow', payload: Record<string, unknown>) {
  const queued = await env.actors.boss.request('POST', `/api/chats/${id}/runs`, { kind, payload });
  expect(queued.status).toBe(202);
  return queued.body.run.id as string;
}
async function terminal(id: string, run: string) {
  const end = Date.now() + 5000;
  do {
    const response = await env.actors.boss.request('GET', `/api/chats/${id}/runs/${run}`);
    expect(response.status).toBe(200);
    const result = response.body as AgentRunResult;
    if (!['queued', 'running', 'cancelling'].includes(result.run.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < end);
  throw new Error('Fictional feedback run did not terminate');
}
function recovered(result: AgentRunResult, calls: number) {
  expect(result.run).toMatchObject({
    status: 'completed',
    execution: {
      error_code: null,
      model_calls: { started: calls, failed: 1, returned: calls - 1, active: 0 },
      feedback: {
        retries_reserved: 1,
        events: [{ outcome: 'selected' }, { outcome: 'recovered' }],
      },
    },
  });
  expect(result.detail.messages).toHaveLength(2);
  expect(env.fakeSubmissions).toEqual([]);
}
async function compose(template: boolean | 'variables' = false) {
  const id = await chat();
  const created = await env.actors.boss.request('POST', `/api/chats/${id}/workflow`, {
    kind: 'compose',
  });
  expect(created.status).toBe(201);
  const configured = await env.actors.boss.request('PATCH', `/api/chats/${id}/workflow`, {
    version: created.body.version,
    config: {
      ...created.body.config,
      customer_id: env.ids.export_customer,
      person_id: env.ids.export_person,
      project_id: env.ids.export_project,
      instruction: '写一封虚构测试邮件，不作价格或交期承诺。',
      history_scope: null,
    },
  });
  expect(configured.status).toBe(200);
  let choice: { kind: 'none' } | { kind: 'saved'; id: string } = { kind: 'none' };
  if (template) {
    const variableDocument: MailVariableDocument | undefined =
      template === 'variables'
        ? {
            version: 1,
            subject: [{ type: 'text', text: '虚构变量模板主题' }],
            body: [
              {
                type: 'variable',
                id: randomUUID(),
                root: 'recipient',
                field: 'people:name',
                label: '收件人姓名',
              },
              { type: 'text', text: '您好，感谢咨询；具体交期待本人核对。' },
            ],
          }
        : undefined;
    const saved = await env.actors.boss.request(
      'POST',
      `/api/customers/${env.ids.export_customer}/mail-templates`,
      {
        name: `虚构反馈模板 ${randomUUID()}`,
        subject: variableDocument ? mailVariableText(variableDocument.subject) : '虚构模板主题',
        body: variableDocument
          ? mailVariableText(variableDocument.body)
          : '感谢您的咨询，具体需求和交期待本人核对。',
        ...(variableDocument ? { variable_document: variableDocument } : {}),
      },
    );
    expect(saved.status).toBe(201);
    choice = { kind: 'saved', id: saved.body.id };
  }
  const selected = await env.actors.boss.request('POST', `/api/chats/${id}/workflow/template`, {
    version: configured.body.version,
    choice,
  });
  expect(selected.status).toBe(200);
  return selected.body as HomeWorkflow;
}
const draftPayload = (workflow: HomeWorkflow) => ({
  version: workflow.version,
  request_id: randomUUID(),
  body: '生成当前邮件草稿',
  phase: 'draft',
  task_action: 'draft_current',
});

it('a persistent Home answer recovers after a native fixture503 and saves one pair', async () => {
  const id = await chat(),
    run = await begin(id, 'message', { request_id: randomUUID(), body: '帮我整理一个普通提纲' });
  const result = await terminal(id, run);
  recovered(result, 3);
  expect(seen.filter((input) => input.phase !== 'classify')).toHaveLength(2);
  expect(seen[1]).toBe(seen[2]);
});

it('a persistent Ask answer uses its domain guard before a second native request', async () => {
  const scope = {
    kind: 'entity',
    object: 'customers',
    customer_id: env.ids.export_customer,
    record_id: env.ids.export_customer,
  };
  const id = randomUUID();
  const queued = await env.actors.boss.request('POST', '/api/ask/runs', {
    chat_id: id,
    scope,
    request_id: randomUUID(),
    question: '概括当前资料',
  });
  expect(queued.status).toBe(202);
  recovered(await terminal(id, queued.body.run.id), 2);
});

it.each([false, true])(
  'persistent compose recovers and repeat-open writes one actual draft (template=%s)',
  async (template) => {
    const workflow = await compose(template);
    const before = await env.snapshot();
    const run = await begin(workflow.chat_id, 'workflow', draftPayload(workflow));
    const result = await terminal(workflow.chat_id, run);
    recovered(result, 3);
    const current = await env.actors.boss.request('GET', `/api/chats/${workflow.chat_id}/workflow`);
    const first = await env.actors.boss.request(
      'POST',
      `/api/chats/${workflow.chat_id}/workflow/reply-draft`,
      { version: current.body.version },
    );
    expect(first.status).toBe(200);
    const second = await env.actors.boss.request(
      'POST',
      `/api/chats/${workflow.chat_id}/workflow/reply-draft`,
      { version: first.body.workflow.version },
    );
    expect(second.status).toBe(200);
    expect(second.body.draft.id).toBe(first.body.draft.id);
    const after = await env.snapshot();
    const inserts = after.journal
      .slice(before.journal.length)
      .filter((entry) => entry.table === 'outgoing_mail' && entry.operation === 'insert');
    expect(inserts).toHaveLength(1);
    expect(
      after.journal
        .slice(before.journal.length)
        .filter(
          (entry) =>
            entry.table === 'outgoing_mail' &&
            entry.after?.status &&
            ['scheduled', 'sending', 'sent'].includes(String(entry.after.status)),
        ),
    ).toEqual([]);
    expect(env.fakeSubmissions).toEqual([]);
  },
);

it('does not retry a classifier without a fresh domain retry guard', async () => {
  failClassification = true;
  const id = await chat(),
    run = await begin(id, 'message', { request_id: randomUUID(), body: '普通问题' });
  const result = await terminal(id, run);
  expect(result.run).toMatchObject({
    status: 'failed',
    execution: {
      model_calls: { started: 1 },
      feedback: { retries_reserved: 0, events: [{ block_reason: 'no_guard', action: 'stop' }] },
    },
  });
  expect(result.detail.messages).toEqual([]);
});

it('a template variable correction cannot acquire another automatic network retry', async () => {
  const workflow = await compose('variables');
  exhaustCorrectionRetry = true;
  const before = await env.snapshot();
  const run = await begin(workflow.chat_id, 'workflow', draftPayload(workflow));
  const result = await terminal(workflow.chat_id, run);
  expect(result.run).toMatchObject({
    status: 'failed',
    execution: {
      error_code: 'model_error',
      model_calls: { started: 4, failed: 2, returned: 2 },
      feedback: {
        retries_reserved: 1,
        events: [
          { outcome: 'selected' },
          { outcome: 'recovered' },
          { action: 'stop', block_reason: 'retry_limit' },
        ],
      },
    },
  });
  expect(
    seen.filter((input) =>
      input.snapshot.warnings.some((warning) => warning.includes('唯一一次变量纠正')),
    ),
  ).toHaveLength(1);
  expect(result.detail.messages).toEqual([]);
  const after = await env.snapshot();
  expect(
    after.journal.slice(before.journal.length).filter((entry) => entry.table === 'outgoing_mail'),
  ).toEqual([]);
  expect(env.fakeSubmissions).toEqual([]);
});

it('a changed workflow directory blocks recovery before any second answer request', async () => {
  const workflow = await compose();
  onFailure = () =>
    scoped(env.db, env.ids.boss, env.ids.workspace, async (ctx) => {
      const updated = await ctx.tx.query(
        'UPDATE people SET job_title=$2,version=version+1 WHERE id=$1 RETURNING id',
        [env.ids.export_person, `已变化${randomUUID()}`],
      );
      expect(updated.rows).toHaveLength(1);
    });
  const run = await begin(workflow.chat_id, 'workflow', draftPayload(workflow));
  const result = await terminal(workflow.chat_id, run);
  expect(result.run).toMatchObject({
    status: 'failed',
    execution: {
      model_calls: { started: 2 },
      error_code: 'scope_changed',
      feedback: {
        events: [
          { outcome: 'selected' },
          { outcome: 'blocked' },
          { outcome: 'stopped', reason: 'scope_changed' },
        ],
      },
    },
  });
  expect(seen.filter((input) => input.phase !== 'classify')).toHaveLength(1);
  expect(result.detail.messages).toEqual([]);
});

it('an out-of-scope citation is rejected without another generation or a saved answer', async () => {
  remainingFailures = 0;
  forgedCitation = true;
  const id = await chat(),
    run = await begin(id, 'message', { request_id: randomUUID(), body: '普通问题' });
  const result = await terminal(id, run);
  expect(result.run.status).toBe('failed');
  expect(result.run.error).toContain('范围外来源');
  expect(result.run.execution?.model_calls.started).toBe(2);
  expect(result.run.execution?.feedback).toBeUndefined();
  expect(result.detail.messages).toEqual([]);
});
