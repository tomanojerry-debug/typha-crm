import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createEvaluationEnvironment,
  type EvaluationEnvironment,
} from '../scripts/product-evaluation/environment.js';
import { callAgent, snapshotDigest, type AgentModelInput } from '../server/agent-model.js';
import { parseClassification } from '../server/chat-intent.js';
import { scoped, type Context } from '../server/security.js';
import type { AgentRunResult } from '../shared/agent-runs.js';
import type { ChatClassification, CustomerListOwnership } from '../shared/chat-intent.js';

// Only an isolated in-memory product app, password sessions and synthetic native
// HTTP responses. No provider, production DB, mailbox, worker or send operation.
let env: EvaluationEnvironment;
let selected: Record<string, unknown>;
let failures: number;
let mutation: (() => Promise<void>) | undefined;
const seen: AgentModelInput[] = [];
const nativeInputs: string[] = [];
const extraCustomers: string[] = [];
const listClassification = (ownership: CustomerListOwnership | null = 'owned_by_me') => ({
  intent: '查询资料',
  action: 'list_customers',
  entity_type: 'company',
  target: null,
  match_mode: null,
  candidate_index: null,
  data_source: 'records',
  ownership,
  missing: [],
  reply: '列出所请求范围的授权客户目录。',
  mail_action: null,
  turn_action: 'start',
  slot_updates: [],
});
function modelOutput(input: AgentModelInput) {
  return {
    answer:
      input.snapshot.retrieval?.status === 'listed'
        ? '旧客户列表回答。'
        : input.snapshot.warnings.some((warning) => warning.includes('客户列表缺ownership'))
          ? '你要列本人负责还是全部授权客户？'
          : '新的普通回答。',
    source_ids: input.snapshot.sources.flatMap((source) => (source.ref ? [source.id] : [])),
  };
}
async function admin(fn: (ctx: Context) => Promise<unknown>) {
  await scoped(env.db, env.actors.boss.id, env.ids.workspace, fn);
}
beforeAll(async () => {
  env = await createEvaluationEnvironment({
    agent: {
      transport: {
        async generate(input, runtime) {
          seen.push(input);
          if (input.phase === 'classify') return selected;
          return callAgent(
            input,
            'synthetic-key',
            'cn',
            async (_url, init) => {
              nativeInputs.push(String(init?.body));
              const mutate = mutation;
              mutation = undefined;
              await mutate?.();
              if (failures > 0) {
                failures--;
                return new Response('', { status: 503 });
              }
              return new Response(
                JSON.stringify({
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: { content: JSON.stringify(modelOutput(input)) },
                    },
                  ],
                  usage: { prompt_tokens: 5, completion_tokens: 3 },
                }),
              );
            },
            undefined,
            runtime,
          );
        },
      },
    },
  });
}, 60000);
afterAll(() => env?.cleanup());
beforeEach(async () => {
  selected = listClassification();
  failures = 0;
  mutation = undefined;
  seen.length = 0;
  nativeInputs.length = 0;
  await admin(async (ctx) => {
    if (extraCustomers.length)
      await ctx.tx.query(
        'UPDATE customers SET archived_at=now() WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
        [ctx.workspaceId, extraCustomers],
      );
    for (const customer of env.fixture.customers) {
      await ctx.tx.query(
        'UPDATE customers SET owner_id=$3,archived_at=NULL WHERE workspace_id=$1 AND id=$2',
        [ctx.workspaceId, customer.id, customer.owner_id],
      );
      await ctx.tx.query('DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2', [
        ctx.workspaceId,
        customer.id,
      ]);
      for (const [actor, access] of Object.entries(customer.acl))
        await ctx.tx.query(
          'INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,$4)',
          [ctx.workspaceId, customer.id, actor, access],
        );
    }
  });
});
async function run(
  actor: 'boss' | 'export' | 'domestic' = 'export',
  customer: string | null = null,
  id?: string,
  body = '列出当前请求范围的客户',
) {
  const client = env.actors[actor];
  const chatId = id || randomUUID();
  if (!id) {
    const created = await client.request('POST', '/api/chats', {
      id: chatId,
      title: '客户列表隔离测试',
      customer_id: customer,
    });
    expect(created.status).toBe(201);
  }
  const response = await client.request('POST', `/api/chats/${chatId}/runs`, {
    kind: 'message',
    payload: {
      request_id: randomUUID(),
      action: 'message',
      body,
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const deadline = Date.now() + 10000;
  do {
    const polled = await client.request('GET', `/api/chats/${chatId}/runs/${response.body.run.id}`);
    expect(polled.status).toBe(200);
    const result = polled.body as AgentRunResult;
    if (!['queued', 'running', 'cancelling'].includes(result.run.status)) return { result, chatId };
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 5));
  } while (Date.now() < deadline);
  throw new Error('Synthetic customer-list Run did not stop');
}
function lastAnswer() {
  return seen.filter((input) => input.phase !== 'classify').at(-1)!;
}
function ids(result: AgentRunResult) {
  return result.detail.messages
    .at(-1)
    ?.retrieval?.items?.map((item) => item.id)
    .sort();
}

it('requires explicit structured ownership and rejects identity, SQL and conflicting tasks', () => {
  expect(parseClassification(listClassification())).toMatchObject({
    action: 'list_customers',
    ownership: 'owned_by_me',
    match_mode: null,
  });
  for (const patch of [
    { actor_id: randomUUID() },
    { query: 'owner=anyone' },
    { sql: 'SELECT * FROM customers' },
    { intent: '起草内容', mail_action: 'compose' },
    { data_source: 'wechat_device' },
    { target: '海风' },
    { candidate_index: 1 },
    { turn_action: 'cancel' },
    { slot_updates: [{ slot: 'language', op: 'set', value: 'zh', evidence: '中文' }] },
  ])
    expect(() => parseClassification({ ...listClassification(), ...patch })).toThrow();
  expect(() => parseClassification({ ...listClassification(), action: 'lookup_entity' })).toThrow();
});

it('allows a read-only list scope modify from owned to accessible in the same chat', async () => {
  const before = await env.snapshot();
  const owned = await run('export', null, undefined, '列出我负责的客户');
  expect(ids(owned.result)).toEqual([env.ids.export_customer]);
  const question = '列出我当前有权限查看的全部客户，不按负责人筛选';
  selected = {
    ...listClassification('accessible'),
    turn_action: 'modify',
    turn_evidence: '不按负责人筛选',
  };
  expect(parseClassification(selected, question)).toMatchObject({
    action: 'list_customers',
    ownership: 'accessible',
    turn_action: 'modify',
    slot_updates: [],
  });
  const accessible = await run('export', null, owned.chatId, question);
  expect(accessible.result.run.status).toBe('completed');
  expect(ids(accessible.result)).toEqual([env.ids.export_customer, env.ids.joint_customer].sort());
  expect(accessible.result.detail.messages.at(-1)?.classification).toMatchObject({
    action: 'list_customers',
    ownership: 'accessible',
    turn_action: 'modify',
    slot_updates: [],
  });
  expect(lastAnswer().snapshot.retrieval).toMatchObject({
    status: 'listed',
    total: 2,
    candidates: [],
    listing: { ownership: 'accessible', returned: 2 },
  });
  const after = await env.snapshot();
  for (const key of [
    'field_writes',
    'draft_writes',
    'approvals',
    'schedules',
    'fake_transport_submissions',
    'task_writes',
  ])
    expect(after.counters[key] - before.counters[key]).toBe(0);
});

it('intersects own assignment with ACL and keeps accessible and unassigned customers distinct', async () => {
  await admin(async (ctx) => {
    // Owner alone never grants a read.
    await ctx.tx.query('UPDATE customers SET owner_id=$3 WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      env.ids.unassigned_customer,
      env.actors.export.id,
    ]);
  });
  const owned = await run();
  expect(owned.result.run.status).toBe('completed');
  expect(ids(owned.result)).toEqual([env.ids.export_customer]);
  const listed = owned.result.detail.messages.at(-1)!.retrieval!;
  expect(listed).toMatchObject({
    status: 'listed',
    total: 1,
    truncated: false,
    candidates: [],
    listing: { ownership: 'owned_by_me', page: 1, page_size: 30, returned: 1 },
  });
  expect(listed.task).toBeUndefined();
  expect(listed.listing!.snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(seen.map((input) => input.phase)).toEqual(['classify', 'answer']);
  expect(lastAnswer().entry_context?.scope_mode).toBe('authorized_directory');
  expect(
    lastAnswer().snapshot.sources.every(
      (source) =>
        !source.ref || (source.ref.kind === 'entity' && source.ref.object === 'customers'),
    ),
  ).toBe(true);
  expect(JSON.stringify(lastAnswer().snapshot.sources)).not.toContain('owner_id');
  const recordText = env.fixture.records[0].body;
  expect(JSON.stringify(lastAnswer().snapshot.sources)).not.toContain(recordText);
  selected = listClassification('accessible');
  const accessible = await run();
  expect(ids(accessible.result)).toEqual([env.ids.export_customer, env.ids.joint_customer].sort());
  await admin(async (ctx) => {
    await ctx.tx.query('UPDATE customers SET owner_id=NULL WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      env.ids.unassigned_customer,
    ]);
    await ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [ctx.workspaceId, env.ids.unassigned_customer, env.actors.export.id],
    );
  });
  expect(ids((await run()).result)).toEqual(
    [env.ids.export_customer, env.ids.joint_customer, env.ids.unassigned_customer].sort(),
  );
  selected = listClassification();
  expect(ids((await run()).result)).toEqual([env.ids.export_customer]);
  expect(env.fakeSubmissions).toEqual([]);
});

