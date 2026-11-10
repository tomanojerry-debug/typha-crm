import type { AgentRun, AgentRunEvent, AgentRunResult } from '../shared/agent-runs';
import { activeAgentRun } from '../shared/agent-runs';
import type { Chat } from '../shared/chat';
import { api, HttpError, watchApi } from './api';

type Activity = { chat: Chat; result?: AgentRunResult };
const listeners = new Map<string, Set<(activity: Activity) => void>>();
const submissions = new Map<string, { fingerprint: string; promise: Promise<AgentRunResult> }>();

export function agentRunOwner(workspace: string, actor: string) {
  return `${workspace}:${actor}`;
}

export function onAgentActivity(owner: string, listener: (activity: Activity) => void) {
  const group = listeners.get(owner) || new Set();
  group.add(listener);
  listeners.set(owner, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(owner);
  };
}

export function publishAgentActivity(owner: string, chat: Chat, result?: AgentRunResult) {
  for (const listener of listeners.get(owner) || []) listener({ chat, result });
}

// Keep the short acceptance request alive across page unmounts. The server owns
// execution after acceptance, and serializes requests for an individual chat.
export function submitAgentRun(
  owner: string,
  workspace: string,
  chat: Pick<Chat, 'id'>,
  path: string,
  body: unknown,
  receipt?: {
    ref: { current: { fingerprint: string; id: string } | null };
    id: string;
  },
) {
  const key = `${owner}:${chat.id}`;
  const fingerprint = JSON.stringify({ path, body });
  const existing = submissions.get(key);
  if (existing)
    return existing.fingerprint === fingerprint
      ? existing.promise
      : Promise.reject(new HttpError('当前消息正在提交，请稍后再发送', 409));
  const promise = api<AgentRunResult>(path, { workspace, method: 'POST', body, keepalive: true })
    .then((result) => {
      // A repeated phrase after acceptance is a new turn. Keep the old identity
      // only while acceptance is uncertain, without clearing a newer submission.
      if (receipt && receipt.ref.current?.id === receipt.id) receipt.ref.current = null;
      publishAgentActivity(owner, result.detail.chat, result);
      return result;
    })
    .finally(() => {
      if (submissions.get(key)?.promise === promise) submissions.delete(key);
    });
  submissions.set(key, { fingerprint, promise });
  return promise;
}

export function runFailure(run: AgentRun) {
  return (
    run.error ||
    (run.status === 'cancelled'
      ? '本次回复已停止'
      : run.status === 'interrupted'
        ? '服务重启，本次回复已中断，请重试'
        : '本次回复失败，请重试')
  );
}

function reconnectDelay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException('已离开对话', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, 1500);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

export async function observeAgentRun(options: {
  owner: string;
  workspace: string;
  run: AgentRun;
  signal: AbortSignal;
  onRun(run: AgentRun): void;
  onDone(result: AgentRunResult): void;
  onReconnect?(reconnecting: boolean): void;
}) {
  const { owner, workspace, signal } = options;
  const path = `/chats/${options.run.chat_id}/runs/${options.run.id}`;
  let current = options.run;
  while (!signal.aborted && activeAgentRun(current)) {
    try {
      await watchApi<AgentRunEvent>(`${path}/events`, {
        workspace,
        signal,
        onEvent(event) {
          options.onReconnect?.(false);
          if (event.type === 'error') throw new HttpError(event.error, event.status);
          if (event.type === 'run') {
            if (event.run.revision < current.revision) return;
            current = event.run;
            // Keep the observer mounted until the final authorized detail arrives.
            if (activeAgentRun(current)) options.onRun(current);
          } else {
            current = event.result.run;
            publishAgentActivity(owner, event.result.detail.chat, event.result);
            options.onDone(event.result);
            return false;
          }
        },
      });
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof HttpError && [401, 403, 404].includes(e.status)) throw e;
      options.onReconnect?.(true);
      await reconnectDelay(signal);
      try {
        const result = await api<AgentRunResult>(path, { workspace, signal });
        current = result.run;
        if (!activeAgentRun(current)) {
          publishAgentActivity(owner, result.detail.chat, result);
          options.onDone(result);
          return;
        }
        options.onRun(current);
      } catch (snapshotError) {
        if (signal.aborted) return;
        if (snapshotError instanceof HttpError && [401, 403, 404].includes(snapshotError.status))
          throw snapshotError;
      }
    }
  }
}
