import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bindAgentEntry } from '../server/agent-entries.js';
import {
  planAgentContext,
  refreshAgentContext,
  assertAgentContextInput,
  assertAgentContextCurrent,
  contextPlanDigest,
  contextPlanModelView,
  contextPlanSummary,
  agentContextPlanToolSchema,
} from '../server/agent-context-plan.js';
import { buildAgentTaskState } from '../server/agent-task-state.js';
import {
  callAgent,
  prepareAgent,
  snapshotDigest,
  type AgentModelInput,
} from '../server/agent-model.js';
import { createAgentExecution, publicAgentExecution } from '../server/agent-execution.js';
import type { Context } from '../server/security.js';

const ctx = { workspaceId: randomUUID(), actorId: randomUUID() } as Context;
const binding = () => bindAgentEntry(ctx, 'home', 'home_chat', { kind: 'directory' });
function input(): AgentModelInput {
  return {
    entry_context: binding().modelContext,
    snapshot: { label: '虚构对话', sources: [], warnings: [] },
    question: '你好',
    history: [],
  };
}
const planned = (options: Parameters<typeof planAgentContext>[3] = {}) =>
  planAgentContext(ctx, binding(), input(), options);

it('binds real input without changing the existing evidence snapshot digest', () => {
  const value = input(),
    before = snapshotDigest(value.snapshot);
  const current = planAgentContext(ctx, binding(), value);
  expect(snapshotDigest(current.snapshot)).toBe(before);
  expect(assertAgentContextInput(current, ctx).version).toBe('crm-context-plan-v1');
  expect(current.context_plan.state.identity.chat_id).toBeNull();
  expect(current.context_plan.state.scope.customer_id).toBeNull();
});

it('rejects input changes and does not let serialized manifests mint a plan', () => {
  const value = planned();
  expect(() => value.snapshot.warnings.push('更改后的说明')).toThrow();
  expect(() =>
    assertAgentContextInput({
      ...value,
      snapshot: { ...value.snapshot, warnings: ['更改后的说明'] },
    }),
  ).toThrow('上下文内容已变化');
  expect(() => assertAgentContextInput(structuredClone(planned()))).toThrow('缺少本次服务端');
  expect(
    agentContextPlanToolSchema.safeParse(structuredClone(planned().context_plan)).success,
  ).toBe(false);
  expect(agentContextPlanToolSchema.safeParse(planned().context_plan).success).toBe(true);
});

it('rejects cross-actor identity and unrelated supplied task state', () => {
  const value = planned();
  expect(() => assertAgentContextInput(value, { ...ctx, actorId: randomUUID() })).toThrow(
    '其他用户',
  );
  expect(() => planAgentContext({ ...ctx, actorId: randomUUID() }, binding(), input())).toThrow(
    '身份',
  );
  const state = buildAgentTaskState(ctx, {
    entry: 'home',
    task: 'home_chat',
    scope: { kind: 'directory', digest: 'a'.repeat(64) },
    phase: 'running',
    revision: 1,
  });
  expect(() => planned({ state })).toThrow('任务状态与上下文范围不符');
});

it('rejects changed scope, evidence and generation after the domain re-read', () => {
  const generation = randomUUID();
  const value = planned({
    dependencies: [
      { kind: 'evidence', digest: 'b'.repeat(64) },
      { kind: 'workflow_generation', digest: contextPlanDigest(generation) },
    ],
  });
  const current = {
    scopeDigest: value.context_plan.scope.digest,
    evidenceDigest: 'b'.repeat(64),
    generation,
  };
  expect(() => assertAgentContextCurrent(value.context_plan, ctx, current)).not.toThrow();
  expect(() =>
    assertAgentContextCurrent(value.context_plan, ctx, { ...current, scopeDigest: 'a'.repeat(64) }),
  ).toThrow('范围');
  expect(() =>
    assertAgentContextCurrent(value.context_plan, ctx, {
      ...current,
      evidenceDigest: 'a'.repeat(64),
    }),
  ).toThrow('来源');
  expect(() =>
    assertAgentContextCurrent(value.context_plan, ctx, { ...current, generation: randomUUID() }),
  ).toThrow('代次');
});

