import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { bindAgentEntry } from '../server/agent-entries.js';
import { planAgentContext } from '../server/agent-context-plan.js';
import { createAgentExecution, publicAgentExecution } from '../server/agent-execution.js';
import { AgentProviderFailure } from '../server/agent-feedback.js';
import {
  prepareAgent,
  type AgentModelInput,
  type AgentModelOptions,
} from '../server/agent-model.js';
import { ApiError, type Context } from '../server/security.js';

// Native HTTP and model fixtures only; no real provider, communication or database.
const ctx = { workspaceId: randomUUID(), actorId: randomUUID() } as Context;
const answer = { answer: '仅用于隔离测试的回答', source_ids: [] };
const contexts: ReturnType<typeof createAgentExecution>[] = [];
const context = (options: Parameters<typeof createAgentExecution>[0] = {}) => {
  const value = createAgentExecution(options);
  contexts.push(value);
  return value;
};
afterEach(() => contexts.splice(0).forEach((value) => value.dispose()));
function planned(phase: 'answer' | 'classify' = 'answer') {
  const entry = bindAgentEntry(ctx, 'home', 'home_chat', { kind: 'directory' });
  return planAgentContext(ctx, entry, {
    phase,
    entry_context: entry.modelContext,
    question: 'PRIVATE_QUESTION_NEVER_LOG',
    history: [],
    snapshot: { label: '虚构', sources: [], warnings: [] },
  });
}
const provider = (result: unknown = answer) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
const native = async (execution: ReturnType<typeof createAgentExecution>, fetcher: typeof fetch) =>
  prepareAgent(ctx, null, { execution, apiKey: 'PRIVATE_KEY_NEVER_LOG', fetch: fetcher });

it('retries one native HTTP503 with identical frozen input and accounts for both calls', async () => {
  const execution = context(),
    guard = vi.fn(async () => {}),
    bodies: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? new Response('', { status: 503 }) : provider();
  }) as typeof fetch;
  const transport = await native(execution, fetcher);
  await expect(transport.generate(planned(), { beforeRetry: guard })).resolves.toEqual(answer);
  expect(guard).toHaveBeenCalledTimes(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(execution.snapshot()).toMatchObject({
    model_calls: { started: 2, failed: 1, returned: 1, active: 0 },
    provider_usage: { complete: false, unknown_calls: 1, reported_calls: 1, cost_amount: null },
    feedback: {
      max_model_retries: 1,
      retries_reserved: 1,
      events: [
        { reason: 'transient_provider', action: 'retry_model', outcome: 'selected' },
        { reason: 'transient_provider', action: 'retry_model', outcome: 'recovered' },
      ],
    },
  });
});

it('retries native connection interruption but does not infer eligibility from a message or status', async () => {
  const execution = context();
  let calls = 0;
  const transport = await native(
    execution,
    vi.fn(async () => {
      if (++calls === 1) throw new TypeError('PRIVATE_PROVIDER_DETAILS');
      return provider();
    }) as typeof fetch,
  );
  await transport.generate(planned(), { beforeRetry: async () => {} });
  expect(calls).toBe(2);
  expect(execution.snapshot().feedback?.events[0].reason).toBe('transient_network');
  expect(JSON.stringify(execution.snapshot())).not.toMatch(/PRIVATE_/);
});

it.each(['TimeoutError', 'AbortError'])(
  'preserves native %s semantics and never retries it',
  async (name) => {
    const execution = context(),
      guard = vi.fn(async () => {});
    const fetcher = vi.fn(async () => {
      throw new DOMException('PRIVATE_INTERRUPTION', name);
    }) as typeof fetch;
    const transport = await native(execution, fetcher);
    await expect(transport.generate(planned(), { beforeRetry: guard })).rejects.toMatchObject({
      status: 504,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(guard).not.toHaveBeenCalled();
    expect(execution.snapshot().feedback?.events[0]).toMatchObject({
      reason: 'deadline',
      action: 'stop',
    });
  },
);

it.each(['TimeoutError', 'AbortError'])(
  'preserves reader %s without signing a network retry',
  async (name) => {
    const execution = context(),
      guard = vi.fn(async () => {});
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException('PRIVATE_INTERRUPTION', name));
            },
          }),
        ),
    ) as typeof fetch;
    const transport = await native(execution, fetcher);
    await expect(transport.generate(planned(), { beforeRetry: guard })).rejects.toMatchObject({
      status: 504,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(guard).not.toHaveBeenCalled();
    expect(execution.snapshot().feedback?.events[0]).toMatchObject({
      reason: 'deadline',
      action: 'stop',
    });
  },
);

