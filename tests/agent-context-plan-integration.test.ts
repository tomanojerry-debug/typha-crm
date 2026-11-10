import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createEvaluationEnvironment,
  type EvaluationActor,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';
import type { AgentModelInput } from '../server/agent-model.js';
import { agentTaskStateSchema } from '../server/agent-task-state.js';
import { assertAgentContextInput } from '../server/agent-context-plan.js';
import { scoped } from '../server/security.js';
import type { AgentRunResult } from '../shared/agent-runs.js';
import type { HomeWorkflow, WorkflowConfig } from '../shared/home-workflows.js';

// Actual product APIs, a disposable fictional database, deterministic models and
// fail-closed fixture transports. This suite does not measure provider quality.
let env: EvaluationEnvironment;
const seen: AgentModelInput[] = [];
let mode: 'general' | 'workflow' | 'cancel' = 'general';
let beforeAnswer: (() => Promise<void>) | undefined;
const privateQuestion = 'PRIVATE_CONTEXT_QUESTION_CANARY';
const oldDraft = 'OLD_DRAFT_BODY_MUST_NOT_SURVIVE_CANCELLATION';
const privateSlot = 'PRIVATE_SLOT_REQUIREMENT_CANARY';

beforeAll(async () => {
  env = await createEvaluationEnvironment({
    agent: {
      transport: {
        async generate(input, runtime) {
          assertAgentContextInput(input);
          expect(input.context_plan).toBeDefined();
          agentTaskStateSchema.parse(input.context_plan!.state);
          seen.push(structuredClone(input));
          runtime?.onUsage?.({ input_tokens: 7, output_tokens: 3 });
          if (input.phase === 'classify')
            return {
              intent: mode === 'workflow' ? '起草内容' : '一般对话',
              action: 'respond',
              entity_type: 'unknown',
              target: null,
              match_mode: null,
              candidate_index: null,
              data_source: 'records',
              missing: [],
              reply: '按当前任务范围继续。',
              mail_action: null,
              turn_action: mode === 'cancel' ? 'cancel' : 'continue',
              ...(mode === 'cancel' ? { turn_evidence: '取消这次写信' } : {}),
              slot_updates: [],
            };
          if (beforeAnswer) {
            const hook = beforeAnswer;
            beforeAnswer = undefined;
            await hook();
          }
          if (input.entry_context?.entry !== 'home_workflow')
            return {
              answer: '这是当前授权范围内的隔离测试回答。',
              source_ids: input.snapshot.sources.slice(0, 1).map((s) => s.id),
            };
          const template = input.snapshot.sources.find((s) => s.id.startsWith('mail-template:'));
          const masked = template ? JSON.parse(template.body) : null;
          return {
            answer: JSON.stringify({
              body: mode === 'cancel' ? '本任务已停止。' : '虚构草稿已准备，尚未发送。',
              decisions: [],
              changes: [],
              issues: [],
              mail_decisions: [],
              coverage: [],
              draft_subject:
                mode === 'cancel' ? undefined : masked?.subject || '虚构上下文测试邮件',
              draft_body: mode === 'cancel' ? null : masked?.body || oldDraft,
            }),
            source_ids: template ? [template.id] : [],
          };
        },
      },
    },
  });
}, 60000);

