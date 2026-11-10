import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  agentTaskDependencyDigest,
  agentTaskSlotSchema,
  agentTaskStateDigest,
  agentTaskStateSchema,
  buildAgentTaskState,
  checkAgentTaskState,
  workflowAgentTaskState,
} from '../server/agent-task-state.js';
import type { AgentTaskDependency, AgentTaskSlot } from '../shared/agent-task-state.js';
import type { WorkflowConfig, WorkflowResult } from '../shared/home-workflows.js';

const ctx = { workspaceId: randomUUID(), actorId: randomUUID() };
const scopeDigest = agentTaskStateDigest({ customer: 'current' });
const generation = randomUUID();
const customer = randomUUID();
const identity = { chat_id: randomUUID(), workflow_id: randomUUID(), run_id: randomUUID() };
function workflow() {
  return {
    id: identity.workflow_id,
    chat_id: identity.chat_id,
    actor_id: ctx.actorId,
    kind: 'compose' as const,
    step: 'ready' as const,
    version: 3,
    config_generation: generation,
    result_digest: null as string | null,
    result: null as WorkflowResult | null,
    draft_id: null as string | null,
    config: {
      customer_id: customer,
      person_id: randomUUID(),
      project_id: null,
      source_kinds: ['pasted'],
      date_start: null,
      date_end: null,
      mail_id: null,
      document_id: null,
      material: { name: '私有文件', content: '不可复制的业务全文' },
      instruction: '不可复制的完整任务指令',
      field_ids: [],
      task_slots: [
        {
          slot: 'language',
          op: 'set',
          value: 'en',
          evidence: '旧客户优惠99元，请用英文',
          request_id: randomUUID(),
        },
      ],
    } as WorkflowConfig,
  };
}
function fieldState(
  value: AgentTaskSlot['value'] = 0,
  status: AgentTaskSlot['status'] = 'provided',
) {
  return buildAgentTaskState(ctx, {
    entry: 'attribute',
    task: 'company_attribute',
    phase: 'ready',
    revision: 1,
    scope: { kind: 'field', digest: scopeDigest, customer_id: customer },
    slots: [
      {
        name: 'field_value',
        status,
        value,
        source: status === 'missing' ? null : { kind: 'entry_input', version: 1 },
        version: 1,
        applicability: { scope_digest: scopeDigest, generation: null },
      },
    ],
  });
}
const dep: AgentTaskDependency = {
  kind: 'record',
  id: randomUUID(),
  revision: 0,
  hash: agentTaskStateDigest('source'),
  status: 'current',
};
const current = { ...ctx, scopeDigest };