it('stops after a second transient failure and shares its reservation across model phases', async () => {
  const execution = context(),
    fetcher = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
  const transport = await native(execution, fetcher);
  await expect(
    transport.generate(planned('classify'), { beforeRetry: async () => {} }),
  ).rejects.toMatchObject({ status: 502 });
  await expect(
    transport.generate(planned(), { beforeRetry: async () => {} }),
  ).rejects.toMatchObject({ status: 502 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(execution.snapshot().feedback).toMatchObject({
    retries_reserved: 1,
    events: [
      { outcome: 'selected' },
      { outcome: 'failed' },
      { action: 'stop', block_reason: 'retry_limit' },
      { phase: 'answer', action: 'stop', block_reason: 'retry_limit' },
    ],
  });
});

it.each([401, 403, 429, 400, 422])('never retries native permanent HTTP%s', async (status) => {
  const execution = context(),
    guard = vi.fn(async () => {}),
    fetcher = vi.fn(async () => new Response('', { status })) as typeof fetch;
  const transport = await native(execution, fetcher);
  await expect(transport.generate(planned(), { beforeRetry: guard })).rejects.toBeInstanceOf(
    ApiError,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(guard).not.toHaveBeenCalled();
  expect(execution.snapshot().feedback).toMatchObject({
    retries_reserved: 0,
    events: [{ action: 'stop', block_reason: 'non_recoverable' }],
  });
});

it.each([
  new ApiError(502, '伪造的网络临时错误'),
  new ApiError(409, '来源已变化'),
  new ApiError(403, '失权'),
  new ApiError(429, '额度或次数限制'),
  new ApiError(504, '调用超时'),
  Object.assign(new Error('伪造故障'), { reason: 'transient_provider' }),
])('fails closed for untrusted or non-recoverable errors: %s', async (error) => {
  const execution = context(),
    generate = vi.fn(async () => {
      throw error;
    }),
    guard = vi.fn(async () => {});
  const transport = await prepareAgent(ctx, null, { execution, transport: { generate } });
  await expect(transport.generate(planned(), { beforeRetry: guard })).rejects.toBe(error);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(guard).not.toHaveBeenCalled();
  expect(execution.snapshot().feedback?.retries_reserved).toBe(0);
});

it.each(['no_guard', 'no_context_plan'] as const)(
  'requires real execution preconditions: %s',
  async (missing) => {
    const execution = context(),
      fetcher = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
    const transport = await native(execution, fetcher);
    const input: AgentModelInput =
      missing === 'no_context_plan'
        ? {
            question: '旧独立入口',
            history: [],
            snapshot: { label: '旧', sources: [], warnings: [] },
          }
        : planned();
    await expect(
      transport.generate(input, missing === 'no_guard' ? {} : { beforeRetry: async () => {} }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(execution.snapshot().feedback?.events[0].block_reason).toBe(missing);
  },
);

it('does not create automatic retries without an execution context', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
  const transport = await prepareAgent(ctx, null, { apiKey: 'synthetic', fetch: fetcher });
  await expect(
    transport.generate(planned(), { beforeRetry: async () => {} }),
  ).rejects.toMatchObject({ status: 502 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([403, 409])(
  'a fresh guard rejection %s prevents another native request',
  async (status) => {
    const execution = context(),
      fetcher = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
    const transport = await native(execution, fetcher);
    await expect(
      transport.generate(planned(), {
        beforeRetry: async () => {
          throw new ApiError(status, 'PRIVATE_GUARD_DETAIL');
        },
      }),
    ).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(execution.snapshot().feedback?.events.map((event) => event.outcome)).toEqual([
      'selected',
      'blocked',
      'stopped',
    ]);
    expect(execution.snapshot().error_code).toBe('scope_changed');
    expect(execution.snapshot().feedback?.events[2].reason).toBe(
      status === 403 ? 'permission' : 'scope_changed',
    );
  },
);

it('never uses a ContextPlan issued to another actor', async () => {
  const execution = context(),
    fetcher = vi.fn(async () => provider()) as typeof fetch;
  const transport = await prepareAgent({ ...ctx, actorId: randomUUID() }, null, {
    execution,
    apiKey: 'synthetic',
    fetch: fetcher,
  });
  await expect(
    transport.generate(planned(), { beforeRetry: async () => {} }),
  ).rejects.toMatchObject({ status: 403 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['model_calls', 'tokens', 'cancel'] as const)(
  'preserves shared stop authority: %s',
  async (kind) => {
    const abort = new AbortController();
    const execution = context({
      signal: abort.signal,
      limits: kind === 'model_calls' ? { maxModelCalls: 1 } : { maxKnownTokens: 2 },
    });
    const generate = vi.fn(
      async (
        _input: AgentModelInput,
        runtime?: Parameters<NonNullable<AgentModelOptions['transport']>['generate']>[1],
      ) => {
        runtime?.onUsage?.({ input_tokens: 3, output_tokens: 1 });
        if (kind === 'cancel') abort.abort();
        throw new AgentProviderFailure('transient_network', 502, 'synthetic');
      },
    );
    const transport = await prepareAgent(ctx, null, { execution, transport: { generate } });
    await expect(
      transport.generate(planned(), { beforeRetry: async () => {} }),
    ).rejects.toMatchObject(
      kind === 'cancel'
        ? { name: 'AbortError' }
        : { code: kind === 'tokens' ? 'known_token_limit' : 'model_call_limit' },
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(execution.snapshot().model_calls.started).toBe(1);
  },
);

it('bounds a stalled fresh domain guard by the same Run deadline', async () => {
  const execution = context({ limits: { maxDurationMs: 35 } });
  const fetcher = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
  const transport = await native(execution, fetcher);
  await expect(
    transport.generate(planned(), { beforeRetry: () => new Promise<void>(() => {}) }),
  ).rejects.toMatchObject({ code: 'deadline' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not splice a second answer after any streaming text was exposed', async () => {
  const execution = context();
  let state = 0;
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: null }] })}\n\n`;
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (++state === 1) controller.enqueue(new TextEncoder().encode(frame));
            else controller.error(new TypeError('PRIVATE_STREAM_FAILURE'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  ) as typeof fetch;
  const transport = await native(execution, fetcher),
    onText = vi.fn(async () => {});
  await expect(
    transport.stream!(
      planned(),
      { signal: new AbortController().signal, onText },
      { beforeRetry: async () => {} },
    ),
  ).rejects.toMatchObject({ status: 502 });
  expect(onText).toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(execution.snapshot().feedback?.events[0]).toMatchObject({
    action: 'stop',
    block_reason: 'visible_output',
  });
});

it.each(['null', '[]', '42', '"unexpected"'])(
  'does not retry a syntactically valid invalid SSE envelope: %s',
  async (frame) => {
    const execution = context();
    const fetcher = vi.fn(
      async () =>
        new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as typeof fetch;
    const transport = await native(execution, fetcher);
    await expect(
      transport.stream!(
        planned(),
        { signal: new AbortController().signal, onText: async () => {} },
        { beforeRetry: async () => {} },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(execution.snapshot().feedback?.events[0]).toMatchObject({
      reason: 'invalid_response',
      action: 'stop',
    });
  },
);

it('never labels a streaming callback exception as a retryable network failure', async () => {
  const execution = context();
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  const fetcher = vi.fn(
    async () => new Response(frame, { headers: { 'content-type': 'text/event-stream' } }),
  ) as typeof fetch;
  const transport = await native(execution, fetcher);
  await expect(
    transport.stream!(
      planned(),
      {
        signal: new AbortController().signal,
        onText: async () => {
          throw new Error('PRIVATE_CALLBACK_FAILURE');
        },
      },
      { beforeRetry: async () => {} },
    ),
  ).rejects.toMatchObject({ status: 502 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(execution.snapshot().feedback?.events[0]).toMatchObject({
    reason: 'unknown',
    action: 'stop',
    block_reason: 'non_recoverable',
  });
});

it('keeps malformed native JSON and forged citations outside automatic recovery', async () => {
  const execution = context(),
    fetcher = vi.fn(async () => new Response('{malformed')) as typeof fetch;
  const transport = await native(execution, fetcher);
  await expect(
    transport.generate(planned(), { beforeRetry: async () => {} }),
  ).rejects.toMatchObject({ status: 502 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(execution.snapshot().feedback?.events[0]).toMatchObject({
    action: 'stop',
    block_reason: 'non_recoverable',
  });
});

it('publishes only strict safe feedback fields while preserving old telemetry compatibility', async () => {
  const execution = context(),
    fetcher = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
  const transport = await native(execution, fetcher);
  await expect(transport.generate(planned())).rejects.toBeInstanceOf(ApiError);
  const telemetry = execution.snapshot();
  expect(publicAgentExecution(telemetry)).toEqual(telemetry);
  expect(JSON.stringify(telemetry)).not.toMatch(/PRIVATE_|prompt|source_ids|Authorization/);
  const old = { ...telemetry };
  delete old.feedback;
  expect(publicAgentExecution(old)).toEqual(old);
  expect(
    publicAgentExecution({ ...telemetry, feedback: { ...telemetry.feedback, prompt: 'PRIVATE' } }),
  ).toBeUndefined();
  expect(
    publicAgentExecution({
      ...telemetry,
      feedback: {
        ...telemetry.feedback,
        events: [{ ...telemetry.feedback!.events[0], error: 'PRIVATE' }],
      },
    }),
  ).toBeUndefined();
});