it('measures Chinese UTF-8 bytes across sources, history, material, preferences and Skill', () => {
  const value = {
    ...input(),
    history: [{ role: 'user' as const, content: '中文历史' }],
    user_preferences: [{ category: 'mail_style', value: '简短' }],
    material: { name: '虚构.txt', content: '本人材料' },
    task_instructions: '受控方法说明',
  };
  const current = planAgentContext(ctx, binding(), value);
  const nativeContext = { ...value, context_plan: contextPlanModelView(current.context_plan) };
  expect(current.context_plan.budget.input_bytes).toBe(
    Buffer.byteLength(JSON.stringify(nativeContext), 'utf8'),
  );
  expect(current.context_plan.budget.measurement).toBe('serialized_dynamic_context_utf8');
  expect(() => planAgentContext(ctx, binding(), value, { maxInputBytes: 100 })).toThrow('超过容量');
  expect(value.history).toHaveLength(1);
  expect(value.material.content).toBe('本人材料');
});

it('preserves 20 selected messages and refuses a 21st without silent truncation', () => {
  const value = {
    ...input(),
    history: Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `消息${index}`,
    })),
  };
  const current = planAgentContext(ctx, binding(), value);
  expect(current.history).toHaveLength(20);
  expect(current.context_plan.selections.history_limit).toBe(20);
  expect(() =>
    planAgentContext(ctx, binding(), { ...value, history: [...value.history, value.history[0]] }),
  ).toThrow('20条');
});

it('classification cannot acquire source bodies, material or personal preferences', () => {
  for (const extra of [
    {
      snapshot: {
        ...input().snapshot,
        sources: [{ id: 'record:one', title: '虚构', body: '原文' }],
      },
    },
    { material: { name: '材料', content: '原文' } },
    { user_preferences: [{ category: 'mail_style', value: '简短' }] },
  ])
    expect(() =>
      planAgentContext(ctx, binding(), { ...input(), phase: 'classify', ...extra }),
    ).toThrow('分类上下文');
});

it('distinguishes template, directory and user material from business evidence', () => {
  const customerId = randomUUID();
  const current = planAgentContext(ctx, binding(), {
    ...input(),
    snapshot: {
      label: '虚构候选',
      warnings: [],
      sources: [
        { id: 'mail-template:one', title: '模板', body: '模板不是事实' },
        { id: 'user:instruction', title: '本人说明', body: '用户原话' },
        { id: 'material:current', title: '本人材料', body: '材料原文' },
        {
          id: 'entity:one',
          title: '目录',
          body: '基础目录',
          ref: {
            id: customerId,
            customer_id: customerId,
            kind: 'entity',
            title: '目录',
            description: '',
          },
        },
        {
          id: 'record:one',
          title: '业务来源',
          body: '客户原话',
          ref: {
            id: randomUUID(),
            customer_id: customerId,
            kind: 'record',
            title: '记录',
            description: '',
          },
        },
      ],
    },
  });
  expect(current.context_plan.sources.map((source) => source.kind)).toEqual([
    'template',
    'user_input',
    'material',
    'basic_directory',
    'business_record',
  ]);
});

it('single-customer manifests reject cross-customer evidence while collection scopes stay valid', () => {
  const customerId = randomUUID();
  const entry = bindAgentEntry(ctx, 'home', 'home_chat', {
    kind: 'entity',
    object: 'customers',
    customer_id: customerId,
    record_id: customerId,
  });
  const source = {
    id: 'record:one',
    title: '其他客户',
    body: '虚构原文',
    ref: {
      id: randomUUID(),
      customer_id: randomUUID(),
      kind: 'record' as const,
      title: '记录',
      description: '',
    },
  };
  expect(() =>
    planAgentContext(ctx, entry, {
      ...input(),
      entry_context: entry.modelContext,
      snapshot: { ...input().snapshot, sources: [source] },
    }),
  ).toThrow('当前客户');
  const collection = bindAgentEntry(ctx, 'page_ask', 'page_question', {
    kind: 'records',
    object: 'customers',
    scope_digest: 'a'.repeat(64),
    selected_count: 2,
  });
  const current = planAgentContext(ctx, collection, {
    ...input(),
    entry_context: collection.modelContext,
    snapshot: { ...input().snapshot, sources: [source] },
  });
  expect(current.context_plan.state.scope.customer_id).toBeNull();
});

