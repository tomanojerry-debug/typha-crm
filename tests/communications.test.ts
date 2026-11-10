import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { communicationJoin } from '../server/communications.js';
import type { Customer, Person } from '../shared/domain.js';
const origin = 'http://localhost:3100';
let db: Database,
  agent: ReturnType<typeof request.agent>,
  workspace: string,
  actor: string,
  account: string;
const h = () => ({ origin, 'x-workspace-id': workspace });
async function company(name: string) {
  return (
    await agent
      .post('/api/customers')
      .set(h())
      .send({ name, type: 'group', source: 'email' })
      .expect(201)
  ).body.id as string;
}
async function person(customer_id: string, name: string) {
  return (await agent.post('/api/people').set(h()).send({ customer_id, name }).expect(201)).body
    .id as string;
}
async function mail(
  customer: string | null,
  days: number,
  direction = 'inbound',
  people: string[] = [],
  fingerprint = randomUUID(),
  accountId = account,
  date?: string,
) {
  const id = randomUUID();
  await scoped(db, actor, workspace, async (ctx) => {
    await ctx.tx.query(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
      VALUES($1,$2,$3,'fixture@163.com',$4,$5,'Synthetic','{}','[]','[]','[]',coalesce($6::timestamptz,now()-$7::int*interval '1 day'),$8,'Synthetic','fixture')`,
      [workspace, id, accountId, customer, fingerprint, date ?? null, days, direction],
    );
    for (const p of people)
      await ctx.tx.query(
        'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
        [workspace, customer, id, p],
      );
  });
  return id;
}
const record = async (id: string) =>
  (await agent.get(`/api/customers/${id}`).set(h()).expect(200)).body as Customer;
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Communication metrics',
    email: 'metrics@fixture.invalid',
    password: 'synthetic-metrics-password',
    displayName: 'Metrics',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  account = randomUUID();
  agent = request.agent(createApp(db, { origin }));
  await agent
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'metrics@fixture.invalid', password: 'synthetic-metrics-password' })
    .expect(200);
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query(
      "INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,'fixture@163.com','synthetic-unused',$3)",
      [workspace, account, actor],
    ),
  );
}, 30000);
afterAll(() => db.close());

it('aggregates each person separately and company mail once; ignores pending, future and duplicate copies', async () => {
  const c = await company('Aggregation'),
    p1 = await person(c, 'Alice'),
    p2 = await person(c, 'Ben');
  const original = await record(c),
    fingerprint = randomUUID();
  await mail(c, 5, 'inbound', [p1, p2], fingerprint);
  await mail(c, 2, 'outbound', [p1]);
  const current = await record(c);
  await mail(c, 200, 'inbound', [p2]); // Old history imported after recent messages.
  await mail(null, 1);
  await mail(c, -20, 'inbound', [p1]);
  const second = randomUUID();
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query(
      "INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,'second@163.com','synthetic-unused',$3)",
      [workspace, second, actor],
    ),
  );
  await mail(c, 5, 'inbound', [p1, p2], fingerprint, second);
  const result = await record(c);
  expect(result).toMatchObject({
    email_count: 3,
    email_count_30d: 2,
    email_strength: 3,
    last_email_at: current.last_email_at,
    status: original.status,
    version: original.version,
    updated_at: original.updated_at,
  });
  expect(new Date(result.first_email_at!).getTime()).toBeLessThan(
    new Date(result.last_email_at!).getTime(),
  );
  for (const [id, count] of [
    [p1, 2],
    [p2, 2],
  ] as const)
    expect((await agent.get(`/api/people/${id}`).set(h()).expect(200)).body.email_count).toBe(
      count,
    );
  await agent
    .patch(`/api/customers/${c}`)
    .set(h())
    .send({ version: original.version, last_email_at: new Date().toISOString() })
    .expect(400);
});

it('grades frequency, reciprocity and recency with a transparent email-only rule', async () => {
  for (const [days, count, reciprocal, grade] of [
    [0, 0, false, 0],
    [181, 1, false, 1],
    [91, 1, false, 2],
    [31, 3, true, 3],
    [1, 10, false, 3],
    [1, 2, true, 3],
    [1, 3, true, 4],
    [1, 10, true, 5],
  ] as const) {
    const c = await company(`Grade ${days}-${count}-${reciprocal}`);
    for (let i = 0; i < count; i++)
      await mail(c, days, reciprocal && i === 0 ? 'outbound' : 'inbound');
    expect((await record(c)).email_strength).toBe(grade);
  }
});

it('uses exact age boundaries and decays strength without changing record fields', async () => {
  const c = await company('Age boundary');
  const id = await mail(c, 1);
  await scoped(db, actor, workspace, async (ctx) => {
    for (const [interval, expected] of [
      ['30 days', 3],
      ['90 days', 3],
      ['90 days 1 second', 2],
      ['180 days', 2],
      ['180 days 1 second', 1],
    ] as const) {
      await ctx.tx.query(
        'UPDATE mail_messages SET occurred_at=now()-$1::interval WHERE workspace_id=$2 AND id=$3',
        [interval, workspace, id],
      );
      const r = await ctx.tx.query<{ email_strength: number }>(
        `SELECT communication.email_strength FROM customers c ${communicationJoin('customers')} WHERE c.workspace_id=$1 AND c.id=$2`,
        [workspace, c],
      );
      expect(r.rows[0].email_strength).toBe(expected);
    }
  });
});

it('sorts and filters on computed values before pagination for both objects, including China date boundaries', async () => {
  const c = await company('Paging customer');
  const ids: string[] = [];
  for (let i = 0; i < 32; i++) {
    const p = await person(c, `Paging ${i}`);
    ids.push(p);
    await mail(c, 32 - i, 'inbound', [p]);
  }
  const list = (
    await agent
      .get('/api/people')
      .set(h())
      .query({ customer_id: c, sort: 'last_email_at', direction: 'desc' })
      .expect(200)
  ).body;
  expect(list.total).toBe(32);
  expect(list.items).toHaveLength(30);
  expect(list.items[0].id).toBe(ids[31]);
  const page2 = (
    await agent
      .get('/api/people')
      .set(h())
      .query({ customer_id: c, sort: 'last_email_at', direction: 'desc', page: 2 })
      .expect(200)
  ).body;
  expect(page2.items.map((p: Person) => p.id)).toEqual([ids[1], ids[0]]);
  const dated = await company('China date'),
    p = await person(dated, 'Date contact');
  await mail(dated, 0, 'inbound', [p], undefined, undefined, '2020-01-01T16:30:00.000Z');
  const filters = JSON.stringify({
    match: 'all',
    rules: [{ field: 'last_email_at', operator: 'is', value: '2020-01-02' }],
  });
  for (const object of ['customers', 'people']) {
    const result = (
      await agent
        .get(`/api/${object}`)
        .set(h())
        .query({ filters, sort: 'last_email_at' })
        .expect(200)
    ).body;
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe(object === 'customers' ? dated : p);
  }
  const strong = JSON.stringify({
    match: 'all',
    rules: [{ field: 'email_strength', operator: 'is', value: '5' }],
  });
  const result = (
    await agent
      .get('/api/customers')
      .set(h())
      .query({ filters: strong, sort: 'email_strength' })
      .expect(200)
  ).body;
  expect(result.total).toBe(1);
  expect(Object.values(result.groups)).toEqual([1]);
  const missing = JSON.stringify({
    match: 'all',
    rules: [{ field: 'last_email_at', operator: 'empty', value: '' }],
  });
  expect(
    (
      await agent.get('/api/customers').set(h()).query({ filters: missing }).expect(200)
    ).body.items.every((r: Customer) => r.email_count === 0),
  ).toBe(true);
});
