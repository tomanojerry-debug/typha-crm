import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import type { AgentModelInput } from '../server/agent-model.js';
import type { AskAnswer, AskScope } from '../shared/ask.js';
import type { AgentSource } from '../shared/agent.js';

const origin = 'http://localhost:3100';
const password = 'directory-fixture-test-password';
const companyEmail = 'company-inbox@directory.invalid';
const personEmail = 'shen.ning@directory.invalid';
const otherEmail = 'shen.ru@private.invalid';
const rawMarkers = ['A_RAW_CUSTOMER_RECORD', 'B_PRIVATE_RAW_CUSTOMER_RECORD'];
let db: Database, admin: Agent, viewer: Agent, workspace: string, actor: string, viewerId: string;
let customer: string,
  otherCustomer: string,
  person: string,
  emptyPerson: string,
  otherPerson: string;
let peopleList: string, projectList: string, project: string;
let seen: AgentModelInput[] = [];
let beforeAnswer: (() => Promise<void>) | undefined;

const headers = () => ({ origin, 'x-workspace-id': workspace });
const directory = (query = '', selected_ids: string[] = []): AskScope => ({
  kind: 'records',
  object: 'people',
  query,
  selected_ids,
});
const listScope = (list_id = peopleList, query = ''): AskScope => ({
  kind: 'list',
  list_id,
  query,
  page: 1,
  selected_ids: [],
  config: {
    columns: ['name'],
    sort: 'name',
    direction: 'asc',
    group_by: null,
    filters: { match: 'all', rules: [] },
  },
});
const entitySources = (input: AgentModelInput) =>
  input.snapshot.sources.filter((source) => source.ref?.kind === 'entity');
const lastSource = (id: string): AgentSource => {
  const source = entitySources(seen.at(-1)!).find((item) => item.ref?.id === id);
  expect(source, `expected a directory source for ${id}`).toBeDefined();
  return source!;
};
const askRequest = (
  scope: AskScope,
  agent = admin,
  question = '给我姓沈的联系人的邮箱',
  continuation?: string,
) =>
  agent
    .post('/api/ask/query')
    .set(headers())
    .send({ scope, question, ...(continuation ? { continuation } : {}) });
