import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  agentModelToolInputSchema,
  agentReadEnvelopeSchema,
  agentTemplateReceiptToolSchema,
  createAgentHarness,
} from '../server/agent-harness.js';
import { AgentExecutionError } from '../server/agent-execution.js';
import { agentResultEnvelopeSchema, type AgentModelInput } from '../server/agent-model.js';
import { ApiError, scoped } from '../server/security.js';
import { agentToolContracts, agentToolContractVersion } from '../shared/agent-harness.js';
import type { HomeWorkflow } from '../shared/home-workflows.js';
import {
  createEvaluationEnvironment,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';

const harness = (extra: Partial<Parameters<typeof createAgentHarness>[0]> = {}) =>
  createAgentHarness({
    context: {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      customerId: randomUUID(),
      projectId: null,
      chatId: randomUUID(),
      runId: randomUUID(),
    },
    skillId: 'handle-incoming-mail',
    guard: async () => {},
    ...extra,
  });
const writeSchema = z.strictObject({ operation_id: z.uuid(), body: z.string() });
const receiptSchema = z.strictObject({ id: z.uuid() });
function writeStep(operationId: string, execute = async () => ({ id: operationId })) {
  return {
    step: 'save_draft' as const,
    tool: 'crm.save_draft' as const,
    operationId,
    input: { operation_id: operationId, body: 'synthetic content' },
    inputSchema: writeSchema,
    outputSchema: receiptSchema,
    execute,
  };
}

it('publishes immutable effects and retry metadata for only the existing fixed tools', () => {
  expect(Object.keys(agentToolContracts)).toEqual([
    'crm.read_sources',
    'crm.read_template',
    'model.generate',
    'result.validate',
    'crm.save_draft',
  ]);
  expect(agentToolContracts['crm.read_sources']).toMatchObject({
    kind: 'read',
    idempotency: 'read_only',
    effects: ['read_authorized_sources'],
  });
  expect(agentToolContracts['model.generate'].idempotency).toBe('not_idempotent');
  expect(agentToolContracts['crm.save_draft']).toMatchObject({
    kind: 'write',
    idempotency: 'stable_operation_id',
    retry: { automatic: false, eligible_errors: [], unknown_outcome: 'read_authoritative_result' },
  });
  for (const contract of Object.values(agentToolContracts)) {
    expect(contract.version).toBe(agentToolContractVersion);
    expect(contract.retry.automatic).toBe(false);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.effects)).toBe(true);
    expect(Object.isFrozen(contract.retry.eligible_errors)).toBe(true);
  }
});

it.each([undefined, 'secret@example.invalid', randomUUID()])(
  'blocks absent, malformed or mismatched write identities before executing (%s)',
  async (declared) => {
    const instance = harness();
    const execute = vi.fn(async () => ({ id: randomUUID() }));
    await expect(
      instance.runStep({ ...writeStep(randomUUID(), execute), operationId: declared }),
    ).rejects.toMatchObject({ status: 400 });
    expect(execute).not.toHaveBeenCalled();
    expect(instance.trace.at(-1)).toMatchObject({
      status: 'failed',
      error_code: 'invalid_input',
      write_outcome: 'not_started',
    });
    expect(JSON.stringify(instance.trace)).not.toContain('secret@example.invalid');
  },
);