it('admin own assignment stays separate from admin access to all customers', async () => {
  await admin(async (ctx) => {
    await ctx.tx.query('UPDATE customers SET owner_id=$3 WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      env.ids.unassigned_customer,
      env.actors.boss.id,
    ]);
  });
  expect(ids((await run('boss')).result)).toEqual([env.ids.unassigned_customer]);
  selected = listClassification('accessible');
  expect(ids((await run('boss')).result)).toHaveLength(4);
});

it('keeps empty owned results listed and never includes archived assignments', async () => {
  expect(ids((await run('boss')).result)).toEqual([]);
  expect(lastAnswer().snapshot.retrieval).toMatchObject({
    status: 'listed',
    total: 0,
    truncated: false,
    listing: { returned: 0 },
  });
  await admin(async (ctx) => {
    await ctx.tx.query('UPDATE customers SET archived_at=now() WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      env.ids.joint_customer,
    ]);
  });
  expect(ids((await run('domestic')).result)).toEqual([env.ids.domestic_customer]);
});

it('lists exactly the first 30 names with an exact filtered total and truncation', async () => {
  await admin(async (ctx) => {
    for (let index = 0; index < 35; index++) {
      const id = randomUUID();
      extraCustomers.push(id);
      await ctx.tx.query(
        "INSERT INTO customers(workspace_id,id,name,type,source,owner_id) VALUES($1,$2,$3,'group','other',$4)",
        [ctx.workspaceId, id, `Owned ${String(index).padStart(2, '0')}`, env.actors.boss.id],
      );
    }
  });
  const { result } = await run('boss');
  const retrieval = result.detail.messages.at(-1)!.retrieval!;
  expect(retrieval.items?.map((item) => item.title)).toEqual(
    Array.from({ length: 30 }, (_, index) => `Owned ${String(index).padStart(2, '0')}`),
  );
  expect(retrieval).toMatchObject({
    status: 'listed',
    total: 35,
    truncated: true,
    candidates: [],
    listing: { returned: 30, page: 1, page_size: 30 },
  });
  expect(JSON.stringify(lastAnswer().snapshot.sources)).not.toContain('Owned 30');
});

