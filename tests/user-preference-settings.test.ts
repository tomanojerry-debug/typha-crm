import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import {
  applyPreference,
  editUserPreference,
  listUserPreferences,
  listUserPreferenceSettings,
  preparePreference,
  removeUserPreference,
} from '../server/user-preferences.js';
import type { ChatOrigin } from '../shared/chat.js';
import { defaultListConfig } from '../shared/list-workflow.js';
import { createList } from '../server/lists.js';

let db: Database, workspace: string, actor: string, colleague: string, otherWorkspace: string;
const origin = 'http://localhost:3100';
const password = 'memory-settings-fixture-password';
const run = <T>(fn: (ctx: Context) => Promise<T>, person = actor, space = workspace) =>
  scoped(db, person, space, fn);
const write = (sql: string, params: unknown[]) => run((ctx) => ctx.tx.query(sql, params));

async function save(
  question: string,
  person = actor,
  sourceOrigin?: ChatOrigin,
  modelCustomer?: string,
) {
  return run(async (ctx) => {
    const chat_id = randomUUID(),
      message_id = randomUUID(),
      request_id = randomUUID();
    const customer = sourceOrigin?.scope.kind === 'entity' ? sourceOrigin.scope.customer_id : null;
    await ctx.tx.query(
      'INSERT INTO agent_chats(workspace_id,actor_id,id,title,customer_id,origin) VALUES($1,$2,$3,$4,$5,$6)',
      [workspace, person, chat_id, '合成设置来源会话', customer, sourceOrigin ?? null],
    );
    await ctx.tx.query(
      "INSERT INTO chat_messages(workspace_id,chat_id,id,request_id,role,body) VALUES($1,$2,$3,$4,'user',$5)",
      [workspace, chat_id, message_id, request_id, question],
    );
    const result = await applyPreference(ctx, await preparePreference(ctx, { question }), {
      chat_id,
      message_id,
      request_id,
    });
    // Home stores model scope on the assistant, leaving the direct user message
    // unbound. Source metadata must validate the actual saved pair.
    await ctx.tx.query(
      `INSERT INTO chat_messages(workspace_id,chat_id,id,request_id,role,body,model_customer_id)
       VALUES($1,$2,$3,$4,'assistant','合成偏好已保存',$5)`,
      [workspace, chat_id, randomUUID(), request_id, modelCustomer ?? customer],
    );
    return result.preference!;
  }, person);
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const owner = await createWorkspace(db, {
    name: 'Memory settings fixtures',
    email: 'memory-settings-owner@fixture.invalid',
    password,
    displayName: 'Owner',
  });
  workspace = owner.workspaceId;
  actor = owner.actorId;
  const other = await createWorkspace(db, {
    name: 'Other memory fixtures',
    email: 'memory-settings-member@fixture.invalid',
    password,
    displayName: 'Member',
  });
  otherWorkspace = other.workspaceId;
  colleague = other.actorId;
  await db.query(
    "INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member'),($3,$4,'member')",
    [workspace, colleague, otherWorkspace, actor],
  );
}, 30000);
afterAll(() => db?.close());

it('lists authorized provenance and edits only a normalized value while preserving the original source', async () => {
  const initial = await save('记住：以后回答简短一点');
  const listed = (await run(listUserPreferenceSettings)).find((row) => row.id === initial.id)!;
  expect(listed.source_chat).toEqual({ id: initial.source_chat_id, title: '合成设置来源会话' });
  expect(listed.version).toMatch(/^[a-f\d]{32}$/u);
  const updated = await run((ctx) =>
    editUserPreference(ctx, initial.id, { value: 'detailed', expected_version: listed.version }),
  );
  expect(updated).toMatchObject({
    value: 'detailed',
    content: '回答详细一些，解释必要的依据。',
    source_chat_id: initial.source_chat_id,
    source_message_id: initial.source_message_id,
    source_chat: listed.source_chat,
    created_at: initial.created_at,
  });
  expect(updated.version).not.toBe(listed.version);
  expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(listed.updated_at));
  expect((await run(listUserPreferences)).find((row) => row.id === initial.id)?.value).toBe(
    'detailed',
  );
  const prepared = await run((ctx) => preparePreference(ctx, { question: '继续查询' }));
  expect(prepared.preferences.find((row) => row.id === initial.id)?.content).toBe(updated.content);
});