it('does not allow a read tool to claim a write operation identity', async () => {
  const instance = harness();
  const execute = vi.fn(async () => ({ id: randomUUID() }));
  await expect(
    instance.runStep({
      ...writeStep(randomUUID(), execute),
      step: 'read_sources',
      tool: 'crm.read_sources',
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(execute).not.toHaveBeenCalled();
  expect(instance.trace.at(-1)).not.toHaveProperty('write_outcome');
});

it('validates the output before success and conservatively labels an executed write unknown', async () => {
  const instance = harness();
  const execute = vi.fn(async () => ({ id: 42 }));
  await expect(instance.runStep({ ...writeStep(randomUUID()), execute })).rejects.toMatchObject({
    status: 502,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(instance.trace.map((event) => event.status)).toEqual(['started', 'failed']);
  expect(instance.trace.at(-1)).toMatchObject({
    error_code: 'invalid_output',
    write_outcome: 'unknown',
  });
});

it('does not retry or claim rollback when a write times out after its side effect', async () => {
  const instance = harness({ limits: { maxDurationMs: 25 } });
  let committed = 0;
  const execute = vi.fn(async () => {
    committed++;
    return new Promise<never>(() => {});
  });
  await expect(instance.runStep(writeStep(randomUUID(), execute))).rejects.toMatchObject({
    status: 504,
  });
  expect(committed).toBe(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(instance.trace.at(-1)).toMatchObject({
    status: 'failed',
    error_code: 'deadline',
    write_outcome: 'unknown',
  });
});

it('validates selected-template receipts without exposing the private template row', () => {
  expect(agentTemplateReceiptToolSchema.safeParse(null).success).toBe(true);
  expect(
    agentTemplateReceiptToolSchema.safeParse({ name: '不使用模板', digest: 'none' }).success,
  ).toBe(true);
  expect(
    agentTemplateReceiptToolSchema.safeParse({ name: '合成模板', digest: 'a'.repeat(64) }).success,
  ).toBe(true);
  expect(
    agentTemplateReceiptToolSchema.safeParse({ name: '合成模板', digest: 'not-a-hash' }).success,
  ).toBe(false);
  expect(
    agentTemplateReceiptToolSchema.safeParse({
      name: '合成模板',
      digest: 'a'.repeat(64),
      body: 'private row',
    }).success,
  ).toBe(false);
});

it.each([
  [new AgentExecutionError('deadline'), 'deadline'],
  [new AgentExecutionError('model_call_limit'), 'model_call_limit'],
  [new AgentExecutionError('known_token_limit'), 'known_token_limit'],
  [new ApiError(409, 'Synthetic scope changed'), 'scope_changed'],
] as const)(
  'preserves a parent Run failure rather than reporting user cancellation (%s)',
  async (reason, code) => {
    const controller = new AbortController();
    const instance = harness({ signal: controller.signal });
    const execute = vi.fn(async () => {
      controller.abort(reason);
      return new Promise<never>(() => {});
    });
    await expect(instance.runStep(writeStep(randomUUID(), execute))).rejects.toBe(reason);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(instance.trace.at(-1)).toMatchObject({
      status: 'failed',
      error_code: code,
      write_outcome: 'unknown',
    });
  },
);

it('records explicit user cancellation distinctly from Run budget failures', async () => {
  const controller = new AbortController();
  const instance = harness({ signal: controller.signal });
  await expect(
    instance.runStep(
      writeStep(randomUUID(), async () => {
        controller.abort();
        return new Promise<never>(() => {});
      }),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(instance.trace.at(-1)).toMatchObject({
    status: 'cancelled',
    error_code: 'cancelled',
    write_outcome: 'unknown',
  });
});

it('validates actual read-envelope fields and excludes private SQL rows and mutation plans', () => {
  const valid = {
    snapshot: {
      label: 'synthetic',
      sources: [{ id: 'user:instruction', title: 'instruction', body: 'draft' }],
      warnings: [],
    },
    digest: 'a'.repeat(64),
    history: [{ role: 'user', content: 'draft' }],
    question: 'draft',
    user_preferences: [],
    preference_instruction: '',
  };
  expect(agentReadEnvelopeSchema.safeParse(valid).success).toBe(true);
  expect(agentReadEnvelopeSchema.safeParse({ ...valid, row: { result: 'private' } }).success).toBe(
    false,
  );
  expect(agentReadEnvelopeSchema.safeParse({ ...valid, preferencePlan: {} }).success).toBe(false);
  expect(
    agentReadEnvelopeSchema.safeParse({
      ...valid,
      history: [{ role: 'system', content: 'policy' }],
    }).success,
  ).toBe(false);
  expect(
    agentReadEnvelopeSchema.safeParse({
      ...valid,
      snapshot: {
        ...valid.snapshot,
        sources: [
          {
            id: 'r',
            title: 'r',
            body: 'r',
            ref: {
              kind: 'record',
              id: 'wrong',
              customer_id: randomUUID(),
              title: 'r',
              description: 'r',
            },
          },
        ],
      },
    }).success,
  ).toBe(false);
  expect(
    agentModelToolInputSchema.safeParse({
      question: 'draft',
      snapshot: valid.snapshot,
      history: [],
    }).success,
  ).toBe(true);
  expect(
    agentModelToolInputSchema.safeParse({
      question: 'draft',
      snapshot: valid.snapshot,
      history: [],
      unauthorized_tool: 'send',
    }).success,
  ).toBe(false);
});

it.each([
  { answer: 'ok', source_ids: [], arbitrary: 'hidden output' },
  { answer: '<think>private</think>ok', source_ids: [] },
  { answer: 'ok', source_ids: [42] },
])('rejects malformed outer model JSON before a successful model trace', async (raw) => {
  const instance = harness();
  await expect(
    instance.runStep({
      step: 'compose_mail',
      tool: 'model.generate',
      input: {},
      inputSchema: z.strictObject({}),
      outputSchema: agentResultEnvelopeSchema,
      execute: async () => raw,
    }),
  ).rejects.toMatchObject({ status: 502 });
  expect(instance.trace.map((event) => event.status)).toEqual(['started', 'failed']);
  expect(instance.trace.at(-1)?.error_code).toBe('invalid_output');
});

// Real product APIs, three isolated fictional sessions and deterministic model
// stubs. These checks do not count as model trials or use the daily database.
let env: EvaluationEnvironment;
let malformedOuter = false;
const answerSignals: (AbortSignal | undefined)[] = [];
const seen: AgentModelInput[] = [];
beforeAll(async () => {
  env = await createEvaluationEnvironment({
    agent: {
      transport: {
        async generate(input, runtime) {
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
              reply: '继续当前虚构邮件任务。',
              mail_action: null,
              turn_action: 'continue',
              slot_updates: [],
            };
          answerSignals.push(runtime?.signal);
          return {
            answer: JSON.stringify({
              body: '草稿待本人审核。',
              decisions: [],
              draft_subject: '虚构合同回归',
              draft_body: '林老师您好：具体数量和交期待确认。',
              changes: [],
              issues: [],
              mail_decisions: [],
              coverage: [],
            }),
            source_ids: [],
            ...(malformedOuter ? { hidden: 'not allowed' } : {}),
          };
        },
      },
    },
  });
}, 30000);
afterAll(() => env?.cleanup());
beforeEach(() => {
  malformedOuter = false;
  answerSignals.length = 0;
  seen.length = 0;
});
async function compose() {
  const chat = await env.actors.boss.request('POST', '/api/chats', {
    id: randomUUID(),
    title: '工具合同虚构回归',
    customer_id: null,
  });
  expect(chat.status).toBe(201);
  const created = await env.actors.boss.request('POST', `/api/chats/${chat.body.id}/workflow`, {
    kind: 'compose',
  });
  expect(created.status).toBe(201);
  const configured = await env.actors.boss.request('PATCH', `/api/chats/${chat.body.id}/workflow`, {
    version: created.body.version,
    config: {
      ...created.body.config,
      customer_id: env.ids.export_customer,
      person_id: env.ids.export_person,
      project_id: env.ids.export_project,
      instruction: '拟一封待审核邮件。',
      history_scope: null,
    },
  });
  expect(configured.status).toBe(200);
  const selected = await env.actors.boss.request(
    'POST',
    `/api/chats/${chat.body.id}/workflow/template`,
    { version: configured.body.version, choice: { kind: 'none' } },
  );
  expect(selected.status).toBe(200);
  return selected.body as HomeWorkflow;
}
function generate(w: HomeWorkflow) {
  return env.actors.boss.request('POST', `/api/chats/${w.chat_id}/workflow/run`, {
    version: w.version,
    request_id: randomUUID(),
    body: '生成当前草稿',
    phase: 'draft',
    task_action: 'draft_current',
  });
}
function open(w: HomeWorkflow) {
  return env.actors.boss.request('POST', `/api/chats/${w.chat_id}/workflow/reply-draft`, {
    version: w.version,
  });
}

it('passes a cancellation signal to the actual fixed model adapter and validates all successful trace nodes', async () => {
  const response = await generate(await compose());
  expect(response.status).toBe(200);
  expect(answerSignals).toHaveLength(1);
  expect(answerSignals[0]).toBeInstanceOf(AbortSignal);
  const w = response.body.workflow as HomeWorkflow;
  expect(
    w.result?.harness?.trace
      .filter((event) => event.status === 'succeeded')
      .map((event) => event.tool_id),
  ).toEqual(['crm.read_template', 'crm.read_sources', 'model.generate', 'result.validate']);
  const input = seen.find((item) => item.phase === 'answer')!;
  expect(input.snapshot.mail_directory?.recipient?.email).toBe('lin.export@eval.invalid');
  expect(input.snapshot.sources.some((source) => source.ref?.kind === 'record')).toBe(false);
});

it('rejects invalid actual model outer output before workflow adoption or draft persistence', async () => {
  malformedOuter = true;
  const w = await compose();
  const response = await generate(w);
  expect(response.status).toBe(502);
  const row = (
    await env.db.query(
      'SELECT result,result_digest,draft_id FROM home_workflows WHERE chat_id=$1',
      [w.chat_id],
    )
  ).rows[0];
  expect(row).toEqual({ result: null, result_digest: null, draft_id: null });
  expect(answerSignals).toHaveLength(1);
  expect(env.counters.fake_transport_submissions).toBe(0);
});

it('reuses the authoritative draft for a replay but gives changed content a fresh stable identity', async () => {
  const generated = await generate(await compose());
  expect(generated.status).toBe(200);
  const first = await open(generated.body.workflow);
  expect(first.status).toBe(200);
  const id = first.body.draft.id;
  const event = first.body.workflow.result.harness.trace.at(-1);
  expect(event).toMatchObject({
    tool_id: 'crm.save_draft',
    status: 'succeeded',
    operation_id: id,
    write_outcome: 'completed',
  });
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  // Simulate loss of only the workflow link, retaining the committed outgoing
  // operation. This is fixture fault setup, not a product write authorization.
  await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
    ctx.tx.query('UPDATE home_workflows SET draft_id=NULL WHERE chat_id=$1', [
      first.body.workflow.chat_id,
    ]),
  );
  const current = await env.actors.boss.request(
    'GET',
    `/api/chats/${first.body.workflow.chat_id}/workflow`,
  );
  expect(current.status).toBe(200);
  const replay = await open(current.body);
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body.draft.id).toBe(id);
  expect(
    (await env.db.query('SELECT count(*)::int AS count FROM outgoing_mail WHERE id=$1', [id]))
      .rows[0].count,
  ).toBe(1);
  // Same workflow/result message/source digest, different accepted body: it
  // cannot reuse an older operation ID and either conflict or show old content.
  await scoped(env.db, env.ids.boss, env.ids.workspace, (ctx) =>
    ctx.tx.query(
      "UPDATE home_workflows SET draft_id=NULL,result=jsonb_set(result,'{draft_body}',to_jsonb($2::text)) WHERE chat_id=$1",
      [first.body.workflow.chat_id, '林老师您好：这是调整后的虚构正文，交期待确认。'],
    ),
  );
  const edited = await env.actors.boss.request(
    'GET',
    `/api/chats/${first.body.workflow.chat_id}/workflow`,
  );
  expect(edited.status).toBe(200);
  const changed = await open(edited.body);
  expect(changed.status).toBe(200);
  expect(changed.body.draft.id).not.toBe(id);
  expect(changed.body.draft.body).toContain('调整后的虚构正文');
  expect(env.counters.fake_transport_submissions).toBe(0);
});