it('asks only the missing list scope and does not reinterpret targetless lookup as a list', async () => {
  selected = listClassification(null);
  let result = (await run()).result;
  expect(result.run.status).toBe('completed');
  expect(lastAnswer().snapshot).toMatchObject({
    sources: [],
    retrieval: { status: 'not_searched' },
  });
  expect(lastAnswer().classification?.missing).toEqual(['本人负责还是全部授权客户']);
  expect(lastAnswer().snapshot.warnings.join(' ')).toContain('客户列表缺ownership');
  expect(result.detail.messages.at(-1)?.retrieval?.listing).toBeUndefined();
  selected = { ...listClassification(null), action: 'lookup_entity' };
  result = (await run()).result;
  expect(lastAnswer().snapshot.sources).toEqual([]);
  expect(result.detail.messages.at(-1)?.retrieval?.status).toBe('not_searched');
});

it('keeps a bound customer Home from reading a cross-customer list', async () => {
  const { result } = await run('export', env.ids.export_customer);
  expect(result.run.status).toBe('completed');
  expect(lastAnswer().snapshot.sources).toEqual([]);
  expect(lastAnswer().snapshot.warnings.join(' ')).toContain('首页新建未绑定客户的对话');
  expect(result.detail.messages.at(-1)?.retrieval?.status).toBe('not_searched');
});

it('does not infer list ownership from explicit user text or model reply when the structured field is null', async () => {
  // Actual native-model counterexample: the prose plan knew the requested scope,
  // but the missing structured field must still stop the directory read.
  selected = {
    ...listClassification(null),
    reply: '列出本人负责且当前可访问的客户基础目录。',
  };
  const { result } = await run('export', null, undefined, '列出我负责的客户');
  expect(result.run.status).toBe('completed');
  expect(lastAnswer().classification).toMatchObject({
    action: 'list_customers',
    ownership: null,
    missing: ['本人负责还是全部授权客户'],
  });
  expect(lastAnswer().snapshot).toMatchObject({
    sources: [],
    retrieval: { status: 'not_searched', total: 0, candidates: [] },
  });
  const returned = result.detail.messages.at(-1)!;
  expect(returned.body).toBe('你要列本人负责还是全部授权客户？');
  expect(returned.sources).toEqual([]);
  expect(returned.retrieval?.listing).toBeUndefined();
  expect(returned.retrieval?.items).toBeUndefined();
  expect(seen.map((input) => input.phase)).toEqual(['classify', 'answer']);
});