afterAll(async () => {
  if (!env) return;
  try {
    expect(env.fakeSubmissions).toEqual([]);
    expect(env.counters.fake_transport_attempts).toBe(0);
    expect(env.counters.fake_mail_syncs).toBe(0);
    expect(env.counters.fixture_wechat_reads).toBe(0);
  } finally {
    await env.cleanup();
  }
});
beforeEach(() => {
  seen.length = 0;
  mode = 'general';
  beforeAnswer = undefined;
});
async function chat(actor: EvaluationActor = env.actors.boss) {
  const response = await actor.request('POST', '/api/chats', {
    id: randomUUID(),
    title: '统一上下文计划隔离集成',
    customer_id: null,
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}
async function terminal(chatId: string, runId: string, actor: EvaluationActor = env.actors.boss) {
  const deadline = Date.now() + 6000;
  do {
    const response = await actor.request('GET', `/api/chats/${chatId}/runs/${runId}`);
    expect(response.status).toBe(200);
    const result = response.body as AgentRunResult;
    if (!['queued', 'running', 'cancelling'].includes(result.run.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('ContextPlan fixture run did not terminate');
}
async function configure(
  actor: EvaluationActor = env.actors.boss,
  changes: Partial<WorkflowConfig> = {},
) {
  const chatId = await chat(actor);
  const initial = await actor.request('POST', `/api/chats/${chatId}/workflow`, { kind: 'compose' });
  expect(initial.status).toBe(201);
  const configured = await actor.request('PATCH', `/api/chats/${chatId}/workflow`, {
    version: initial.body.version,
    config: {
      ...initial.body.config,
      customer_id: env.ids.export_customer,
      person_id: env.ids.export_person,
      project_id: env.ids.export_project,
      instruction: '写一封虚构邮件，不作价格或交期承诺。',
      history_scope: null,
      ...changes,
    },
  });
  expect(configured.status).toBe(200);
  return configured.body as HomeWorkflow;
}
async function withoutTemplate(w: HomeWorkflow, actor: EvaluationActor = env.actors.boss) {
  const selected = await actor.request('POST', `/api/chats/${w.chat_id}/workflow/template`, {
    version: w.version,
    choice: { kind: 'none' },
  });
  expect(selected.status).toBe(200);
  return selected.body as HomeWorkflow;
}
const draftPayload = (w: HomeWorkflow) => ({
  version: w.version,
  request_id: randomUUID(),
  body: '生成当前邮件草稿',
  phase: 'draft',
  task_action: 'draft_current',
});
const directDraft = (w: HomeWorkflow, actor: EvaluationActor = env.actors.boss) =>
  actor.request('POST', `/api/chats/${w.chat_id}/workflow/run`, draftPayload(w));
async function stored(chatId: string) {
  return (
    await env.db.query<{ result: unknown; result_digest: string | null; step: string }>(
      'SELECT result,result_digest,step FROM home_workflows WHERE chat_id=$1',
      [chatId],
    )
  ).rows[0];
}
function assertSafeSummaries(result: AgentRunResult) {
  const summaries = result.run.execution?.context_plans;
  expect(summaries?.length).toBeGreaterThan(0);
  for (const summary of summaries!) {
    expect(summary).toMatchObject({
      version: 'crm-context-plan-v1',
      state_version: 'crm-task-state-v1',
    });
    expect(summary.state_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.input_bytes).toBeLessThanOrEqual(summary.limit_bytes);
    for (const key of [
      'state',
      'slots',
      'sources',
      'question',
      'body',
      'value',
      'evidence',
      'identity',
    ])
      expect(summary).not.toHaveProperty(key);
  }
  const text = JSON.stringify(result.run.execution);
  for (const forbidden of [
    privateQuestion,
    oldDraft,
    privateSlot,
    ...env.fixture.records.map((r) => r.body),
  ])
    expect(text).not.toContain(forbidden);
}

it('issues valid plans for Home classification and answering and stores only safe Run summaries', async () => {
  const chatId = await chat();
  const queued = await env.actors.boss.request('POST', `/api/chats/${chatId}/runs`, {
    kind: 'message',
    payload: { request_id: randomUUID(), body: privateQuestion },
  });
  expect(queued.status).toBe(202);
  const result = await terminal(chatId, queued.body.run.id);
  expect(result.run.status).toBe('completed');
  expect(seen.map((input) => input.phase)).toEqual(['classify', 'answer']);
  for (const input of seen)
    expect(input.context_plan).toMatchObject({
      entry: 'home',
      task: 'home_chat',
      identity: {
        workspace_id: env.ids.workspace,
        actor_id: env.ids.boss,
        chat_id: chatId,
        run_id: result.run.id,
      },
      state: {
        scope: { kind: 'directory', customer_id: null },
        identity: { chat_id: chatId, run_id: result.run.id },
      },
    });
  expect(seen[0].context_plan!.sources).toEqual([]);
  expect(seen[0].context_plan!.selections).toMatchObject({
    history: 'classification_user_turns',
    preference_count: 0,
  });
  assertSafeSummaries(result);
  expect(result.run.execution?.context_plans?.map((p) => p.phase)).toEqual(['classify', 'answer']);
});

it('keeps Ask selected rows and current entity scopes distinct with no fabricated collection customer', async () => {
  const collectionChat = randomUUID();
  const selected = await env.actors.export.request('POST', '/api/ask/runs', {
    chat_id: collectionChat,
    request_id: randomUUID(),
    question: privateQuestion,
    scope: { kind: 'records', object: 'people', selected_ids: [env.ids.export_person], query: '' },
    action: 'overview',
  });
  expect(selected.status).toBe(202);
  const collection = await terminal(collectionChat, selected.body.run.id, env.actors.export);
  expect(collection.run.status).toBe('completed');
  const collectionInput = seen.at(-1)!;
  expect(collectionInput.context_plan).toMatchObject({
    entry: 'page_ask',
    task: 'page_question',
    state: { scope: { kind: 'records', customer_id: null, person_id: null } },
  });
  expect(JSON.stringify(collectionInput.snapshot)).not.toContain('lin.domestic@eval.invalid');
  assertSafeSummaries(collection);
  const entityChat = randomUUID();
  const entity = await env.actors.export.request('POST', '/api/ask/runs', {
    chat_id: entityChat,
    request_id: randomUUID(),
    question: '概括当前公司',
    scope: {
      kind: 'entity',
      object: 'customers',
      customer_id: env.ids.export_customer,
      record_id: env.ids.export_customer,
    },
    action: 'overview',
  });
  expect(entity.status).toBe(202);
  const current = await terminal(entityChat, entity.body.run.id, env.actors.export);
  expect(current.run.status).toBe('completed');
  const currentInput = seen.at(-1)!;
  expect(currentInput.context_plan!.state.scope).toMatchObject({
    kind: 'entity',
    customer_id: env.ids.export_customer,
  });
  expect(currentInput.context_plan!.scope.digest).not.toBe(
    collectionInput.context_plan!.scope.digest,
  );
});

it('enforces the existing template gate and passes a valid workflow State to persistent draft generation', async () => {
  mode = 'workflow';
  const unselected = await configure();
  expect((await directDraft(unselected)).status).toBe(409);
  expect(seen).toEqual([]);
  const w = await withoutTemplate(unselected);
  const requestId = randomUUID();
  await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
    ctx.tx.query(
      "UPDATE home_workflows SET config=jsonb_set(config,'{task_slots}',$2::jsonb) WHERE id=$1",
      [
        w.id,
        JSON.stringify([
          {
            slot: 'writing_requirements',
            op: 'set',
            value: privateSlot,
            evidence: privateSlot,
            request_id: requestId,
          },
        ]),
      ],
    ),
  );
  const queued = await env.actors.boss.request('POST', `/api/chats/${w.chat_id}/runs`, {
    kind: 'workflow',
    payload: draftPayload(
      (await env.actors.boss.request('GET', `/api/chats/${w.chat_id}/workflow`)).body,
    ),
  });
  expect(queued.status).toBe(202);
  const result = await terminal(w.chat_id, queued.body.run.id);
  expect(result.run.status).toBe('completed');
  const input = seen.find((item) => item.phase === 'answer')!;
  expect(input.context_plan).toMatchObject({
    entry: 'home_workflow',
    task: 'compose',
    state: {
      identity: { workflow_id: w.id, chat_id: w.chat_id, run_id: result.run.id },
      scope: { kind: 'workflow', customer_id: env.ids.export_customer },
    },
  });
  expect(
    input.context_plan!.state.slots.find((slot) => slot.name === 'writing_requirements'),
  ).toMatchObject({ value: privateSlot, source: { kind: 'user_message', request_id: requestId } });
  expect(input.snapshot.task_state).toBeDefined();
  expect((await stored(w.chat_id)).result).not.toBeNull();
  assertSafeSummaries(result);
});

it('rejects a prepared result when a referenced record changes before commit', async () => {
  mode = 'workflow';
  const w = await withoutTemplate(
    await configure(env.actors.boss, {
      history_scope: {
        enabled: true,
        source_kinds: ['mail'],
        person_id: env.ids.export_person,
        project_id: env.ids.export_project,
        date_start: null,
        date_end: null,
      },
    }),
  );
  let mutationError: unknown;
  beforeAnswer = async () => {
    try {
      await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
        ctx.tx.query('UPDATE mail_messages SET body=body||$2 WHERE id=$1', [
          env.ids.mail_latest,
          ' SOURCE_CHANGED_DURING_GENERATION',
        ]),
      );
    } catch (error) {
      mutationError = error;
      throw error;
    }
  };
  const response = await directDraft(w);
  expect(mutationError).toBeUndefined();
  expect([404, 409], JSON.stringify(response.body)).toContain(response.status);
  expect(seen.some((input) => input.phase === 'answer')).toBe(true);
  expect((await stored(w.chat_id)).result).toBeNull();
});

it('rejects a prepared result when workflow configuration generation changes before commit', async () => {
  mode = 'workflow';
  const w = await withoutTemplate(await configure());
  beforeAnswer = async () => {
    await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
      ctx.tx.query(
        'UPDATE home_workflows SET config_generation=gen_random_uuid(),version=version+1 WHERE id=$1',
        [w.id],
      ),
    );
  };
  expect((await directDraft(w)).status).toBe(409);
  expect(seen.some((input) => input.phase === 'answer')).toBe(true);
  expect((await stored(w.chat_id)).result).toBeNull();
});

it('rechecks current customer permission after generation instead of trusting an issued plan', async () => {
  mode = 'workflow';
  const w = await withoutTemplate(await configure(env.actors.export), env.actors.export);
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
    const response = await directDraft(w, env.actors.export);
    expect([404, 409]).toContain(response.status);
    expect(seen.some((input) => input.phase === 'answer')).toBe(true);
    expect((await stored(w.chat_id)).result).toBeNull();
  } finally {
    expect(
      (
        await env.actors.boss.request(
          'PUT',
          `/api/customers/${env.ids.export_customer}/access/${env.ids.export}`,
          { access: 'editor' },
        )
      ).status,
    ).toBe(200);
  }
});

it('builds cancellation explanation without old workflow results, history or business sources', async () => {
  mode = 'workflow';
  let w = await withoutTemplate(await configure());
  await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
    ctx.tx.query(
      "UPDATE home_workflows SET config=jsonb_set(config,'{task_slots}',$2::jsonb) WHERE id=$1",
      [
        w.id,
        JSON.stringify([
          {
            slot: 'writing_requirements',
            op: 'set',
            value: privateSlot,
            evidence: privateSlot,
            request_id: randomUUID(),
          },
        ]),
      ],
    ),
  );
  w = (await env.actors.boss.request('GET', `/api/chats/${w.chat_id}/workflow`)).body;
  const generated = await directDraft(w);
  expect(generated.status).toBe(200);
  expect(generated.body.workflow.result.draft_body).toBe(oldDraft);
  seen.length = 0;
  mode = 'cancel';
  const response = await env.actors.boss.request('POST', `/api/chats/${w.chat_id}/workflow/run`, {
    version: generated.body.workflow.version,
    request_id: randomUUID(),
    body: '取消这次写信',
    phase: 'analyze',
    task_action: 'message',
  });
  expect(response.status).toBe(200);
  const input = seen.find((item) => item.phase === 'answer')!;
  expect(input.context_plan!.state.cancellation.status).toBe('cancelled');
  expect(input.context_plan!.state.result).toBeNull();
  expect(input.context_plan!.state.slots).toEqual([]);
  expect(input.history).toEqual([]);
  expect(input.snapshot.sources.every((source) => source.id.startsWith('user:'))).toBe(true);
  expect(JSON.stringify(input)).not.toContain(oldDraft);
  expect(JSON.stringify(input)).not.toContain(privateSlot);
  expect(await stored(w.chat_id)).toMatchObject({
    step: 'cancelled',
    result: null,
    result_digest: null,
  });
  const recovered = await env.actors.boss.request('GET', `/api/chats/${w.chat_id}/workflow`);
  expect(recovered.status).toBe(200);
  expect(recovered.body.result).toBeNull();
  expect(JSON.stringify(recovered.body)).not.toContain(oldDraft);
});
