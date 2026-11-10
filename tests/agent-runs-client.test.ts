import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunResult } from '../shared/agent-runs';
import {
  observeAgentRun,
  onAgentActivity,
  publishAgentActivity,
  runFailure,
  submitAgentRun,
} from '../src/agent-runs-client';

const run: AgentRun = {
  id: 'run-1',
  chat_id: 'chat-1',
  request_id: 'request-1',
  kind: 'message',
  status: 'running',
  question: '测试问题',
  answer: '',
  revision: 1,
  created_at: '2026-10-27T00:00:00Z',
  updated_at: '2026-10-27T00:00:00Z',
};
function result(status: AgentRun['status'] = 'running'): AgentRunResult {
  const next = { ...run, status };
  return {
    run: next,
    detail: {
      chat: {
        id: run.chat_id,
        title: '测试',
        customer_id: null,
        customer_name: null,
        updated_at: run.updated_at,
        run_status: status,
      },
      messages: [],
      imports: [],
      run: next,
    },
  };
}
function events(...values: unknown[]) {
  return new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('background Agent run client', () => {
  it('keeps acceptance alive without a view signal, deduplicates one chat and isolates owners', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(
      (_url: string, _options: RequestInit) =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const accepted = vi.fn(),
      otherOwner = vi.fn();
    const off = onAgentActivity('workspace:actor', accepted);
    const offOther = onAgentActivity('workspace:other', otherOwner);
    const first = submitAgentRun('workspace:actor', 'workspace', { id: run.chat_id }, '/start', {});
    const duplicate = submitAgentRun(
      'workspace:actor',
      'workspace',
      { id: run.chat_id },
      '/start',
      {},
    );
    expect(first).toBe(duplicate);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('signal', expect.any(AbortSignal));
    resolve(Response.json(result()));
    await first;
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(otherOwner).not.toHaveBeenCalled();
    off();
    offOther();
  });

  it('continues from cumulative snapshots after a disconnected subscription', async () => {
    vi.useFakeTimers();
    const completed = result('completed');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        events({ type: 'run', run: { ...run, answer: '已生成', revision: 2 } }),
      )
      .mockResolvedValueOnce(Response.json(completed));
    vi.stubGlobal('fetch', fetch);
    const onRun = vi.fn(),
      onDone = vi.fn(),
      onReconnect = vi.fn();
    const task = observeAgentRun({
      owner: 'workspace:actor',
      workspace: 'workspace',
      run,
      signal: new AbortController().signal,
      onRun,
      onDone,
      onReconnect,
    });
    await vi.advanceTimersByTimeAsync(1600);
    await task;
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ answer: '已生成' }));
    expect(onReconnect).toHaveBeenCalledWith(true);
    expect(onDone).toHaveBeenCalledWith(completed);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/chats/chat-1/runs/run-1/events',
      '/api/chats/chat-1/runs/run-1',
    ]);
  });

  it('releases accepted request identities so identical text can start a new turn', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json(result()));
    vi.stubGlobal('fetch', fetch);
    const ref: { current: { fingerprint: string; id: string } | null } = {
      current: { fingerprint: '继续', id: 'first-request' },
    };
    await submitAgentRun(
      'repeat-owner',
      'workspace',
      { id: run.chat_id },
      '/start',
      { body: '继续', request_id: ref.current!.id },
      { ref, id: ref.current!.id },
    );
    expect(ref.current).toBeNull();
    ref.current = { fingerprint: '继续', id: 'second-request' };
    await submitAgentRun(
      'repeat-owner',
      'workspace',
      { id: run.chat_id },
      '/start',
      { body: '继续', request_id: ref.current.id },
      { ref, id: ref.current.id },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).request_id)).toEqual([
      'first-request',
      'second-request',
    ]);
    expect(ref.current).toBeNull();
  });

  it('preserves uncertain request identities and never clears a newer one', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
    vi.stubGlobal('fetch', fetch);
    const ref: { current: { fingerprint: string; id: string } | null } = {
      current: { fingerprint: '继续', id: 'uncertain-request' },
    };
    await expect(
      submitAgentRun(
        'receipt-owner',
        'workspace',
        { id: run.chat_id },
        '/start',
        {},
        { ref, id: 'uncertain-request' },
      ),
    ).rejects.toThrow('offline');
    expect(ref.current?.id).toBe('uncertain-request');
    const pending = submitAgentRun(
      'receipt-owner',
      'workspace',
      { id: run.chat_id },
      '/start',
      {},
      { ref, id: 'uncertain-request' },
    );
    ref.current = { fingerprint: '新问题', id: 'newer-request' };
    resolve(Response.json(result()));
    await pending;
    expect(ref.current.id).toBe('newer-request');
  });

  it('rejects different submissions in one chat instead of sharing the earlier promise', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = submitAgentRun('busy-owner', 'workspace', { id: run.chat_id }, '/start', {
      body: '第一个问题',
    });
    await expect(
      submitAgentRun('busy-owner', 'workspace', { id: run.chat_id }, '/start', {
        body: '另一个问题',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      submitAgentRun('busy-owner', 'workspace', { id: run.chat_id }, '/other', {
        body: '第一个问题',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(Response.json(result()));
    await pending;
  });

  it('uses actual UTF-8 JSON bytes to avoid keepalive rejection for large valid materials', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json(result()));
    vi.stubGlobal('fetch', fetch);
    await submitAgentRun('large-owner', 'workspace', { id: run.chat_id }, '/start', {
      body: '中'.repeat(22000),
    });
    await submitAgentRun('large-owner', 'workspace', { id: run.chat_id }, '/start', {
      body: '继续',
    });
    expect(new TextEncoder().encode(fetch.mock.calls[0][1].body).byteLength).toBeGreaterThan(65536);
    expect(fetch.mock.calls[0][1].keepalive).toBeUndefined();
    expect(fetch.mock.calls[1][1].keepalive).toBe(true);
    expect(fetch.mock.calls[0][1].signal).toBeUndefined();
  });

  it('unsubscribes on navigation without making a cancel request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('closed', 'AbortError')),
        );
      });
    });
    vi.stubGlobal('fetch', fetch);
    const onDone = vi.fn();
    const task = observeAgentRun({
      owner: 'workspace:actor',
      workspace: 'workspace',
      run,
      signal: controller.signal,
      onRun: vi.fn(),
      onDone,
    });
    controller.abort();
    await task;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('/events');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('waits for final detail when a terminal run event precedes done', async () => {
    const completed = result('completed');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          events({ type: 'run', run: completed.run }, { type: 'done', result: completed }),
        ),
    );
    const onRun = vi.fn(),
      onDone = vi.fn();
    await observeAgentRun({
      owner: 'terminal-owner',
      workspace: 'workspace',
      run,
      signal: new AbortController().signal,
      onRun,
      onDone,
    });
    expect(onRun).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(completed);
  });

  it('keeps failed questions retryable with the server error and owner-scoped activity', () => {
    expect(runFailure({ ...run, status: 'failed', error: '模型暂时不可用' })).toBe(
      '模型暂时不可用',
    );
    expect(runFailure({ ...run, status: 'cancelled' })).toBe('本次回复已停止');
    const listener = vi.fn();
    const off = onAgentActivity('current', listener);
    publishAgentActivity('previous', result().detail.chat);
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});
