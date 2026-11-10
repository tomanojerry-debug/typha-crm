import { outgoingLabels, type OutgoingMail } from '../shared/outgoing';

export interface WorkflowMailScope {
  workspace: string;
  actorKey: string;
  workflowId: string;
  draftId: string;
  customerId: string;
  personId: string | null;
}

export type WorkflowMailReadState =
  | { phase: 'loading'; mail: null; error: '' }
  | { phase: 'ready'; mail: OutgoingMail; error: '' }
  | { phase: 'error' | 'unavailable'; mail: null; error: string };

export function workflowMailScopeKey(scope: WorkflowMailScope) {
  return JSON.stringify([
    scope.workspace,
    scope.actorKey,
    scope.workflowId,
    scope.draftId,
    scope.customerId,
    scope.personId,
  ]);
}

class MailScopeMismatch extends Error {}

/** A read response is only usable for the exact currently displayed mail scope. */
export function validateWorkflowMailResponse(scope: WorkflowMailScope, mail: OutgoingMail) {
  if (
    !mail ||
    mail.id !== scope.draftId ||
    mail.workspace_id !== scope.workspace ||
    mail.customer_id !== scope.customerId ||
    mail.person_id !== scope.personId ||
    !Number.isInteger(mail.version) ||
    mail.version < 1 ||
    !Object.hasOwn(outgoingLabels, mail.status) ||
    typeof mail.subject !== 'string' ||
    typeof mail.body !== 'string' ||
    !Array.isArray(mail.to) ||
    mail.to.some((value) => typeof value !== 'string')
  )
    throw new MailScopeMismatch('发件记录与当前任务不一致');
  return mail;
}

/** A scoped, read-only monitor. It never creates, confirms, schedules or sends mail. */
export function createWorkflowMailMonitor({
  scope,
  read,
  onState,
  intervalMs = 2000,
}: {
  scope: WorkflowMailScope;
  read: (scope: WorkflowMailScope, signal: AbortSignal) => Promise<OutgoingMail>;
  onState: (state: WorkflowMailReadState) => void;
  intervalMs?: number;
}) {
  const identity = { ...scope };
  let disposed = false;
  let visible = true;
  let state: WorkflowMailReadState = { phase: 'loading', mail: null, error: '' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let pending: Promise<void> | null = null;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const publish = (next: WorkflowMailReadState) => {
    if (disposed) return;
    state = next;
    onState(next);
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    clearTimer();
    if (pending) return pending;
    controller = new AbortController();
    const signal = controller.signal;
    pending = Promise.resolve()
      .then(() => {
        if (disposed || signal.aborted) throw new DOMException('页面已离开', 'AbortError');
        return read(identity, signal);
      })
      .then((mail) => {
        if (disposed || signal.aborted) return;
        publish({ phase: 'ready', mail: validateWorkflowMailResponse(identity, mail), error: '' });
      })
      .catch((error: unknown) => {
        if (disposed || signal.aborted) return;
        const status =
          error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        const unavailable =
          error instanceof MailScopeMismatch || [401, 403, 404, 409].includes(Number(status));
        publish({
          phase: unavailable ? 'unavailable' : 'error',
          mail: null,
          error: unavailable
            ? '邮件已失效或无权访问，请重新核对当前任务。'
            : '暂时无法核对发件状态，请重试核对，避免重复发送。',
        });
      })
      .finally(() => {
        pending = null;
        controller = null;
        if (!disposed && visible && state.phase !== 'unavailable')
          timer = setTimeout(() => void refresh(), intervalMs);
      });
    return pending;
  };
  return {
    refresh,
    setVisible(next: boolean) {
      visible = next;
      if (!visible) clearTimer();
      else void refresh();
    },
    dispose() {
      disposed = true;
      clearTimer();
      controller?.abort();
    },
  };
}
