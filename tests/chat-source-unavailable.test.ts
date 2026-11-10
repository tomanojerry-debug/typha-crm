import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ApiError, scoped } from '../server/security.js';
import {
  callAgent,
  type AgentModelInput,
  type AgentModelCallRuntime,
} from '../server/agent-model.js';
import type { AgentRunResult } from '../shared/agent-runs.js';
import { chatIntents, type ChatClassification } from '../shared/chat-intent.js';
import {
  createEvaluationEnvironment,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';

// Real isolated HTTP/session/RLS paths with a deterministic model, not a semantic model trial.
let env: EvaluationEnvironment;
let classification: ChatClassification;
let beforeAnswer: (() => Promise<void>) | undefined;
let failAnswer = false;
let testsInEnvironment = 0;
let streamCalls = 0;
let rawUnavailableBody = '模型认为可以继续引用，请粘贴刚才原文。';
let invalidAnswer = false;
let nativeAbortMode = false;
let nativeEntered: (() => void) | undefined;
let nativeAborted: (() => void) | undefined;
let nativeSignal: AbortSignal | undefined;
const rawOutputs: unknown[] = [];
const seen: AgentModelInput[] = [];
const genericNotice =
  '系统状态：当前无法访问或引用先前任务所需资料，原任务已停止。请新建对话开始其他任务。';
const normal: ChatClassification = {
  intent: '查询资料',
  action: 'lookup_entity',
  entity_type: 'company',
  target: '海风',
  match_mode: 'name',
  candidate_index: null,
  data_source: 'records',
  missing: [],
  reply: '查询当前授权资料。',
  mail_action: null,
  turn_action: 'start',
  slot_updates: [],
};
async function generate(input: AgentModelInput, runtime?: AgentModelCallRuntime) {
  seen.push(structuredClone(input));
  if (input.phase === 'classify') return classification;
  if (beforeAnswer) {
    const hook = beforeAnswer;
    beforeAnswer = undefined;
    await hook();
  }
  if (failAnswer) throw new ApiError(503, 'Synthetic model unavailable');
  const unavailable = input.snapshot.warnings.some((warning) =>
    warning.includes('先前任务的资料当前无法访问或引用'),
  );
  if (nativeAbortMode && unavailable)
    return callAgent(
      input,
      'synthetic-never-sent',
      'cn',
      async (_url, init) => {
        nativeSignal = init?.signal || undefined;
        expect(nativeSignal).toBeInstanceOf(AbortSignal);
        nativeEntered?.();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            nativeAborted?.();
            reject(nativeSignal!.reason);
          };
          if (nativeSignal!.aborted) abort();
          else nativeSignal!.addEventListener('abort', abort, { once: true });
        });
      },
      undefined,
      runtime,
    );
  const output = invalidAnswer
    ? { answer: 42, source_ids: [] }
    : unavailable
      ? { answer: rawUnavailableBody, source_ids: [] }
      : {
          answer:
            input.snapshot.retrieval?.status === 'unique'
              ? `当前授权资料：${input.snapshot.sources[0]?.body}`
              : '本轮只按当前授权范围处理。',
          source_ids:
            input.snapshot.retrieval?.status === 'unique'
              ? input.snapshot.sources.slice(0, 1).map((source) => source.id)
              : [],
        };
  rawOutputs.push(structuredClone(output));
  return output;
}
async function prepareEnvironment() {
  env = await createEvaluationEnvironment({
    agent: {
      transport: {
        generate,
        async stream(input, stream) {
          streamCalls++;
          const output = await generate(input);
          await stream.onText(JSON.stringify(output));
          return output;
        },
      },
    },
  });
}
beforeAll(prepareEnvironment, 30000);
afterAll(() => env?.cleanup());
async function grant(access: 'editor' | null) {
  expect(
    (
      await env.actors.boss.request(
        'PUT',
        `/api/customers/${env.ids.export_customer}/access/${env.ids.export}`,
        { access },
      )
    ).status,
  ).toBe(200);
}
beforeEach(async () => {
  // Each App keeps the real60/min HTTP model limiter. Use fresh disposable
  // fixtures across independent table cases rather than weakening that limit.
  if (testsInEnvironment++ >= 15) {
    await env.cleanup();
    await prepareEnvironment();
    testsInEnvironment = 1;
  }
  classification = { ...normal };
  beforeAnswer = undefined;
  failAnswer = false;
  invalidAnswer = false;
  nativeAbortMode = false;
  nativeEntered = undefined;
  nativeAborted = undefined;
  nativeSignal = undefined;
  streamCalls = 0;
  rawUnavailableBody = '模型认为可以继续引用，请粘贴刚才原文。';
  rawOutputs.length = 0;
  seen.length = 0;
  await grant('editor');
});
async function chat() {
  const response = await env.actors.export.request('POST', '/api/chats', {
    id: randomUUID(),
    title: '不可用来源回归',
    customer_id: null,
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}
function send(id: string, body: string) {
  return env.actors.export.request('POST', `/api/chats/${id}/messages`, {
    request_id: randomUUID(),
    body,
  });
}
async function terminal(id: string, runId: string) {
  const until = Date.now() + 5000;
  do {
    const response = await env.actors.export.request('GET', `/api/chats/${id}/runs/${runId}`);
    expect(response.status).toBe(200);
    const result = response.body as AgentRunResult;
    if (!['queued', 'running', 'cancelling'].includes(result.run.status)) return result;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 5));
  } while (Date.now() < until);
  throw new Error('Synthetic stop-state Run did not finish');
}
async function established() {
  const id = await chat();
  const first = await send(id, '查询海风的资料');
  expect(first.status).toBe(200);
  expect(first.body.messages.at(-1).retrieval.status).toBe('unique');
  expect(seen.at(-1)?.snapshot.sources.length).toBeGreaterThan(0);
  return id;
}
function continuing(extra: Partial<ChatClassification> = {}) {
  classification = {
    ...normal,
    target: null,
    action: 'respond',
    match_mode: null,
    turn_action: 'continue',
    ...extra,
  };
  seen.length = 0;
}
function assertSafeAnswer() {
  expect(seen.map((i) => i.phase)).toEqual(['classify', 'answer']);
  const answer = seen.at(-1)!;
  expect(answer.snapshot.sources).toEqual([]);
  expect(answer.history).toEqual([]);
  expect(answer.snapshot.retrieval).toMatchObject({
    status: 'not_searched',
    query: null,
    candidates: [],
  });
  expect(answer.snapshot.warnings.join()).toContain('当前无法访问或引用');
  expect(JSON.stringify(answer)).not.toContain('虚构海风舞蹈');
  expect(JSON.stringify(answer)).not.toContain('海风');
  expect(answer.classification?.target).toBeNull();
}

