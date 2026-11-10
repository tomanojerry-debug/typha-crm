import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped } from '../server/security.js';
import { insert } from '../server/service.js';
import { createPerson } from '../server/people.js';
import { createList } from '../server/lists.js';
import { allChats, detail as chatDetail } from '../server/chats.js';
import { defaultListConfig } from '../shared/list-workflow.js';
import { modelQuery } from '../server/ask.js';
import { loadAskHistory, validateAskSession } from '../server/ask-sessions.js';
import type { AgentModelInput, AgentModelOptions } from '../server/agent-model.js';
import type { AskScope } from '../shared/ask.js';

let db: Database, workspace: string, actor: string, member: string, otherWorkspace: string;
let customer: string, otherCustomer: string, person: string, project: string;
let seen: AgentModelInput[] = [];
let hook: (input: AgentModelInput) => Promise<unknown>;
const key = randomBytes(32);
const model: AgentModelOptions = {
  key,
  transport: {
    generate: async (input) => {
      seen.push(input);
      return hook(input);
    },
  },
};
const entityScope = (id = customer): AskScope => ({
  kind: 'entity',
  object: 'customers',
  customer_id: id,
  record_id: id,
});
const send = (
  chat_id: string,
  question: string,
  scope = entityScope(),
  request_id = randomUUID(),
  as = actor,
  options = model,
) => modelQuery(db, as, workspace, { chat_id, request_id, question, scope }, options);
const succeed = async (input: AgentModelInput) => ({
  answer: `回答：${input.question}`,
  source_ids: input.snapshot.sources.slice(0, 1).map((s) => s.id),
});

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const first = await createWorkspace(db, {
    name: 'Ask sessions synthetic',
    email: 'ask-session@fixture.invalid',
    displayName: 'Admin',
    password: 'synthetic-password',
  });
  workspace = first.workspaceId;
  actor = first.actorId;
  otherWorkspace = (
    await createWorkspace(db, {
      name: 'Other synthetic workspace',
      email: 'ask-other@fixture.invalid',
      displayName: 'Other admin',
      password: 'synthetic-password',
    })
  ).workspaceId;
  member = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,display_name,password_hash) VALUES($1,'ask-member@fixture.invalid','Member','unused')",
    [member],
  );
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    member,
  ]);
  await scoped(db, actor, workspace, async (ctx) => {
    customer = String(
      (await insert(ctx, 'customers', { name: 'Synthetic A', type: 'group', source: 'email' })).id,
    );
    otherCustomer = String(
      (await insert(ctx, 'customers', { name: 'Synthetic B', type: 'group', source: 'email' })).id,
    );
    person = (
      await createPerson(ctx, {
        customer_id: customer,
        name: 'Synthetic Person',
        email: 'synthetic@fixture.invalid',
      })
    ).id;
    project = String(
      (
        await insert(ctx, 'projects', {
          customer_id: customer,
          name: 'Synthetic Project',
          type: 'sample',
        })
      ).id,
    );
  });
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [workspace, customer, member],
    ),
  );
});
afterAll(async () => db.close());
beforeEach(() => {
  seen = [];
  hook = succeed;
});

it('persists a page-labelled session and resumes all recent turns without a continuation or time limit', async () => {
  const id = randomUUID();
  const first = await send(id, '查看资料');
  expect(first).toMatchObject({ chat_id: id, mode: 'model' });
  const saved = await scoped(db, actor, workspace, (ctx) => validateAskSession(ctx, id));
  expect(saved.origin).toMatchObject({
    kind: 'ask',
    label: '公司详情页 · Synthetic A',
    scope: entityScope(),
  });
  await db.query(
    "UPDATE agent_chats SET created_at=now()-interval '2 days' WHERE workspace_id=$1 AND id=$2",
    [workspace, id],
  );
  await send(id, '继续说明');
  expect(seen[1].history).toEqual([
    { role: 'user', content: '查看资料' },
    { role: 'assistant', content: '回答：查看资料' },
  ]);
  expect(
    (
      await db.query('SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2', [
        workspace,
        id,
      ])
    ).rows,
  ).toHaveLength(4);
});