it('refuses duplicated source IDs even when bodies differ', () => {
  const source = { id: 'record:one', title: '虚构', body: '原文' };
  expect(() =>
    planAgentContext(ctx, binding(), {
      ...input(),
      snapshot: { ...input().snapshot, sources: [source, { ...source, body: '不同原文' }] },
    }),
  ).toThrow('标识重复');
});

it('rebuilds the call input for the existing one-time correction without widening scope', () => {
  const workflowId = randomUUID(),
    chatId = randomUUID(),
    generation = randomUUID();
  const entry = bindAgentEntry(ctx, 'home_workflow', 'compose', {
    kind: 'workflow',
    workflow_id: workflowId,
    version: 1,
    customer_id: null,
    person_id: null,
    project_id: null,
  });
  const state = buildAgentTaskState(ctx, {
    entry: 'home_workflow',
    task: 'compose',
    identity: { chat_id: chatId, workflow_id: workflowId },
    scope: { kind: 'workflow', digest: entry.scope_digest, generation },
    phase: 'ready',
    revision: 1,
  });
  const first = planAgentContext(
    ctx,
    entry,
    { ...input(), phase: 'answer', entry_context: entry.modelContext },
    { state, chatId },
  );
  const corrected = refreshAgentContext(
    { ...first, snapshot: { ...first.snapshot, warnings: ['受控变量纠正'] } },
    'mail_variable_correction',
  );
  expect(corrected.context_plan.input_digest).not.toBe(first.context_plan.input_digest);
  expect(corrected.context_plan.scope.digest).toBe(first.context_plan.scope.digest);
  expect(corrected.context_plan.state_digest).toBe(first.context_plan.state_digest);
  expect(assertAgentContextInput(corrected)).toBe(corrected.context_plan);
  expect(() =>
    refreshAgentContext(
      {
        ...first,
        snapshot: {
          ...first.snapshot,
          sources: [{ id: 'user:instruction', title: '伪造', body: '改写原话' }],
        },
      },
      'mail_variable_correction',
    ),
  ).toThrow('纠正不能更改');
});

it('enforces the plan before both fake and native model transport calls', async () => {
  let calls = 0;
  const transport = await prepareAgent(ctx, null, {
    transport: {
      async generate() {
        calls++;
        return { answer: '你好', source_ids: [] };
      },
    },
  });
  await expect(async () => transport.generate(input())).rejects.toThrow('缺少本次服务端');
  expect(calls).toBe(0);
  const value = planned();
  await expect(async () => transport.generate({ ...value, question: '已被改动' })).rejects.toThrow(
    '内容已变化',
  );
  expect(calls).toBe(0);
  await transport.generate(planned());
  expect(calls).toBe(1);
});

it('sends the safe plan and unified state view to the provider without private identity/provenance', async () => {
  let sent = '';
  const request = (async (_url: unknown, init?: RequestInit) => {
    sent = String(init?.body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ answer: '你好', source_ids: [] }) },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  await callAgent(planned(), 'synthetic-key', 'cn', request);
  const messages = JSON.parse(sent).messages;
  const context = JSON.parse(messages[1].content);
  expect(context.context_plan.state.version).toBe('crm-task-state-v1');
  expect(context.context_plan.entry).toBe('home');
  expect(sent).not.toContain(ctx.actorId);
  expect(sent).not.toContain('state_digest');
});

it('persists only safe summaries with the same Run model-call budget', async () => {
  const execution = createAgentExecution();
  const secretText = '原文不应进入观测';
  const value = planAgentContext(ctx, binding(), {
    ...input(),
    snapshot: {
      ...input().snapshot,
      sources: [{ id: 'user:instruction', title: '本人', body: secretText }],
    },
  });
  const transport = await prepareAgent(ctx, null, {
    execution,
    transport: {
      async generate() {
        return { answer: '你好', source_ids: [] };
      },
    },
  });
  await transport.generate(value);
  const telemetry = execution.snapshot();
  expect(telemetry.context_plans).toEqual([contextPlanSummary(value)]);
  expect(telemetry.model_calls.started).toBe(1);
  expect(JSON.stringify(telemetry)).not.toContain(secretText);
  expect(publicAgentExecution(telemetry)).toEqual(telemetry);
  const untrusted = structuredClone(telemetry);
  Object.assign(untrusted.context_plans![0], { raw_body: secretText });
  expect(publicAgentExecution(untrusted)).toBeUndefined();
  execution.dispose();
});