it('explains a known unavailable context through the model and keeps repeated continuation stopped', async () => {
  const id = await established();
  await grant(null);
  const hidden = await scoped(env.db, env.ids.export, env.ids.workspace, (ctx) =>
    ctx.tx.query(
      "SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2 AND role='assistant'",
      [env.ids.workspace, id],
    ),
  );
  expect(hidden.rows).toEqual([]);
  const privateRow = (
    await env.db.query<{ model_classification: { source_context: unknown } }>(
      "SELECT model_classification FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2 AND role='user'",
      [env.ids.workspace, id],
    )
  ).rows[0];
  expect(JSON.stringify(privateRow.model_classification.source_context)).not.toContain('海风');
  continuing();
  const response = await send(id, '继续引用刚才原文');
  expect(response.status).toBe(200);
  expect(response.body.messages.at(-1).body).toBe(genericNotice);
  expect(JSON.stringify(response.body)).not.toContain('source_context');
  expect(JSON.stringify(response.body)).not.toContain('anchor_message_id');
  expect(
    response.body.messages.find((m: { role: string }) => m.role === 'user').classification,
  ).toBeUndefined();
  assertSafeAnswer();
  continuing({ turn_action: 'modify' });
  expect((await send(id, '把刚才的分析改简短一点')).status).toBe(200);
  assertSafeAnswer();
});

it('handles an explicit same-target request without turning it into a no-match directory search', async () => {
  const id = await established();
  await grant(null);
  continuing({ ...normal, turn_action: 'start' });
  expect((await send(id, '再查海风的资料')).status).toBe(200);
  assertSafeAnswer();
});