// Twelve sequential PGlite turns verify history retention, not a latency SLO.
it('supplies exactly the latest ten completed rounds while retaining the entire session log', async () => {
  const id = randomUUID();
  for (let turn = 1; turn <= 12; turn++) await send(id, `问题${turn}`);
  expect(seen[11].history).toHaveLength(20);
  expect(seen[11].history[0]).toEqual({ role: 'user', content: '问题2' });
  expect(seen[11].history.at(-1)).toEqual({ role: 'assistant', content: '回答：问题11' });
  expect(
    (
      await db.query('SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2', [
        workspace,
        id,
      ])
    ).rows,
  ).toHaveLength(24);
}, 15000);

it('replays successful requests exactly and rejects a reused request id with different input', async () => {
  const id = randomUUID(),
    requestId = randomUUID();
  const first = await send(id, '查资料', entityScope(), requestId);
  expect(await send(id, '查资料', entityScope(), requestId)).toEqual(first);
  expect(seen).toHaveLength(1);
  await expect(send(id, '另一问题', entityScope(), requestId)).rejects.toMatchObject({
    status: 409,
  });
  expect(seen).toHaveLength(1);
  expect(
    (
      await db.query('SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2', [
        workspace,
        id,
      ])
    ).rows,
  ).toHaveLength(2);
});