it('requires the actual scope fields to agree with the state instead of trusting a shared digest', () => {
  const customerId = randomUUID(),
    wrongCustomer = randomUUID();
  const entry = bindAgentEntry(ctx, 'home', 'home_chat', {
    kind: 'entity',
    object: 'customers',
    customer_id: customerId,
    record_id: customerId,
  });
  const state = buildAgentTaskState(ctx, {
    entry: 'home',
    task: 'home_chat',
    scope: { kind: 'entity', digest: entry.scope_digest, customer_id: wrongCustomer },
    phase: 'running',
    revision: 1,
  });
  const value = {
    ...input(),
    entry_context: entry.modelContext,
    snapshot: {
      ...input().snapshot,
      sources: [
        {
          id: 'record:wrong',
          title: '其他客户',
          body: '虚构原文',
          ref: {
            id: randomUUID(),
            customer_id: wrongCustomer,
            kind: 'record' as const,
            title: '虚构',
            description: '',
          },
        },
      ],
    },
  };
  expect(() => planAgentContext(ctx, entry, value, { state })).toThrow('入口对象');
});

it('rejects an old slot applicability and unknown source dependency before model use', () => {
  const state = buildAgentTaskState(ctx, {
    entry: 'home',
    task: 'home_chat',
    scope: { kind: 'directory', digest: binding().scope_digest },
    phase: 'running',
    revision: 1,
    slots: [
      {
        name: 'query',
        status: 'provided',
        value: '旧对象的查找条件',
        source: { kind: 'entry_input', version: 1 },
        version: 1,
        applicability: { scope_digest: 'a'.repeat(64), generation: null },
      },
    ],
  });
  expect(() => planned({ state })).toThrow('已失效');
  const unverified = {
    ...state,
    slots: [],
    dependencies: [
      {
        kind: 'record' as const,
        id: randomUUID(),
        revision: null,
        hash: null,
        status: 'unknown' as const,
      },
    ],
  };
  expect(() => planned({ state: unverified })).toThrow('已失效');
});

it('snapshots SQL Dates as immutable JSON values and leaves the original domain object untouched', () => {
  const date = new Date('2026-11-01T00:00:00Z');
  const value = { ...input(), snapshot: { ...input().snapshot, task_state: { due_date: date } } };
  const current = planAgentContext(ctx, binding(), value);
  date.setUTCDate(9);
  expect(current.snapshot.task_state?.due_date).toBe('2026-11-01T00:00:00.000Z');
  expect(value.snapshot.task_state.due_date).toBe(date);
  expect(assertAgentContextInput(current)).toBe(current.context_plan);
  expect(() => assertAgentContextInput({ ...current, snapshot: value.snapshot })).toThrow(
    '内容已变化',
  );
});

it('restores a legacy classification without allowing a source or preference replacement', () => {
  const first = planAgentContext(ctx, binding(), { ...input(), phase: 'classify' });
  const restored = refreshAgentContext(
    {
      ...first,
      question: '原始任务',
      history: [],
      snapshot: { ...first.snapshot, warnings: ['只恢复原任务类型'] },
    },
    'legacy_classification_restore',
  );
  expect(restored.question).toBe('原始任务');
  expect(assertAgentContextInput(restored)).toBe(restored.context_plan);
  expect(() =>
    refreshAgentContext(
      { ...first, user_preferences: [{ category: 'style', value: '伪造偏好' }] },
      'legacy_classification_restore',
    ),
  ).toThrow('纠正不能更改');
});

it('fails closed when a declared template dependency has not been freshly checked', () => {
  const value = planned({ dependencies: [{ kind: 'template', digest: 'a'.repeat(64) }] });
  const current = { scopeDigest: value.context_plan.scope.digest };
  expect(() => assertAgentContextCurrent(value.context_plan, ctx, current)).toThrow('模板未复验');
  expect(() =>
    assertAgentContextCurrent(value.context_plan, ctx, {
      ...current,
      templateDigest: 'b'.repeat(64),
    }),
  ).toThrow('模板未复验');
  expect(() =>
    assertAgentContextCurrent(value.context_plan, ctx, {
      ...current,
      templateDigest: 'a'.repeat(64),
    }),
  ).not.toThrow();
});