it.each(['continue', 'modify'] as const)(
  'keeps a quoted %s of unavailable private context stopped despite a coarse general intent',
  async (turnAction) => {
    const id = await established();
    await grant(null);
    const question = turnAction === 'continue' ? '继续引用刚才原文' : '把刚才原文的分析改简短一点';
    // Actual native counterexample: the classifier marked this as general chat,
    // while its structured turn action and quoted user evidence still continue
    // the now-unavailable private task.
    continuing({
      intent: '一般对话',
      entity_type: 'unknown',
      data_source: 'none',
      ownership: null,
      reply: '继续引用上一轮用户原文，不查询业务资料。',
      turn_action: turnAction,
      turn_evidence: question,
    });
    const response = await send(id, question);
    expect(response.status).toBe(200);
    expect(response.body.messages.at(-1).body).toBe(genericNotice);
    assertSafeAnswer();
    expect(seen.at(-1)?.question).toBe('说明先前任务当前无法访问或引用所需资料，且已停止原任务。');
  },
);

it.each([{ turn_action: 'continue' as const, target: '新的对象', body: '查询新的对象' }])(
  'does not inherit unavailable context for general $turn_action with target $target',
  async (entry) => {
    const id = await established();
    await grant(null);
    continuing({
      intent: '一般对话',
      entity_type: 'unknown',
      data_source: 'none',
      turn_action: entry.turn_action,
      target: entry.target,
      turn_evidence: entry.body,
    });
    expect((await send(id, entry.body)).status).toBe(200);
    expect(seen.at(-1)?.snapshot.warnings.join()).not.toContain('先前任务的资料当前无法访问或引用');
  },
);

it('rejects an unavailable general continuation with a forged optional quote before any answer', async () => {
  const id = await established();
  await grant(null);
  const before = await env.actors.export.request('GET', `/api/chats/${id}`);
  continuing({
    intent: '一般对话',
    entity_type: 'unknown',
    data_source: 'none',
    turn_action: 'continue',
    turn_evidence: '不在本轮的伪造原话',
    reply: '继续引用刚才原文。',
  });
  expect((await send(id, '继续引用刚才原文')).status).toBe(502);
  expect(seen.map((input) => input.phase)).toEqual(['classify']);
  const after = await env.actors.export.request('GET', `/api/chats/${id}`);
  expect(after.body.messages).toHaveLength(before.body.messages.length);
});

const openTurns = chatIntents.flatMap((intent) =>
  (['continue', 'modify', 'clarify'] as const).map((turnAction) => ({ intent, turnAction })),
);
it.each(openTurns)(
  'stops known unavailable $intent/$turnAction without inventing a required quote',
  async ({ intent, turnAction }) => {
    const id = await established();
    await grant(null);
    const before = await env.snapshot();
    continuing({
      intent,
      action: turnAction === 'clarify' ? 'clarify' : 'respond',
      target: null,
      data_source: 'none',
      turn_action: turnAction,
      turn_evidence: undefined,
      missing: turnAction === 'clarify' ? ['需要引用的原文内容'] : [],
      reply: '请粘贴需要继续引用的原文，我将按原文续接。',
    });
    const response = await send(id, '继续引用刚才原文');
    expect(response.status).toBe(200);
    expect(response.body.messages.at(-1).body).toBe(genericNotice);
    assertSafeAnswer();
    const after = await env.snapshot();
    for (const key of [
      'draft_writes',
      'field_writes',
      'task_writes',
      'approvals',
      'schedules',
      'fake_transport_submissions',
    ])
      expect(after.counters[key]).toBe(before.counters[key]);
  },
);

it.each(openTurns)(
  'keeps prior-available behavior unchanged for $intent/$turnAction without optional evidence',
  async ({ intent, turnAction }) => {
    const id = await established();
    continuing({
      intent,
      action: turnAction === 'clarify' ? 'clarify' : 'respond',
      target: null,
      data_source: 'none',
      turn_action: turnAction,
      turn_evidence: undefined,
      missing: turnAction === 'clarify' ? ['需要处理的内容'] : [],
    });
    expect((await send(id, '继续当前请求')).status).toBe(200);
    expect(seen.at(-1)?.snapshot.warnings.join()).not.toContain('先前任务的资料当前无法访问或引用');
    expect(seen.at(-1)?.question).toBe('继续当前请求');
  },
);