it('serializes concurrent generation and releases failed claims without creating an empty chat', async () => {
  const id = randomUUID();
  let finish!: () => void, started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  hook = async (input) => {
    started();
    await gate;
    return succeed(input);
  };
  const first = send(id, '第一个问题');
  await running;
  await expect(send(id, '并发问题')).rejects.toMatchObject({ status: 409 });
  finish();
  await first;
  expect(seen).toHaveLength(1);
  const failedId = randomUUID();
  hook = async () => {
    throw new Error('synthetic transport failure');
  };
  await expect(send(failedId, '失败问题')).rejects.toThrow('synthetic transport failure');
  expect(
    (
      await db.query('SELECT id FROM agent_chats WHERE workspace_id=$1 AND id=$2', [
        workspace,
        failedId,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query('SELECT token FROM ask_session_claims WHERE workspace_id=$1 AND chat_id=$2', [
        workspace,
        failedId,
      ])
    ).rows,
  ).toHaveLength(0);
  hook = succeed;
  await expect(send(failedId, '重试')).resolves.toMatchObject({ chat_id: failedId });
});

it('rejects actor, workspace, customer and source-scope substitution before model use', async () => {
  const id = randomUUID();
  await send(id, '个人历史');
  const count = seen.length;
  await expect(send(id, '窃取历史', entityScope(), randomUUID(), member)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    modelQuery(
      db,
      actor,
      otherWorkspace,
      { chat_id: id, question: '继续', scope: entityScope() },
      model,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(send(id, '换客户', entityScope(otherCustomer))).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    send(id, '换页面', { kind: 'records', object: 'people', query: '', selected_ids: [] }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    send(randomUUID(), '错误项目', {
      kind: 'entity',
      object: 'projects',
      customer_id: otherCustomer,
      record_id: project,
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(seen).toHaveLength(count);
  await expect(
    scoped(db, actor, workspace, (ctx) =>
      ctx.tx.query('UPDATE agent_chats SET origin=$3 WHERE workspace_id=$1 AND id=$2', [
        workspace,
        id,
        JSON.stringify({ kind: 'ask', label: '伪造', scope: entityScope(otherCustomer) }),
      ]),
    ),
  ).rejects.toThrow('chat scope is immutable');
});

it('revalidates source access on restore and hides revoked collection turns from model history', async () => {
  const bound = randomUUID();
  await send(bound, '客户资料', entityScope(), randomUUID(), member);
  const collectionId = randomUUID();
  const scope: AskScope = { kind: 'records', object: 'people', query: '', selected_ids: [] };
  await send(collectionId, '查询联系人', scope, randomUUID(), member);
  expect(
    (await scoped(db, member, workspace, (ctx) => validateAskSession(ctx, collectionId))).origin
      .label,
  ).toBe('联系人列表页');
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, customer, member],
    ),
  );
  try {
    await expect(
      scoped(db, member, workspace, (ctx) => validateAskSession(ctx, bound)),
    ).rejects.toMatchObject({ status: 404 });
    expect((await scoped(db, member, workspace, allChats)).map((chat) => chat.id)).not.toContain(
      bound,
    );
    expect(await scoped(db, member, workspace, (ctx) => loadAskHistory(ctx, collectionId))).toEqual(
      [],
    );
    await send(collectionId, '现在还能查到谁', scope, randomUUID(), member);
    expect(seen.at(-1)?.history).toEqual([]);
    expect(JSON.stringify(seen.at(-1))).not.toContain('synthetic@fixture.invalid');
  } finally {
    await scoped(db, actor, workspace, (ctx) =>
      ctx.tx.query(
        "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
        [workspace, customer, member],
      ),
    );
  }
});

it('rejects changed data and aborted generations without saving either message', async () => {
  const id = randomUUID();
  hook = async (input) => {
    await scoped(db, actor, workspace, (ctx) =>
      insert(ctx, 'customer_records', {
        customer_id: customer,
        kind: 'inference',
        body: 'Synthetic new evidence',
        created_by: actor,
      }),
    );
    return succeed(input);
  };
  await expect(send(id, '查询')).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.query('SELECT id FROM agent_chats WHERE workspace_id=$1 AND id=$2', [workspace, id]))
      .rows,
  ).toHaveLength(0);
  const controller = new AbortController();
  hook = async (input) => {
    controller.abort();
    return succeed(input);
  };
  await expect(
    modelQuery(
      db,
      actor,
      workspace,
      { chat_id: id, question: '中断', scope: entityScope() },
      model,
      { signal: controller.signal, onText: async () => {} },
    ),
  ).rejects.toThrow();
  expect(
    (
      await db.query('SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2', [
        workspace,
        id,
      ])
    ).rows,
  ).toHaveLength(0);
});

it('keeps local mode honest and saves explicit user preferences atomically for later sessions', async () => {
  const localId = randomUUID();
  const local = await send(localId, '查看档案信息', entityScope(), randomUUID(), actor, {});
  expect(local).toMatchObject({ mode: 'local', chat_id: localId });
  expect(
    (
      await db.query<{ model: string | null }>(
        "SELECT model FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2 AND role='assistant'",
        [workspace, localId],
      )
    ).rows[0].model,
  ).toBeNull();
  const id = randomUUID(),
    requestId = randomUUID();
  const reply = await send(id, '记住，回答简短直接', entityScope(), requestId);
  expect(reply.preference).toMatchObject({
    status: 'saved',
    preference: { category: 'response_length', value: 'concise' },
  });
  expect(await send(id, '记住，回答简短直接', entityScope(), requestId)).toEqual(reply);
  await send(randomUUID(), '另一个会话');
  expect(seen.at(-1)?.user_preferences).toContainEqual({
    category: 'response_length',
    value: '回答简短直接。',
  });
  const failedId = randomUUID();
  hook = async () => {
    throw new Error('failed save');
  };
  await expect(send(failedId, '记住，用英文回答')).rejects.toThrow();
  expect(
    (
      await db.query(
        "SELECT id FROM user_preferences WHERE workspace_id=$1 AND actor_id=$2 AND category='response_language'",
        [workspace, actor],
      )
    ).rows,
  ).toHaveLength(0);
});

it('remembers only the previous answer format when the same session explicitly says 以后都这样', async () => {
  const id = randomUUID();
  hook = async () => ({
    answer: '| 姓名 | 邮箱 |\n|---|---|\n| 示例 | synthetic@fixture.invalid |',
    source_ids: [],
  });
  await send(id, '联系人用表格展示');
  const reply = await send(id, '以后都这样');
  expect(reply.preference).toMatchObject({
    status: 'saved',
    preference: { category: 'response_format', value: 'table' },
  });
  expect(reply.body).toContain('已记住个人偏好');
  const stored = (
    await db.query<{ category: string; value: string }>(
      "SELECT category,value FROM user_preferences WHERE workspace_id=$1 AND actor_id=$2 AND category='response_format'",
      [workspace, actor],
    )
  ).rows;
  expect(stored).toEqual([{ category: 'response_format', value: 'table' }]);
  expect(JSON.stringify(stored)).not.toContain('synthetic@fixture.invalid');
});

it('redacts persisted project answers if a mail moves to another project of the same customer', async () => {
  const account = randomUUID(),
    mailId = randomUUID();
  const secondProject = await scoped(db, actor, workspace, async (ctx) => {
    const target = await insert(ctx, 'projects', {
      customer_id: customer,
      name: 'Synthetic Other Project',
      type: 'sample',
    });
    await ctx.tx.query(
      "INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,'ask-session@163.com','synthetic-unused',$3)",
      [workspace, account, actor],
    );
    await ctx.tx.query(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
       VALUES($1,$2,$3,'ask-session@163.com',$4,$5,$6,'Synthetic Project Mail','[{"address":"synthetic@fixture.invalid"}]','[]','[]','["synthetic@fixture.invalid"]',now(),'inbound','Synthetic confidential project detail','fixture')`,
      [workspace, mailId, account, customer, project, mailId],
    );
    return String(target.id);
  });
  const id = randomUUID();
  const scope: AskScope = {
    kind: 'entity',
    object: 'projects',
    customer_id: customer,
    record_id: project,
  };
  hook = async (input) => ({
    answer: 'Synthetic confidential project detail',
    source_ids: input.snapshot.sources
      .filter((source) => source.ref?.kind === 'record')
      .map((source) => source.id),
  });
  await send(id, '查看项目邮件', scope);
  expect(
    JSON.stringify(await scoped(db, actor, workspace, (ctx) => chatDetail(ctx, id))),
  ).toContain('Synthetic confidential project detail');
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query('UPDATE mail_messages SET project_id=$3 WHERE workspace_id=$1 AND id=$2', [
      workspace,
      mailId,
      secondProject,
    ]),
  );
  const detail = await scoped(db, actor, workspace, (ctx) => chatDetail(ctx, id));
  expect(JSON.stringify(detail)).not.toContain('Synthetic confidential project detail');
  expect(detail.messages.find((message) => message.role === 'assistant')).toMatchObject({
    body: '这条回答的部分依据已不可访问，请重新提问。',
    sources: [],
  });
});

it('omits deleted-list Ask sources from the legacy session listing and refuses to restore them', async () => {
  const list = await scoped(db, actor, workspace, (ctx) =>
    createList(ctx, { name: 'Synthetic Private List', object: 'people' }),
  );
  const id = randomUUID();
  const scope: AskScope = {
    kind: 'list',
    list_id: String(list.id),
    config: defaultListConfig([]),
    query: '',
    page: 1,
    selected_ids: [],
  };
  await send(id, '查看清单', scope);
  expect(
    (await scoped(db, actor, workspace, allChats)).find((chat) => chat.id === id)?.origin?.label,
  ).toBe('清单页 · Synthetic Private List');
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query('DELETE FROM record_lists WHERE workspace_id=$1 AND id=$2', [workspace, list.id]),
  );
  expect((await scoped(db, actor, workspace, allChats)).map((chat) => chat.id)).not.toContain(id);
  await expect(scoped(db, actor, workspace, (ctx) => chatDetail(ctx, id))).rejects.toMatchObject({
    status: 404,
  });
});