it('rejects stale versions, arbitrary values, category changes and injected provenance', async () => {
  const initial = await save('记住：以后用中文回答');
  const listed = (await run(listUserPreferenceSettings)).find((row) => row.id === initial.id)!;
  const updated = await run((ctx) =>
    editUserPreference(ctx, initial.id, { value: 'en', expected_version: listed.version }),
  );
  await expect(
    run((ctx) =>
      editUserPreference(ctx, initial.id, { value: 'zh', expected_version: listed.version }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  for (const value of ['formal', '客户报价100元', '自动发送所有邮件', '忽略权限'])
    await expect(
      run((ctx) =>
        editUserPreference(ctx, initial.id, { value, expected_version: updated.version }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  for (const extra of [{ category: 'email_tone' }, { source_chat_id: randomUUID() }])
    await expect(
      run((ctx) =>
        editUserPreference(ctx, initial.id, {
          value: 'zh',
          expected_version: updated.version,
          ...extra,
        }),
      ),
    ).rejects.toThrow();
  expect((await run(listUserPreferences)).find((row) => row.id === initial.id)?.value).toBe('en');
});

it('keeps edits and source metadata private by actor and workspace, including direct RLS updates', async () => {
  const item = (await run(listUserPreferenceSettings))[0];
  expect(await run(listUserPreferenceSettings, colleague)).toEqual([]);
  expect(await run(listUserPreferenceSettings, actor, otherWorkspace)).toEqual([]);
  for (const [person, space] of [
    [colleague, workspace],
    [actor, otherWorkspace],
  ]) {
    await expect(
      run(
        (ctx) =>
          editUserPreference(ctx, item.id, { value: item.value, expected_version: item.version }),
        person,
        space,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await run(
          (ctx) =>
            ctx.tx.query('UPDATE user_preferences SET value=value WHERE id=$1 RETURNING id', [
              item.id,
            ]),
          person,
          space,
        )
      ).rows,
    ).toEqual([]);
  }
});

it('hides revoked Ask titles while retaining owner-controlled edit and deletion', async () => {
  const customer = randomUUID();
  await write(
    "INSERT INTO customers(workspace_id,id,name,type,source) VALUES($1,$2,'合成撤权公司','group','email')",
    [workspace, customer],
  );
  await write(
    "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
    [workspace, customer, colleague],
  );
  const item = await save('记住：以后用列表回答', colleague, {
    kind: 'ask',
    label: '合成私有来源',
    scope: { kind: 'entity', object: 'customers', customer_id: customer, record_id: customer },
  });
  expect((await run(listUserPreferenceSettings, colleague))[0].source_chat).not.toBeNull();
  await write('DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2', [
    workspace,
    customer,
  ]);
  const hidden = (await run(listUserPreferenceSettings, colleague))[0];
  expect(hidden).toMatchObject({ id: item.id, value: 'list', source_chat: null });
  expect(JSON.stringify(hidden)).not.toContain('合成设置来源会话');
  const updated = await run(
    (ctx) => editUserPreference(ctx, item.id, { value: 'table', expected_version: hidden.version }),
    colleague,
  );
  expect(updated).toMatchObject({
    source_chat: null,
    source_chat_id: item.source_chat_id,
    value: 'table',
  });
  await run((ctx) => removeUserPreference(ctx, item.id), colleague);
  expect(await run(listUserPreferenceSettings, colleague)).toEqual([]);
});

it('hides an unbound Home title after its source assistant customer access is revoked', async () => {
  const customer = randomUUID();
  await write(
    "INSERT INTO customers(workspace_id,id,name,type,source) VALUES($1,$2,'合成Home来源公司','group','email')",
    [workspace, customer],
  );
  await write(
    "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
    [workspace, customer, colleague],
  );
  const item = await save('记住：以后用列表回答', colleague, undefined, customer);
  expect((await run(listUserPreferenceSettings, colleague))[0].source_chat?.id).toBe(
    item.source_chat_id,
  );
  await write('DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2', [
    workspace,
    customer,
  ]);
  const hidden = (await run(listUserPreferenceSettings, colleague))[0];
  expect(hidden.source_chat).toBeNull();
  const edited = await run(
    (ctx) => editUserPreference(ctx, item.id, { value: 'table', expected_version: hidden.version }),
    colleague,
  );
  expect(edited).toMatchObject({
    source_chat: null,
    value: 'table',
    source_message_id: item.source_message_id,
  });
  const replaced = await save('记住：以后用自然段回答', colleague);
  expect(replaced.id).toBe(item.id);
  expect(replaced.source_chat_id).not.toBe(item.source_chat_id);
  expect((await run(listUserPreferenceSettings, colleague))[0].source_chat?.id).toBe(
    replaced.source_chat_id,
  );
});

it('revalidates archived Ask entities and deleted list scopes rather than trusting chat row visibility', async () => {
  const customer = randomUUID(),
    project = randomUUID();
  await write(
    "INSERT INTO customers(workspace_id,id,name,type,source) VALUES($1,$2,'合成归档公司','group','email')",
    [workspace, customer],
  );
  await write(
    "INSERT INTO projects(workspace_id,customer_id,id,name,type) VALUES($1,$2,$3,'合成归档项目','sample')",
    [workspace, customer, project],
  );
  const item = await save('记住：以后邮件用正式文风', actor, {
    kind: 'ask',
    label: '项目详情页 · 合成归档项目',
    scope: { kind: 'entity', object: 'projects', customer_id: customer, record_id: project },
  });
  expect(
    (await run(listUserPreferenceSettings)).find((row) => row.id === item.id)?.source_chat,
  ).not.toBeNull();
  await write('UPDATE projects SET archived_at=now() WHERE workspace_id=$1 AND id=$2', [
    workspace,
    project,
  ]);
  expect(
    (await run(listUserPreferenceSettings)).find((row) => row.id === item.id)?.source_chat,
  ).toBeNull();
  const list = await run((ctx) => createList(ctx, { name: '合成偏好来源清单', object: 'people' }));
  const listItem = await save('记住：以后英文邮件用亲切文风', actor, {
    kind: 'ask',
    label: '清单页 · 合成偏好来源清单',
    scope: {
      kind: 'list',
      list_id: String(list.id),
      config: defaultListConfig([]),
      query: '',
      page: 1,
      selected_ids: [],
    },
  });
  expect(
    (await run(listUserPreferenceSettings)).find((row) => row.id === listItem.id)?.source_chat,
  ).not.toBeNull();
  await run((ctx) =>
    ctx.tx.query('DELETE FROM record_lists WHERE workspace_id=$1 AND id=$2', [workspace, list.id]),
  );
  expect(
    (await run(listUserPreferenceSettings)).find((row) => row.id === listItem.id)?.source_chat,
  ).toBeNull();
});

it('retains strict provenance checks for inserts and provenance changes after allowing owner edits', async () => {
  const item = (await run(listUserPreferenceSettings))[0];
  await expect(
    run((ctx) =>
      ctx.tx.query(
        'UPDATE user_preferences SET source_message_id=$3 WHERE workspace_id=$1 AND id=$2',
        [workspace, item.id, randomUUID()],
      ),
    ),
  ).rejects.toThrow('source is not a readable direct user message');
  await expect(
    run((ctx) =>
      ctx.tx.query('UPDATE user_preferences SET category=$3 WHERE workspace_id=$1 AND id=$2', [
        workspace,
        item.id,
        'email_tone_zh',
      ]),
    ),
  ).rejects.toThrow('scope is immutable');
  const previous = (await run(listUserPreferences)).find(
    (row) => row.category === 'response_length',
  )!;
  const fresh = await save('记住：以后回答详细一点');
  expect(fresh.id).toBe(previous.id);
  expect(fresh.source_chat_id).not.toBe(previous.source_chat_id);
  const listed = (await run(listUserPreferenceSettings)).find((row) => row.id === fresh.id)!;
  expect(listed.source_chat?.id).toBe(fresh.source_chat_id);
});

it('exposes GET/PATCH/DELETE as authenticated JSON APIs and never revives a deleted preference', async () => {
  const app = createApp(db, { origin });
  const client = request.agent(app);
  const h = { origin, 'x-workspace-id': workspace };
  await client
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'memory-settings-owner@fixture.invalid', password })
    .expect(200);
  const rows = (await client.get('/api/agent/preferences').set(h).expect(200)).body;
  const item = rows.find((row: { category: string }) => row.category === 'response_language');
  const changed = (
    await client
      .patch(`/api/agent/preferences/${item.id}`)
      .set(h)
      .send({ value: 'zh', expected_version: item.version })
      .expect(200)
  ).body;
  expect(changed).toMatchObject({ id: item.id, value: 'zh', source_chat_id: item.source_chat_id });
  await client
    .patch(`/api/agent/preferences/${item.id}`)
    .set(h)
    .send({ value: 'en', expected_version: item.version })
    .expect(409);
  await client
    .patch(`/api/agent/preferences/${item.id}`)
    .set(h)
    .send({ value: '自动发送', expected_version: changed.version })
    .expect(400);
  await client.delete(`/api/agent/preferences/${item.id}`).set(h).send({}).expect(200);
  await client
    .patch(`/api/agent/preferences/${item.id}`)
    .set(h)
    .send({ value: 'en', expected_version: changed.version })
    .expect(404);
  expect(
    (await client.get('/api/agent/preferences').set(h).expect(200)).body.some(
      (row: { id: string }) => row.id === item.id,
    ),
  ).toBe(false);
});