it.each(
  chatIntents.flatMap((intent) =>
    (['start', 'cancel'] as const).map((turnAction) => ({ intent, turnAction })),
  ),
)(
  'returns system stop for no-target $intent/$turnAction and only cancel resets the private anchor',
  async ({ intent, turnAction }) => {
    const id = await established();
    await grant(null);
    const question = turnAction === 'cancel' ? '取消' : '处理一个新的问题';
    continuing({
      intent,
      action: 'respond',
      target: null,
      data_source: 'none',
      turn_action: turnAction,
      turn_evidence: turnAction === 'cancel' ? question : undefined,
    });
    const response = await send(id, question);
    expect(response.status).toBe(200);
    expect(response.body.messages.at(-1)).toMatchObject({
      body: genericNotice,
      model: null,
      sources: [],
    });
    assertSafeAnswer();
    continuing({ intent: '一般对话', target: null, data_source: 'none', turn_action: 'start' });
    const next = await send(id, '开始其他任务');
    expect(next.status).toBe(200);
    expect(next.body.messages.at(-1).body === genericNotice).toBe(turnAction !== 'cancel');
  },
);

it.each(openTurns)(
  'does not inherit unavailable prior for a different target $intent/$turnAction',
  async ({ intent, turnAction }) => {
    const id = await established();
    await grant(null);
    continuing({
      intent,
      action: 'respond',
      target: '新的独立目标',
      data_source: 'none',
      turn_action: turnAction,
      turn_evidence: undefined,
    });
    expect((await send(id, '处理新的独立目标')).status).toBe(200);
    expect(seen.at(-1)?.snapshot.warnings.join()).not.toContain('先前任务的资料当前无法访问或引用');
  },
);

it('keeps ordinary general continuation without quoted evidence unchanged when prior sources are available', async () => {
  const id = await established();
  continuing({ intent: '一般对话', data_source: 'none', turn_action: 'continue' });
  expect((await send(id, '谢谢')).status).toBe(200);
  expect(seen.at(-1)?.snapshot.warnings.join()).not.toContain('先前任务的资料当前无法访问或引用');
});

it('still exposes model failure instead of a fixed reply for quoted general unavailable continuation', async () => {
  const id = await established();
  await grant(null);
  const before = await env.actors.export.request('GET', `/api/chats/${id}`);
  continuing({
    intent: '一般对话',
    data_source: 'none',
    turn_action: 'continue',
    turn_evidence: '继续引用刚才原文',
  });
  failAnswer = true;
  expect((await send(id, '继续引用刚才原文')).status).toBe(503);
  assertSafeAnswer();
  const after = await env.actors.export.request('GET', `/api/chats/${id}`);
  expect(after.body.messages).toHaveLength(before.body.messages.length);
});

it('displays only a model:null system state after a valid but malicious native answer', async () => {
  const id = await established();
  await grant(null);
  continuing({
    intent: '起草内容',
    action: 'clarify',
    target: null,
    data_source: 'none',
    turn_action: 'start',
    missing: ['刚才原文'],
  });
  rawUnavailableBody = '可以继续引用。请粘贴刚才原文。RAW_MODEL_CANARY';
  const response = await send(id, '继续引用刚才原文');
  expect(response.status).toBe(200);
  expect(response.body.messages.at(-1)).toMatchObject({
    body: genericNotice,
    model: null,
    sources: [],
  });
  expect(JSON.stringify(response.body)).not.toContain('RAW_MODEL_CANARY');
  expect(rawOutputs.at(-1)).toMatchObject({ answer: rawUnavailableBody });
  const stored = await env.db.query<{ body: string; model: string | null }>(
    "SELECT body,model FROM chat_messages WHERE chat_id=$1 AND role='assistant' ORDER BY position DESC LIMIT 1",
    [id],
  );
  expect(stored.rows[0]).toEqual({ body: genericNotice, model: null });
  const recovered = await env.actors.export.request('GET', `/api/chats/${id}`);
  expect(recovered.body.messages.at(-1)).toMatchObject({ body: genericNotice, model: null });
});

it('does not emit raw stop-model prose on the direct SSE path', async () => {
  const id = await established();
  await grant(null);
  continuing({ intent: '一般对话', turn_action: 'start', target: null });
  rawUnavailableBody = '可以引用旧原文，继续粘贴。RAW_SSE_CANARY';
  const response = await env.actors.export.client
    .post(`/api/chats/${id}/messages`)
    .set(env.actors.export.headers)
    .set('accept', 'text/event-stream')
    .send({ request_id: randomUUID(), body: '继续引用刚才原文' });
  expect(response.status).toBe(200);
  expect(response.text).toContain(genericNotice);
  expect(response.text).not.toContain('RAW_SSE_CANARY');
  expect(response.text).not.toContain('event: text');
  expect(streamCalls).toBe(0);
  expect(rawOutputs.at(-1)).toMatchObject({ answer: rawUnavailableBody });
});