it('invalidates history on assignment transfer while ACL remains and excludes it from new model history', async () => {
  const { result, chatId } = await run();
  const old = result.detail.messages.at(-1)!;
  const storedDigest = old.retrieval!.listing!.snapshot_digest;
  const calls = seen.length;
  await admin(async (ctx) => {
    await ctx.tx.query('UPDATE customers SET owner_id=$3 WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      env.ids.export_customer,
      env.actors.domestic.id,
    ]);
  });
  const fresh = await env.actors.export.request('GET', `/api/chats/${chatId}`);
  expect(fresh.status).toBe(200);
  expect(fresh.body.messages.at(-1), JSON.stringify(fresh.body.messages)).toMatchObject({
    sources: [],
    retrieval: null,
  });
  expect(fresh.body.messages.at(-1).body).not.toBe(old.body);
  expect(seen).toHaveLength(calls);
  // Read-side invalidation must not rewrite the stored result into a new list.
  const stored = await env.db.query<{ model_retrieval: { listing: { snapshot_digest: string } } }>(
    'SELECT model_retrieval FROM chat_messages WHERE id=$1',
    [old.id],
  );
  expect(stored.rows[0].model_retrieval.listing.snapshot_digest).toBe(storedDigest);
  selected = {
    ...listClassification(null),
    intent: '一般对话',
    action: 'respond',
    entity_type: 'unknown',
    data_source: 'none',
  };
  expect((await run('export', null, chatId)).result.run.status).toBe('completed');
  expect(lastAnswer().history?.some((turn) => turn.content.includes('旧客户列表回答'))).toBe(false);
});

it('invalidates an accessible historical list after ACL revocation without calling a model', async () => {
  selected = listClassification('accessible');
  const { chatId } = await run();
  const calls = seen.length;
  await admin(async (ctx) => {
    await ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [ctx.workspaceId, env.ids.export_customer, env.actors.export.id],
    );
  });
  const fresh = await env.actors.export.request('GET', `/api/chats/${chatId}`);
  expect(fresh.status).toBe(200);
  // Existing message RLS removes an answer whose basis contains a revoked customer.
  expect(
    fresh.body.messages.filter((message: { role: string }) => message.role === 'assistant'),
  ).toEqual([]);
  expect(JSON.stringify(fresh.body.messages)).not.toContain('旧客户列表回答');
  expect(seen).toHaveLength(calls);
});

it('rejects assignment changes during generation before saving an answer', async () => {
  mutation = () =>
    admin(async (ctx) => {
      await ctx.tx.query('UPDATE customers SET owner_id=$3 WHERE workspace_id=$1 AND id=$2', [
        ctx.workspaceId,
        env.ids.export_customer,
        env.actors.domestic.id,
      ]);
    });
  const { result } = await run();
  expect(result.run.status).toBe('failed');
  expect(result.detail.messages).toEqual([]);
  expect(nativeInputs).toHaveLength(1);
});

it('refuses the one allowed provider retry when the current owner scope has changed', async () => {
  failures = 1;
  mutation = () =>
    admin(async (ctx) => {
      await ctx.tx.query('UPDATE customers SET owner_id=$3 WHERE workspace_id=$1 AND id=$2', [
        ctx.workspaceId,
        env.ids.export_customer,
        env.actors.domestic.id,
      ]);
    });
  const { result } = await run();
  expect(result.run).toMatchObject({
    status: 'failed',
    execution: { error_code: 'scope_changed', feedback: { retries_reserved: 1 } },
  });
  expect(result.detail.messages).toEqual([]);
  expect(nativeInputs).toHaveLength(1);
});

it('recovers one native synthetic HTTP503 with the identical list input and original Run budget', async () => {
  failures = 1;
  const { result } = await run();
  expect(result.run).toMatchObject({
    status: 'completed',
    execution: {
      error_code: null,
      model_calls: { started: 3, failed: 1, returned: 2 },
      feedback: { retries_reserved: 1 },
    },
  });
  expect(nativeInputs).toHaveLength(2);
  expect(nativeInputs[0]).toBe(nativeInputs[1]);
  const inputs = seen.filter((input) => input.phase !== 'classify');
  expect(snapshotDigest(inputs[0].snapshot)).toBe(snapshotDigest(inputs[1].snapshot));
  expect(ids(result)).toEqual([env.ids.export_customer]);
});
