import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createEvaluationEnvironment,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';
import type { AgentRunResult } from '../shared/agent-runs.js';

let env: EvaluationEnvironment;
let stall = false;
let sawAbort = false;
let started: () => void;
let startedPromise: Promise<void>;

beforeAll(async () => {
  env = await createEvaluationEnvironment({
    migrateThrough: 43,
    agent: {
      executionLimits: { maxModelCalls: 2, maxDurationMs: 2000 },
      transport: {
        async generate(input, runtime) {
          expect(runtime?.signal).toBeInstanceOf(AbortSignal);
          if (stall) {
            started();
            await new Promise<void>((_resolve, reject) => {
              const abort = () => {
                sawAbort = true;
                reject(runtime!.signal!.reason);
              };
              runtime!.signal!.addEventListener('abort', abort, { once: true });
              if (runtime!.signal!.aborted) abort();
            });
          }
          runtime?.onUsage?.({ input_tokens: 7, output_tokens: 3 });
          return input.phase === 'classify'
            ? { intent: '一般对话', target: null, missing: [], reply: '按当前范围回答。' }
            : { answer: '这是隔离夹具回答。', source_ids: [] };
        },
      },
    },
  });
}, 60000);

afterAll(async () => env?.cleanup());

async function begin() {
  const created = await env.actorFetch('boss', '/api/chats', {
    method: 'POST',
    body: { id: randomUUID(), title: '隔离执行适配验证', customer_id: null },
  });
  expect(created.status).toBe(201);
  const chat = created.body.id as string;
  const queued = await env.actorFetch('boss', `/api/chats/${chat}/runs`, {
    method: 'POST',
    body: { kind: 'message', payload: { request_id: randomUUID(), body: '帮我写一份工作提纲' } },
  });
  expect(queued.status).toBe(202);
  return { chat, run: queued.body.run.id as string };
}
async function terminal(chat: string, run: string) {
  const end = Date.now() + 3000;
  do {
    const response = await env.actorFetch('boss', `/api/chats/${chat}/runs/${run}`);
    expect(response.status).toBe(200);
    const result = response.body as AgentRunResult;
    if (!['queued', 'running', 'cancelling'].includes(result.run.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < end);
  throw new Error('Isolated execution did not terminate');
}

it('preserves server execution limits and actual usage through the evaluation adapter', async () => {
  const { chat, run } = await begin();
  const result = await terminal(chat, run);
  expect(result.run.status).toBe('completed');
  expect(result.run.execution?.limits).toMatchObject({ duration_ms: 2000, model_calls: 2 });
  expect(result.run.execution?.model_calls).toMatchObject({ started: 2, returned: 2, active: 0 });
  expect(result.run.execution?.provider_usage).toMatchObject({
    complete: true,
    input_tokens: 14,
    output_tokens: 6,
    cost_amount: null,
  });
  expect(env.fakeSubmissions).toEqual([]);
});

it('passes cancellation into a pending classifier without saving an answer', async () => {
  stall = true;
  startedPromise = new Promise<void>((resolve) => (started = resolve));
  const { chat, run } = await begin();
  await startedPromise;
  const cancelled = await env.actorFetch('boss', `/api/chats/${chat}/runs/${run}/cancel`, {
    method: 'POST',
    body: {},
  });
  expect(cancelled.status).toBe(200);
  const result = await terminal(chat, run);
  expect(result.run.status).toBe('cancelled');
  expect(sawAbort).toBe(true);
  expect(result.detail.messages).toEqual([]);
  expect(result.run.execution?.provider_usage.input_tokens).toBeNull();
  expect(env.fakeSubmissions).toEqual([]);
});