it('forwards direct SSE disconnect to the synthetic native generate signal and commits no system state', async () => {
  const id = await established();
  await grant(null);
  const before = await env.actors.export.request('GET', `/api/chats/${id}`);
  continuing({ intent: '一般对话', turn_action: 'start', target: null });
  nativeAbortMode = true;
  const entered = new Promise<void>((resolveEntered) => {
    nativeEntered = resolveEntered;
  });
  const aborted = new Promise<void>((resolveAborted) => {
    nativeAborted = resolveAborted;
  });
  const request = env.actors.export.client
    .post(`/api/chats/${id}/messages`)
    .set(env.actors.export.headers)
    .set('accept', 'text/event-stream')
    .send({ request_id: randomUUID(), body: '继续引用刚才原文' });
  const settled = request.then(
    (response) => response,
    (error: unknown) => error,
  );
  await entered;
  request.abort();
  await aborted;
  await settled;
  expect(nativeSignal?.aborted).toBe(true);
  expect(streamCalls).toBe(0);
  const after = await env.actors.export.request('GET', `/api/chats/${id}`);
  expect(after.body.messages).toHaveLength(before.body.messages.length);
  expect(
    after.body.messages.some((message: { body: string }) => message.body === genericNotice),
  ).toBe(false);
});

it('keeps persistent Run answer buffers free of raw model prose and commits only the system state', async () => {
  const id = await established();
  await grant(null);
  continuing({ intent: '一般对话', turn_action: 'start', target: null });
  rawUnavailableBody = '继续引用原文。RAW_RUN_CANARY';
  const accepted = await env.actors.export.request('POST', `/api/chats/${id}/runs`, {
    kind: 'message',
    payload: { request_id: randomUUID(), body: '继续引用刚才原文' },
  });
  expect(accepted.status).toBe(202);
  const result = await terminal(id, accepted.body.run.id);
  expect(result.run.status).toBe('completed');
  expect(result.run.answer).toBe('');
  expect(result.detail.messages.at(-1)).toMatchObject({ body: genericNotice, model: null });
  expect(JSON.stringify(result)).not.toContain('RAW_RUN_CANARY');
  expect(streamCalls).toBe(0);
  expect(rawOutputs.at(-1)).toMatchObject({ answer: rawUnavailableBody });
});

it('does not submit a system state when the native model response fails its existing parser', async () => {
  const id = await established();
  await grant(null);
  const before = await env.actors.export.request('GET', `/api/chats/${id}`);
  continuing({ intent: '一般对话', turn_action: 'start', target: null });
  invalidAnswer = true;
  expect((await send(id, '继续引用刚才原文')).status).toBe(502);
  const after = await env.actors.export.request('GET', `/api/chats/${id}`);
  expect(after.body.messages).toHaveLength(before.body.messages.length);
  expect(seen.map((input) => input.phase)).toEqual(['classify', 'answer']);
});

it('treats fresh material as independently supplied input rather than restoring old source context', async () => {
  const id = await established();
  await grant(null);
  continuing({
    intent: '整理录入',
    action: 'respond',
    target: null,
    data_source: 'none',
    turn_action: 'start',
  });
  const response = await env.actors.export.request('POST', `/api/chats/${id}/messages`, {
    request_id: randomUUID(),
    body: '整理本人新提供的内容',
    material: { name: '本人新材料', content: 'FRESH_EXPLICIT_MATERIAL' },
  });
  expect(response.status).toBe(200);
  expect(response.body.messages.at(-1).body).not.toBe(genericNotice);
  expect(seen.at(-1)?.snapshot.warnings.join()).not.toContain('先前任务的资料当前无法访问或引用');
  expect(
    seen.at(-1)?.snapshot.sources.some((source) => source.body === 'FRESH_EXPLICIT_MATERIAL'),
  ).toBe(true);
  expect(JSON.stringify(seen.at(-1)?.snapshot.sources)).not.toContain('海风');
});

it('does not describe a new unknown target as unavailable prior material', async () => {
  const id = await established();
  await grant(null);
  continuing({ ...normal, target: '完全未知的新目标', turn_action: 'continue' });
  expect((await send(id, '查询完全未知的新目标')).status).toBe(200);
  expect(seen.at(-1)?.snapshot.retrieval?.status).toBe('no_match');
  expect(seen.at(-1)?.snapshot.warnings.join()).not.toContain('先前任务的资料当前无法访问或引用');
});

