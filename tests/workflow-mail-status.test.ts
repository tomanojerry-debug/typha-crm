import { afterEach, expect, it, vi } from 'vitest';
import type { OutgoingMail, OutgoingStatus } from '../shared/outgoing.js';
import {
  createWorkflowMailMonitor,
  workflowMailScopeKey,
  type WorkflowMailReadState,
  type WorkflowMailScope,
} from '../src/workflow-mail-status.js';

const scope: WorkflowMailScope = {
  workspace: 'workspace-a',
  actorKey: 'workspace-a:actor-a',
  workflowId: 'workflow-a',
  draftId: 'mail-a',
  customerId: 'customer-a',
  personId: 'person-a',
};
const mail = (status: OutgoingStatus, version = 1) =>
  ({
    id: scope.draftId,
    workspace_id: scope.workspace,
    customer_id: scope.customerId,
    person_id: scope.personId,
    created_by: 'actor-a',
    version,
    status,
    subject: `实际邮件v${version}`,
    body: `已保存正文v${version}`,
    to: ['recipient@fixture.invalid'],
  }) as OutgoingMail;

afterEach(() => vi.useRealTimers());

it('reads background transitions and same-mail edits without creating or sending anything', async () => {
  vi.useFakeTimers();
  const statuses: OutgoingStatus[] = [
    'draft',
    'approved',
    'scheduled',
    'sending',
    'submitted',
    'sent_confirmed',
  ];
  const states: WorkflowMailReadState[] = [];
  const read = vi.fn(async (_scope: WorkflowMailScope, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    const index = states.length;
    return mail(statuses[index], index ? 2 : 1);
  });
  const monitor = createWorkflowMailMonitor({
    scope,
    read,
    onState: (state) => states.push(state),
  });
  await monitor.refresh();
  for (let i = 1; i < statuses.length; i++) await vi.advanceTimersByTimeAsync(2000);
  expect(states.map((state) => state.phase === 'ready' && state.mail.status)).toEqual(statuses);
  expect(states.at(-1)?.mail?.version).toBe(2);
  expect(read).toHaveBeenCalledTimes(statuses.length);
  monitor.dispose();
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(statuses.length);
});

it('clears old mail on connection failure and refreshes after service recovery', async () => {
  vi.useFakeTimers();
  const states: WorkflowMailReadState[] = [];
  let attempt = 0;
  const monitor = createWorkflowMailMonitor({
    scope,
    read: async () => {
      attempt++;
      if (attempt === 2) throw new TypeError('Failed to fetch');
      return mail(attempt === 1 ? 'scheduled' : 'submitted');
    },
    onState: (state) => states.push(state),
  });
  await monitor.refresh();
  await vi.advanceTimersByTimeAsync(2000);
  expect(states.at(-1)).toMatchObject({ phase: 'error', mail: null });
  expect(states.at(-1)?.error).toContain('核对发件状态');
  await vi.advanceTimersByTimeAsync(2000);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', mail: { status: 'submitted' } });
  monitor.dispose();
});

it('continues revalidating a confirmed sent record and removes it on permission loss', async () => {
  vi.useFakeTimers();
  const states: WorkflowMailReadState[] = [];
  const read = vi
    .fn()
    .mockResolvedValueOnce(mail('sent_confirmed'))
    .mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 404 }))
    .mockResolvedValue(mail('sent_confirmed'));
  const monitor = createWorkflowMailMonitor({
    scope,
    read,
    onState: (state) => states.push(state),
  });
  await monitor.refresh();
  await vi.advanceTimersByTimeAsync(2000);
  expect(states.at(-1)).toMatchObject({ phase: 'unavailable', mail: null });
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(2);
  await monitor.refresh();
  expect(states.at(-1)?.mail?.status).toBe('sent_confirmed');
  monitor.dispose();
});

it('aborts and ignores late responses after leaving the actor/workspace/draft scope', async () => {
  const oldStates: WorkflowMailReadState[] = [];
  let resolveOld!: (mail: OutgoingMail) => void;
  let requestSignal: AbortSignal | undefined;
  const old = createWorkflowMailMonitor({
    scope,
    read: async (_scope, signal) => {
      requestSignal = signal;
      return new Promise<OutgoingMail>((resolve) => {
        resolveOld = resolve;
      });
    },
    onState: (state) => oldStates.push(state),
  });
  const pending = old.refresh();
  await Promise.resolve();
  old.dispose();
  expect(requestSignal?.aborted).toBe(true);
  const nextScope = { ...scope, workspace: 'workspace-b', actorKey: 'workspace-b:actor-b' };
  const nextStates: WorkflowMailReadState[] = [];
  const next = createWorkflowMailMonitor({
    scope: nextScope,
    read: async () => ({ ...mail('draft'), workspace_id: nextScope.workspace }),
    onState: (state) => nextStates.push(state),
  });
  await next.refresh();
  resolveOld(mail('submitted'));
  await pending;
  expect(oldStates).toEqual([]);
  expect(nextStates.at(-1)?.mail?.workspace_id).toBe('workspace-b');
  expect(workflowMailScopeKey(scope)).not.toBe(workflowMailScopeKey(nextScope));
  expect(workflowMailScopeKey(scope)).not.toBe(
    workflowMailScopeKey({ ...scope, actorKey: 'workspace-a:actor-b' }),
  );
  expect(workflowMailScopeKey(scope)).not.toBe(
    workflowMailScopeKey({ ...scope, draftId: 'mail-b' }),
  );
  next.dispose();
});

it('refuses a successful response for another customer, mail, person or workspace', async () => {
  for (const patch of [
    { workspace_id: 'foreign-workspace' },
    { customer_id: 'foreign-customer' },
    { person_id: 'foreign-person' },
    { id: 'other-mail' },
    { status: 'unknown-status' },
  ]) {
    const states: WorkflowMailReadState[] = [];
    const monitor = createWorkflowMailMonitor({
      scope,
      read: async () => ({ ...mail('submitted'), ...patch }) as OutgoingMail,
      onState: (state) => states.push(state),
    });
    await monitor.refresh();
    expect(states).toMatchObject([{ phase: 'unavailable', mail: null }]);
    monitor.dispose();
  }
});

it('pauses background polling and immediately rechecks when the page becomes visible', async () => {
  vi.useFakeTimers();
  const states: WorkflowMailReadState[] = [];
  const read = vi.fn(async () => mail(states.length ? 'submitted' : 'scheduled'));
  const monitor = createWorkflowMailMonitor({
    scope,
    read,
    onState: (state) => states.push(state),
  });
  await monitor.refresh();
  monitor.setVisible(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(1);
  monitor.setVisible(true);
  await monitor.refresh();
  expect(read).toHaveBeenCalledTimes(2);
  expect(states.at(-1)?.mail?.status).toBe('submitted');
  monitor.dispose();
});