const ask = async (scope: AskScope, agent = admin, question?: string) =>
  (await askRequest(scope, agent, question).expect(200)).body as AskAnswer;

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Ask directory fields fixture',
    email: 'ask-directory@fixture.invalid',
    password,
    displayName: 'Directory admin',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, {
    origin,
    agent: {
      key: randomBytes(32),
      transport: {
        async generate(input) {
          seen.push(input);
          await beforeAnswer?.();
          // Reflect the actual authorized sources through the HTTP response;
          // no provider connection or hard-coded successful lookup is involved.
          const sources = entitySources(input);
          return {
            answer: sources.length
              ? sources.map((source) => `${source.title}\n${source.body}`).join('\n\n')
              : '当前范围未列出联系人。',
            source_ids: sources.map((source) => source.id),
          };
        },
      },
    },
  });
  admin = request.agent(app);
  viewer = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'ask-directory@fixture.invalid', password })
    .expect(200);
  viewerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'ask-directory-viewer@fixture.invalid', display_name: 'Viewer', password })
      .expect(201)
  ).body.actor_id;
  await viewer
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'ask-directory-viewer@fixture.invalid', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: '目录舞团 A', type: 'group', source: 'other', email: companyEmail })
      .expect(201)
  ).body.id;
  otherCustomer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: '私有目录舞团 B', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  for (const [key, customer_id, name, email] of [
    ['person', customer, '沈宁', personEmail],
    ['empty', customer, '沈空', ''],
    ['other', otherCustomer, '沈如', otherEmail],
  ] as const) {
    const id = (
      await admin.post('/api/people').set(headers()).send({ customer_id, name, email }).expect(201)
    ).body.id as string;
    if (key === 'person') person = id;
    else if (key === 'empty') emptyPerson = id;
    else otherPerson = id;
  }
  for (const [customer_id, body] of [
    [customer, rawMarkers[0]],
    [otherCustomer, rawMarkers[1]],
  ])
    await admin
      .post(`/api/customers/${customer_id}/records`)
      .set(headers())
      .send({ kind: 'customer_quote', body })
      .expect(201);
  await admin
    .put(`/api/customers/${customer}/access/${viewerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
  peopleList = (
    await admin
      .post('/api/lists')
      .set(headers())
      .send({
        name: '私有联系人目录清单',
        object: 'people',
        entries: [
          { customer_id: customer, person_id: person },
          { customer_id: customer, person_id: emptyPerson },
          { customer_id: otherCustomer, person_id: otherPerson },
        ],
      })
      .expect(201)
  ).body.id;
  project = (
    await admin
      .post(`/api/customers/${customer}/projects`)
      .set(headers())
      .send({ name: '目录样衣项目', type: 'sample' })
      .expect(201)
  ).body.id;
  projectList = (
    await admin
      .post('/api/lists')
      .set(headers())
      .send({
        name: '项目目录清单',
        object: 'projects',
        entries: [{ customer_id: customer, project_id: project }],
      })
      .expect(201)
  ).body.id;
  await scoped(db, actor, workspace, async (ctx) => {
    const rows = Array.from({ length: 31 }, (_, i) => ({
      id: randomUUID(),
      name: `分页样例${String(i + 1).padStart(2, '0')}`,
      email: `page-${i + 1}@directory.invalid`,
    }));
    await ctx.tx.query(
      `INSERT INTO people(workspace_id,customer_id,id,name,email)
       SELECT $1,$2,seed.id,seed.name,seed.email
       FROM unnest($3::uuid[],$4::text[],$5::text[]) AS seed(id,name,email)`,
      [
        workspace,
        customer,
        rows.map((row) => row.id),
        rows.map((row) => row.name),
        rows.map((row) => row.email),
      ],
    );
  });
}, 30000);

beforeEach(() => {
  seen = [];
  beforeAnswer = undefined;
});
afterAll(() => db.close());

it('passes personal email and company names from both records and people lists to the model', async () => {
  for (const scope of [directory('q=沈宁'), listScope(peopleList, '沈宁')]) {
    const result = await ask(scope);
    const source = lastSource(person);
    expect(source.body).toContain(personEmail);
    expect(source.body).toContain('目录舞团 A');
    expect(source.body).not.toContain(companyEmail);
    expect(result).toMatchObject({ mode: 'model', sources: [{ id: person, object: 'people' }] });
    expect(result.body).toContain(personEmail);
    for (const marker of rawMarkers) expect(JSON.stringify(seen.at(-1))).not.toContain(marker);
  }
  const count = seen.length;
  await askRequest(listScope(), viewer).expect(404);
  expect(seen).toHaveLength(count);
});

it('marks an empty personal email as unfilled instead of substituting the company inbox', async () => {
  for (const scope of [directory('q=沈空'), listScope(peopleList, '沈空')]) {
    const result = await ask(scope);
    expect(lastSource(emptyPerson).body).toContain('未填写');
    expect(lastSource(emptyPerson).body).not.toContain(companyEmail);
    expect(JSON.stringify(seen.at(-1)!.snapshot)).not.toContain(personEmail);
    expect(result.body).not.toContain(companyEmail);
    expect(result.sources.map((source) => source.id)).toEqual([emptyPerson]);
  }
});

it('keeps several matching people and their emails in separate verifiable sources', async () => {
  const result = await ask(directory('q=沈'));
  expect(lastSource(person).body).toContain(personEmail);
  expect(lastSource(person).body).toContain('目录舞团 A');
  expect(lastSource(person).body).not.toContain(otherEmail);
  expect(lastSource(otherPerson).body).toContain(otherEmail);
  expect(lastSource(otherPerson).body).toContain('私有目录舞团 B');
  expect(lastSource(otherPerson).body).not.toContain(personEmail);
  expect(result.sources.map((source) => source.id).sort()).toEqual(
    [person, emptyPerson, otherPerson].sort(),
  );
  for (const marker of rawMarkers) expect(JSON.stringify(seen[0].snapshot)).not.toContain(marker);
});

it('applies permissions, current filters and selected membership before preparing directory sources', async () => {
  await ask(directory('q=沈'), viewer);
  expect(
    entitySources(seen.at(-1)!)
      .map((source) => source.ref!.id)
      .sort(),
  ).toEqual([person, emptyPerson].sort());
  expect(JSON.stringify(seen.at(-1))).not.toContain(otherEmail);
  expect(JSON.stringify(seen.at(-1))).not.toContain('私有目录舞团 B');
  for (const marker of rawMarkers) expect(JSON.stringify(seen.at(-1))).not.toContain(marker);
  const selected = await ask(directory('q=沈', [person]), viewer);
  expect(selected.sources.map((source) => source.id)).toEqual([person]);
  expect(JSON.stringify(seen.at(-1)!.snapshot)).not.toContain('沈空');
  const count = seen.length;
  await askRequest(directory('q=沈宁', [emptyPerson]), viewer).expect(409);
  await askRequest(directory('q=沈', [otherPerson]), viewer).expect(409);
  expect(seen).toHaveLength(count);
});

it('distinguishes the filtered total from the current page and warns about unlisted results', async () => {
  await ask(directory('q=分页样例&sort=name&direction=asc&page=1'), viewer, '当前有几位联系人？');
  const first = seen.at(-1)!.snapshot;
  expect(entitySources(seen.at(-1)!)).toHaveLength(30);
  expect(first.sources.map((source) => source.body).join('\n')).toMatch(/31/);
  expect(first.warnings.join('\n')).toContain('当前页');
  expect(first.warnings.join('\n')).toMatch(/未列出|未覆盖/);
  expect(JSON.stringify(first)).not.toContain('page-31@directory.invalid');
  await ask(directory('q=分页样例&sort=name&direction=asc&page=2'), viewer, '这一页有哪些联系人？');
  expect(entitySources(seen.at(-1)!)).toHaveLength(1);
  expect(JSON.stringify(seen.at(-1)!.snapshot)).toContain('page-31@directory.invalid');
  expect(JSON.stringify(seen.at(-1)!.snapshot)).not.toContain('page-1@directory.invalid');
});

it('identifies a project-list email as the company inbox whenever that address is included', async () => {
  await ask(listScope(projectList), admin, '这个项目的联系人邮箱是什么？');
  const source = lastSource(project);
  expect(source.body).toContain('目录舞团 A');
  if (source.body.includes(companyEmail)) expect(source.body).toContain('所属公司邮箱');
  expect(source.body).not.toContain(personEmail);
  expect(source.ref).toMatchObject({ object: 'projects', customer_id: customer });
});

it('rejects an email changed during generation and invalidates the earlier directory continuation', async () => {
  const scope = directory('q=沈宁');
  const first = await ask(scope);
  beforeAnswer = async () => {
    const current = (await admin.get(`/api/people/${person}`).set(headers()).expect(200)).body;
    await admin
      .patch(`/api/people/${person}`)
      .set(headers())
      .send({ version: current.version, email: 'changed@directory.invalid' })
      .expect(200);
  };
  try {
    await askRequest(scope).expect(409);
    beforeAnswer = undefined;
    const count = seen.length;
    await askRequest(scope, admin, '继续给我邮箱', first.continuation).expect(409);
    expect(seen).toHaveLength(count);
    await ask(scope);
    expect(lastSource(person).body).toContain('changed@directory.invalid');
    expect(lastSource(person).body).not.toContain(personEmail);
  } finally {
    beforeAnswer = undefined;
    const current = (await admin.get(`/api/people/${person}`).set(headers()).expect(200)).body;
    await admin
      .patch(`/api/people/${person}`)
      .set(headers())
      .send({ version: current.version, email: personEmail })
      .expect(200);
  }
});

it('rejects revoked directory access during generation and will not resume the old continuation', async () => {
  const scope = directory('q=沈宁');
  const first = await ask(scope, viewer);
  beforeAnswer = async () => {
    await admin
      .put(`/api/customers/${customer}/access/${viewerId}`)
      .set(headers())
      .send({ access: null })
      .expect(200);
  };
  try {
    await askRequest(scope, viewer).expect(409);
    beforeAnswer = undefined;
    const count = seen.length;
    await askRequest(scope, viewer, '继续给我邮箱', first.continuation).expect(409);
    expect(seen).toHaveLength(count);
    await ask(scope, viewer);
    expect(JSON.stringify(seen.at(-1)!.snapshot)).not.toContain(personEmail);
    expect(JSON.stringify(seen.at(-1)!.snapshot)).not.toContain('沈宁');
  } finally {
    beforeAnswer = undefined;
    await admin
      .put(`/api/customers/${customer}/access/${viewerId}`)
      .set(headers())
      .send({ access: 'viewer' })
      .expect(200);
  }
});