it('does not keep the stopped context after cancellation and a new topic', async () => {
  const id = await established();
  await grant(null);
  continuing();
  expect((await send(id, '继续之前分析')).status).toBe(200);
  continuing({ intent: '一般对话', turn_action: 'cancel', turn_evidence: '取消' });
  const cancelled = await send(id, '取消');
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.messages.at(-1)).toMatchObject({ body: genericNotice, model: null });
  assertSafeAnswer();
  continuing({ ...normal, target: '合奏', turn_action: 'start' });
  expect((await send(id, '查询合奏的资料')).status).toBe(200);
  expect(seen.at(-1)?.snapshot.retrieval?.status).toBe('unique');
  expect(seen.at(-1)?.snapshot.warnings.join()).not.toContain('先前任务的资料当前无法访问或引用');
});

it('uses fresh authorized sources after access is restored', async () => {
  const id = await established();
  await grant(null);
  continuing();
  expect((await send(id, '继续之前分析')).status).toBe(200);
  await grant('editor');
  continuing({ ...normal, turn_action: 'continue' });
  expect((await send(id, '重新查询海风')).status).toBe(200);
  expect(seen.at(-1)?.snapshot.retrieval?.status).toBe('unique');
  expect(seen.at(-1)?.snapshot.sources.length).toBeGreaterThan(0);
});

it('rejects a stale unavailable explanation if access returns during generation', async () => {
  const id = await established();
  await grant(null);
  continuing();
  beforeAnswer = () => grant('editor');
  const response = await send(id, '继续刚才分析');
  expect(response.status).toBe(409);
  const detail = await env.actors.export.request('GET', `/api/chats/${id}`);
  expect(detail.body.messages).toHaveLength(2);
});

it('stops business side effects even when the new classifier suggests continuing a mail task', async () => {
  const id = await established();
  await grant(null);
  const before = await env.snapshot();
  continuing({ intent: '起草内容', mail_action: 'compose' });
  const response = await send(id, '继续给刚才客户写信');
  expect(response.status).toBe(200);
  assertSafeAnswer();
  const after = await env.snapshot();
  expect(after.tableCounts.home_workflows).toBe(before.tableCounts.home_workflows);
  expect(after.counters.draft_writes).toBe(before.counters.draft_writes);
  expect(after.counters.fake_transport_submissions).toBe(
    before.counters.fake_transport_submissions,
  );
  expect(after.counters.preference_writes).toBe(before.counters.preference_writes);
});

it('does not replace model failure with a fixed unavailable response', async () => {
  const id = await established();
  await grant(null);
  const before = await env.actors.export.request('GET', `/api/chats/${id}`);
  continuing();
  failAnswer = true;
  expect((await send(id, '继续之前分析')).status).toBe(503);
  expect(seen.map((i) => i.phase)).toEqual(['classify', 'answer']);
  const detail = await env.actors.export.request('GET', `/api/chats/${id}`);
  expect(detail.body.messages).toHaveLength(before.body.messages.length);
});

it('handles a previously selected source that is deleted while customer access remains valid', async () => {
  const source = randomUUID();
  // Disposable fixture setup, outside the restricted product SQL role.
  await env.db.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [env.ids.workspace, env.ids.boss],
    );
    await tx.query(
      "INSERT INTO customer_records(workspace_id,id,customer_id,kind,body,created_by,source_kind,occurred_at) VALUES($1,$2,$3,'customer_quote',$4,$5,'manual',now())",
      [
        env.ids.workspace,
        source,
        env.ids.export_customer,
        'SOURCE_DELETION_PRIVATE_CANARY',
        env.ids.boss,
      ],
    );
  });
  const id = await established();
  expect(seen.at(-1)?.snapshot.sources.some((s) => s.ref?.id === source)).toBe(true);
  await env.db.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [env.ids.workspace, env.ids.boss],
    );
    await tx.query('DELETE FROM customer_records WHERE workspace_id=$1 AND id=$2', [
      env.ids.workspace,
      source,
    ]);
  });
  continuing();
  expect((await send(id, '继续刚才原文分析')).status).toBe(200);
  assertSafeAnswer();
  expect(JSON.stringify(seen.at(-1))).not.toContain('SOURCE_DELETION_PRIVATE_CANARY');
});