describe('unified server-owned task state', () => {
  it('projects workflow identity, phase, generation and slot provenance without copying source text', () => {
    const row = workflow();
    const state = workflowAgentTaskState(ctx, row, { scopeDigest, runId: identity.run_id });
    expect(state).toMatchObject({
      version: 'crm-task-state-v1',
      entry: 'home_workflow',
      task: 'compose',
      identity: { workspace_id: ctx.workspaceId, actor_id: ctx.actorId, ...identity },
      scope: { customer_id: customer, generation },
      phase: 'ready',
      revision: 3,
    });
    expect(state.slots[0]).toMatchObject({
      name: 'language',
      value: 'en',
      source: { kind: 'user_message', request_id: row.config.task_slots![0].request_id },
      version: 3,
      applicability: { scope_digest: scopeDigest, generation },
    });
    const serialized = JSON.stringify(state);
    for (const text of [
      '不可复制的业务全文',
      '不可复制的完整任务指令',
      '旧客户优惠99元',
      'evidence"',
    ])
      expect(serialized).not.toContain(text);
    expect(
      checkAgentTaskState(state, {
        ...current,
        generation,
        workflowId: row.id,
        revision: row.version,
      }),
    ).toEqual({ valid: true, reasons: [] });
  });

  it.each([0, false, '', null] as const)(
    'preserves provided scalar %j instead of treating it as absent',
    (value) => {
      const state = fieldState(value);
      expect(state.slots[0]).toMatchObject({ status: 'provided', value });
      expect(checkAgentTaskState(state, current).valid).toBe(true);
      expect(agentTaskStateDigest(state)).not.toBe(
        agentTaskStateDigest(fieldState(null, 'missing')),
      );
    },
  );

  it('distinguishes missing, explicitly cleared and provided null', () => {
    const states = ['missing', 'cleared', 'provided'].map((status) =>
      fieldState(null, status as AgentTaskSlot['status']),
    );
    expect(new Set(states.map(agentTaskStateDigest)).size).toBe(3);
    expect(() => fieldState(false, 'cleared')).toThrow();
    expect(() => agentTaskSlotSchema.parse({ ...fieldState().slots[0], source: null })).toThrow();
  });

  it('expresses six entries without manufacturing a customer or conversation for collection and button tasks', () => {
    const states = [
      buildAgentTaskState(ctx, {
        entry: 'home',
        task: 'home_chat',
        scope: { kind: 'directory', digest: scopeDigest },
        phase: 'ready',
        revision: 1,
      }),
      buildAgentTaskState(ctx, {
        entry: 'page_ask',
        task: 'page_question',
        scope: { kind: 'records', digest: scopeDigest },
        phase: 'ready',
        revision: 1,
      }),
      workflowAgentTaskState(ctx, workflow(), { scopeDigest }),
      fieldState(false),
      buildAgentTaskState(ctx, {
        entry: 'document',
        task: 'document_question',
        scope: { kind: 'document', digest: scopeDigest, customer_id: customer },
        phase: 'ready',
        revision: 1,
      }),
      buildAgentTaskState(ctx, {
        entry: 'activity',
        task: 'generate_activities',
        scope: { kind: 'activity', digest: scopeDigest, customer_id: customer },
        phase: 'ready',
        revision: 1,
      }),
    ];
    expect(new Set(states.map((s) => s.entry)).size).toBe(6);
    for (const state of [states[0], states[1]]) expect(state.scope.customer_id).toBeNull();
    for (const state of states.slice(3))
      expect(state.identity).toMatchObject({ chat_id: null, workflow_id: null, run_id: null });
  });

  it('keeps no-template distinct from an unprovided or selected template', () => {
    const row = workflow();
    expect(
      workflowAgentTaskState(ctx, row, { scopeDigest }).slots.some(
        (s) => s.name === 'template_choice',
      ),
    ).toBe(false);
    row.config.template_choice = { kind: 'none' };
    expect(
      workflowAgentTaskState(ctx, row, { scopeDigest }).slots.find(
        (s) => s.name === 'template_choice',
      ),
    ).toMatchObject({
      status: 'provided',
      value: 'none',
      source: { kind: 'workflow_config', version: 3 },
    });
    row.config.template_choice = { kind: 'saved', id: randomUUID() };
    expect(
      workflowAgentTaskState(ctx, row, { scopeDigest }).slots.find(
        (s) => s.name === 'template_choice',
      )?.value,
    ).toBe('selected');
  });

  it('binds results to the scope and separate source digest and requires a current source recheck', () => {
    const row = workflow();
    row.result_digest = agentTaskStateDigest('actual snapshot');
    row.result = { message_id: randomUUID(), body: '不可复制的模型全文' } as WorkflowResult;
    row.draft_id = randomUUID();
    const state = workflowAgentTaskState(ctx, row, { scopeDigest });
    expect(state.result).toMatchObject({
      message_id: row.result.message_id,
      draft_id: row.draft_id,
      scope_digest: scopeDigest,
      source_digest: row.result_digest,
    });
    expect(JSON.stringify(state)).not.toContain(row.result.body);
    expect(checkAgentTaskState(state, current).reasons).toContain('dependency_unverified');
    expect(checkAgentTaskState(state, { ...current, sourceDigest: row.result_digest }).valid).toBe(
      true,
    );
    expect(
      checkAgentTaskState(state, {
        ...current,
        sourceDigest: agentTaskStateDigest('changed source'),
      }).reasons,
    ).toContain('result_stale');
  });

  it('stops treating cancelled workflow results as usable while preserving authoritative rows', () => {
    const row = {
      ...workflow(),
      step: 'cancelled' as const,
      result_digest: scopeDigest,
      result: { message_id: randomUUID(), body: '旧结果' } as WorkflowResult,
    };
    const state = workflowAgentTaskState(ctx, row, { scopeDigest });
    expect(state.result).toBeNull();
    expect(state.slots).toEqual([]);
    expect(row.config.task_slots).toHaveLength(1);
    expect(state.cancellation.status).toBe('cancelled');
    expect(row.result.body).toBe('旧结果');
    expect(checkAgentTaskState(state, current).reasons).toContain('cancelled');
    expect(checkAgentTaskState(fieldState(), { ...current, cancelled: true }).reasons).toContain(
      'cancelled',
    );
    expect(
      agentTaskStateSchema.safeParse({
        ...fieldState(),
        cancellation: { status: 'requested', request_id: randomUUID() },
      }).success,
    ).toBe(false);
  });

  it('detects identity, scope, revision and generation changes including old slot applicability', () => {
    const state = workflowAgentTaskState(ctx, workflow(), { scopeDigest });
    expect(checkAgentTaskState(state, { ...current, actorId: randomUUID() }).reasons).toContain(
      'identity_changed',
    );
    expect(checkAgentTaskState(state, { ...current, workspaceId: randomUUID() }).reasons).toContain(
      'identity_changed',
    );
    expect(checkAgentTaskState(state, { ...current, chatId: randomUUID() }).reasons).toContain(
      'identity_changed',
    );
    expect(checkAgentTaskState(state, { ...current, task: 'reply' }).reasons).toContain(
      'identity_changed',
    );
    expect(
      checkAgentTaskState(state, { ...current, scopeDigest: agentTaskStateDigest('new') }).reasons,
    ).toContain('scope_changed');
    expect(checkAgentTaskState(state, { ...current, generation: randomUUID() }).reasons).toContain(
      'generation_changed',
    );
    expect(checkAgentTaskState(state, { ...current, revision: 4 }).reasons).toContain(
      'generation_changed',
    );
    state.slots[0].applicability.scope_digest = agentTaskStateDigest('previous customer');
    expect(checkAgentTaskState(state, current).reasons).toContain('slot_scope_changed');
  });

  it('requires freshly checked dependencies and rejects revision/hash changes, invalid and unknown sources', () => {
    const state = fieldState();
    state.dependencies = [dep];
    expect(checkAgentTaskState(state, current).reasons).toContain('dependency_unverified');
    expect(checkAgentTaskState(state, { ...current, dependencies: [dep] }).valid).toBe(true);
    for (const changed of [
      { ...dep, revision: 1 },
      { ...dep, hash: agentTaskStateDigest('new') },
      { ...dep, status: 'invalid' as const },
      { ...dep, status: 'unknown' as const },
    ]) {
      expect(checkAgentTaskState(state, { ...current, dependencies: [changed] }).valid).toBe(false);
    }
    expect(() => agentTaskDependencyDigest([{ ...dep, revision: null, hash: null }])).toThrow();
  });

  it('hashes dependency sets independent of input order and preserves zero revisions', () => {
    const second = { ...dep, id: randomUUID(), revision: 2 };
    expect(agentTaskDependencyDigest([dep, second])).toBe(agentTaskDependencyDigest([second, dep]));
    expect(agentTaskDependencyDigest([dep])).not.toBe(
      agentTaskDependencyDigest([{ ...dep, revision: null }]),
    );
  });

  it('rejects cross-actor workflow projections before they can be given a new identity', () => {
    expect(() =>
      workflowAgentTaskState(ctx, { ...workflow(), actor_id: randomUUID() }, { scopeDigest }),
    ).toThrow('任务身份');
    expect(() =>
      workflowAgentTaskState(ctx, { ...workflow(), workspace_id: randomUUID() }, { scopeDigest }),
    ).toThrow('任务身份');
  });

  it('rejects forged approval/identity slots, wrong entry tasks, invalid scope and unexpected data', () => {
    const state = fieldState();
    for (const name of ['actor_id', 'customer_id', 'approved', 'send_at', 'recipient', 'to'])
      expect(
        agentTaskStateSchema.safeParse({ ...state, slots: [{ ...state.slots[0], name }] }).success,
      ).toBe(false);
    for (const value of [
      { ...state, entry: 'home' },
      { ...state, scope: { ...state.scope, customer_id: null } },
      { ...state, identity: { ...state.identity, chat_id: randomUUID() } },
      { ...state, confirmed: true },
      { ...state, slots: [{ ...state.slots[0], evidence: '不允许的原始全文' }] },
      { ...state, slots: [{ ...state.slots[0], name: 'language', value: 'en' }] },
      { ...state, slots: [state.slots[0], state.slots[0]] },
      { ...state, dependencies: [dep, dep] },
      {
        ...state,
        result: {
          message_id: null,
          draft_id: null,
          scope_digest: scopeDigest,
          source_digest: null,
          dependency_digest: agentTaskDependencyDigest([]),
          generation: null,
        },
        cancellation: { status: 'requested', request_id: randomUUID() },
      },
    ])
      expect(agentTaskStateSchema.safeParse(value).success).toBe(false);
  });
});
