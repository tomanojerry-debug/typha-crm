import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { defaultView, personSorts } from '../shared/views.js';
const origin = 'http://localhost:3100',
  password = 'people-test-password';
let db: Database,
  admin: Agent,
  viewer: Agent,
  editor: Agent,
  w: string,
  actor: string,
  viewerId: string,
  editorId: string,
  a: string,
  b: string,
  p: string;
const h = () => ({ origin, 'x-workspace-id': w });
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'People tests',
    email: 'people-admin@example.com',
    password,
    displayName: 'Admin',
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  viewer = request.agent(app);
  editor = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'people-admin@example.com', password })
    .expect(200);
  for (const [email, agent] of [
    ['people-viewer@example.com', viewer],
    ['people-editor@example.com', editor],
  ] as const) {
    const member = (
      await admin
        .post('/api/members')
        .set(h())
        .send({ email, display_name: email, password })
        .expect(201)
    ).body;
    await agent.post('/api/auth/login').set('origin', origin).send({ email, password }).expect(200);
    if (agent === viewer) viewerId = member.actor_id;
    else editorId = member.actor_id;
  }
  a = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: 'Studio A',
        type: 'group',
        source: 'email',
        contact_name: 'Alice',
        email: 'alice@example.com',
        owner_id: actor,
      })
      .expect(201)
  ).body.id;
  b = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({ name: 'Studio B', type: 'group', source: 'store' })
      .expect(201)
  ).body.id;
  for (const [id, access] of [
    [viewerId, 'viewer'],
    [editorId, 'editor'],
  ])
    await admin.put(`/api/customers/${a}/access/${id}`).set(h()).send({ access }).expect(200);
  p = (await admin.get('/api/people').set(h()).expect(200)).body.items[0].id;
}, 30000);
afterAll(() => db.close());
it('preserves explicit primary contacts and creates multiple people for one company', async () => {
  const first = (await admin.get(`/api/people/${p}`).set(h()).expect(200)).body;
  expect(first.name).toBe('Alice');
  expect(first.is_primary).toBe(true);
  expect(first.customer_id).toBe(a);
  await editor
    .post('/api/people')
    .set(h())
    .send({ customer_id: a, name: 'Bob', job_title: '采购', email: 'bob@example.com' })
    .expect(201);
  expect(
    (await admin.get('/api/people').set(h()).query({ customer_id: a }).expect(200)).body.total,
  ).toBe(2);
  expect(
    (await admin.get('/api/people').set(h()).query({ customer_id: b }).expect(200)).body.total,
  ).toBe(0);
});
it('enforces reads and writes by customer and rejects changing ownership', async () => {
  await viewer.post('/api/people').set(h()).send({ customer_id: a, name: 'Forbidden' }).expect(403);
  await editor.post('/api/people').set(h()).send({ customer_id: b, name: 'Forbidden' }).expect(404);
  const secret = (
    await admin
      .post('/api/people')
      .set(h())
      .send({ customer_id: b, name: 'Secret person' })
      .expect(201)
  ).body;
  await viewer.get(`/api/people/${secret.id}`).set(h()).expect(404);
  await viewer
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ version: 1, name: 'Forbidden' })
    .expect(403);
  await admin.patch(`/api/people/${p}`).set(h()).send({ version: 1, customer_id: b }).expect(400);
  await expect(
    scoped(db, editorId, w, (ctx) => ctx.tx.query('SELECT * FROM people WHERE id=$1', [secret.id])),
  ).resolves.toMatchObject({ rows: [] });
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query('UPDATE people SET customer_id=$1 WHERE id=$2', [b, p]),
    ),
  ).rejects.toThrow();
  const other = await createWorkspace(db, {
    name: 'Other',
    email: 'other-people@example.com',
    password,
    displayName: 'Other',
  });
  await viewer
    .get('/api/people')
    .set({ ...h(), 'x-workspace-id': other.workspaceId })
    .expect(404);
});
it('keeps primary contact edits consistent in both directions and rejects stale versions', async () => {
  const updated = (
    await editor
      .patch(`/api/people/${p}`)
      .set(h())
      .send({ version: 1, name: 'Alice updated', email: 'new@example.com' })
      .expect(200)
  ).body;
  const company = (await admin.get(`/api/customers/${a}`).set(h()).expect(200)).body;
  expect(company.contact_name).toBe('Alice updated');
  expect(company.email).toBe('new@example.com');
  await editor.patch(`/api/people/${p}`).set(h()).send({ version: 1, name: 'Stale' }).expect(409);
  await editor
    .patch(`/api/customers/${a}`)
    .set(h())
    .send({ version: company.version, contact_name: 'Alice from company' })
    .expect(200);
  const person = (await admin.get(`/api/people/${p}`).set(h()).expect(200)).body;
  expect(person.name).toBe('Alice from company');
  expect(person.version).toBe(updated.version + 1);
});
it('renames the company from primary and secondary contacts without changing their scope', async () => {
  const company = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: 'Rename fixture',
        type: 'group',
        source: 'other',
        contact_name: 'Primary fixture',
        email: 'primary@example.com',
      })
      .expect(201)
  ).body;
  const primary = (
    await admin.get('/api/people').set(h()).query({ customer_id: company.id }).expect(200)
  ).body.items[0];
  const secondary = (
    await admin
      .post('/api/people')
      .set(h())
      .send({ customer_id: company.id, name: 'Secondary fixture' })
      .expect(201)
  ).body;
  const renamed = (
    await admin
      .patch(`/api/people/${primary.id}`)
      .set(h())
      .send({
        version: primary.version,
        customer_name: '  Renamed fixture  ',
        customer_version: primary.customer_version,
        name: 'Updated primary',
      })
      .expect(200)
  ).body;
  expect(renamed).toMatchObject({
    customer_id: company.id,
    customer_name: 'Renamed fixture',
    name: 'Updated primary',
  });
  const related = (await admin.get(`/api/people/${secondary.id}`).set(h()).expect(200)).body;
  expect(related.customer_name).toBe('Renamed fixture');
  const again = (
    await admin
      .patch(`/api/people/${secondary.id}`)
      .set(h())
      .send({
        version: related.version,
        customer_name: 'Final fixture',
        customer_version: related.customer_version,
      })
      .expect(200)
  ).body;
  expect(again).toMatchObject({ customer_id: company.id, version: related.version + 1 });
  expect((await admin.get(`/api/customers/${company.id}`).set(h()).expect(200)).body).toMatchObject(
    {
      name: 'Final fixture',
      contact_name: 'Updated primary',
      email: 'primary@example.com',
    },
  );
});
it('rolls back both edits on stale company or contact versions', async () => {
  const current = (await admin.get(`/api/people/${p}`).set(h()).expect(200)).body;
  const company = (await admin.get(`/api/customers/${a}`).set(h()).expect(200)).body;
  await editor
    .patch(`/api/customers/${a}`)
    .set(h())
    .send({ version: company.version, region: 'Updated region' })
    .expect(200);
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({
      version: current.version,
      name: 'Should roll back',
      customer_name: 'Stale company rename',
      customer_version: company.version,
    })
    .expect(409);
  const fresh = (await admin.get(`/api/people/${p}`).set(h()).expect(200)).body;
  expect(fresh.name).toBe(current.name);
  expect(fresh.version).toBe(current.version);
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ version: fresh.version, job_title: 'Updated role' })
    .expect(200);
  const afterEdit = (await admin.get(`/api/people/${p}`).set(h()).expect(200)).body;
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({
      version: fresh.version,
      customer_name: 'Stale contact rename',
      customer_version: afterEdit.customer_version,
    })
    .expect(409);
  expect((await admin.get(`/api/customers/${a}`).set(h()).expect(200)).body.name).toBe(
    company.name,
  );
});
it('validates company renames and requires the existing customer edit permission', async () => {
  const current = (await admin.get(`/api/people/${p}`).set(h()).expect(200)).body;
  const body = {
    version: current.version,
    customer_name: 'Forbidden rename',
    customer_version: current.customer_version,
  };
  await viewer.patch(`/api/people/${p}`).set(h()).send(body).expect(403);
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ ...body, customer_name: '   ' })
    .expect(400);
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ version: current.version, customer_name: 'Missing version' })
    .expect(400);
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ version: current.version, customer_version: current.customer_version })
    .expect(400);
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ ...body, customer_id: b })
    .expect(400);
  expect((await admin.get(`/api/people/${p}`).set(h()).expect(200)).body).toMatchObject({
    customer_name: current.customer_name,
    customer_id: a,
    version: current.version,
  });
});
it('supports scoped Lists, saved Views, filtering and every visible column sort', async () => {
  const list = (
    await viewer
      .post('/api/lists')
      .set(h())
      .send({ object: 'people', name: 'Buying team', entries: [{ customer_id: a, person_id: p }] })
      .expect(201)
  ).body;
  await viewer
    .post(`/api/lists/${list.id}/entries`)
    .set(h())
    .send({ entries: [{ customer_id: a, person_id: p }] })
    .expect(200);
  expect(
    (await viewer.get('/api/people').set(h()).query({ list_id: list.id }).expect(200)).body.total,
  ).toBe(1);
  await admin.get('/api/people').set(h()).query({ list_id: list.id }).expect(404);
  const config = {
    ...defaultView('people'),
    columns: ['name', 'email'],
    filters: {
      match: 'all',
      rules: [
        { field: 'customer_name', operator: 'contains', value: 'Studio' },
        { field: 'owner', operator: 'is', value: actor },
      ],
    },
  };
  await viewer
    .post('/api/views')
    .set(h())
    .send({ object: 'people', list_id: list.id, name: 'Team emails', config })
    .expect(201);
  expect(
    (
      await viewer
        .get('/api/people')
        .set(h())
        .query({ filters: JSON.stringify(config.filters) })
        .expect(200)
    ).body.total,
  ).toBe(2);
  for (const sort of Object.keys(personSorts))
    await viewer.get('/api/people').set(h()).query({ sort }).expect(200);
  await viewer
    .delete(`/api/lists/${list.id}/entries`)
    .set(h())
    .send({ entries: [{ customer_id: a, person_id: p }] })
    .expect(200);
  await viewer.get(`/api/people/${p}`).set(h()).expect(200);
});
it('saves standalone People card views without adding project fields or widening access', async () => {
  const config = {
    ...defaultView('people'),
    layout: 'board',
    columns: ['name', 'customer_name', 'job_title', 'email', 'owner'],
  };
  const saved = (
    await viewer
      .post('/api/views')
      .set(h())
      .send({ object: 'people', name: 'Contact cards', config })
      .expect(201)
  ).body;
  expect(saved).toMatchObject({ object: 'people', list_id: null, config });
  expect((await viewer.get('/api/views').set(h()).expect(200)).body).toContainEqual(saved);
  expect(
    (await admin.get('/api/views').set(h()).expect(200)).body.some(
      (view: { id: string }) => view.id === saved.id,
    ),
  ).toBe(false);
  await admin
    .patch(`/api/views/${saved.id}`)
    .set(h())
    .send({ object: 'people', name: 'Another actor', config, version: saved.version })
    .expect(404);
  const updated = (
    await viewer
      .patch(`/api/views/${saved.id}`)
      .set(h())
      .send({ object: 'people', name: 'My contact cards', config, version: saved.version })
      .expect(200)
  ).body;
  expect(updated).toMatchObject({ id: saved.id, name: 'My contact cards', config });
  expect((await viewer.get('/api/views').set(h()).expect(200)).body).toContainEqual(updated);
  expect((await viewer.get('/api/people').set(h()).expect(200)).body.total).toBe(2);
  await viewer.get('/api/people').set(h()).query({ customer_id: b }).expect(404);
  for (const invalid of [
    { ...config, columns: ['name', 'due_date'] },
    { ...config, columns: ['name', 'stage'] },
    { ...config, type: 'distributor' },
    { ...config, status: 'in_progress' },
    { ...config, source: 'email' },
  ])
    await viewer
      .post('/api/views')
      .set(h())
      .send({ object: 'people', name: 'Invalid card', config: invalid })
      .expect(400);
});
it('rejects mismatched company and person membership at API and database levels', async () => {
  const list = (
    await admin
      .post('/api/lists')
      .set(h())
      .send({ object: 'people', name: 'wrong relation' })
      .expect(201)
  ).body;
  await admin
    .post(`/api/lists/${list.id}/entries`)
    .set(h())
    .send({ entries: [{ customer_id: b, person_id: p }] })
    .expect(404);
  await admin
    .post(`/api/lists/${list.id}/entries`)
    .set(h())
    .send({ entries: [{ customer_id: a }] })
    .expect(400);
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query(
        'INSERT INTO list_entries(workspace_id,actor_id,list_id,object,customer_id,person_id) VALUES($1,$2,$3,$4,$5,$6)',
        [w, actor, list.id, 'people', b, p],
      ),
    ),
  ).rejects.toThrow();
  await admin.get('/api/people').set(h()).query({ list_id: randomUUID() }).expect(404);
});
it('archives people without deleting the company and restores its primary contact', async () => {
  let row = (await admin.get(`/api/people/${p}`).set(h())).body;
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ version: row.version, archived: true })
    .expect(200);
  expect((await admin.get(`/api/customers/${a}`).set(h())).body.contact_name).toBe('');
  expect(
    (await viewer.get('/api/people').set(h()).query({ archived: 'true' }).expect(200)).body.total,
  ).toBe(1);
  row = (await admin.get(`/api/people/${p}`).set(h())).body;
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ version: row.version, name: 'cannot edit archived' })
    .expect(409);
  await editor
    .patch(`/api/people/${p}`)
    .set(h())
    .send({ version: row.version, archived: false })
    .expect(200);
  expect((await admin.get(`/api/customers/${a}`).set(h())).body.contact_name).toBe(
    'Alice from company',
  );
  const audit = (await admin.get(`/api/customers/${a}/audit`).set(h()).expect(200)).body;
  expect(audit.some((e: { entity_type: string }) => e.entity_type === 'people')).toBe(true);
});
it('immediately revokes contact and personal-list reads when company access is removed', async () => {
  const list = (
    await viewer
      .post('/api/lists')
      .set(h())
      .send({ object: 'people', name: 'Revoked team', entries: [{ customer_id: a, person_id: p }] })
      .expect(201)
  ).body;
  await admin
    .put(`/api/customers/${a}/access/${viewerId}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  await viewer.get(`/api/people/${p}`).set(h()).expect(404);
  expect((await viewer.get('/api/people').set(h()).expect(200)).body.total).toBe(0);
  expect(
    (await viewer.get('/api/people').set(h()).query({ list_id: list.id }).expect(200)).body.total,
  ).toBe(0);
  expect(
    (await viewer.get('/api/lists').set(h()).expect(200)).body.find(
      (l: { id: string }) => l.id === list.id,
    ).count,
  ).toBe(0);
});
it('upgrades existing named contacts without inventing people from company inboxes', async () => {
  const { readFile } = await import('node:fs/promises');
  const old = await openDatabase();
  try {
    await old.exec(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of ['001_foundation.sql', '002_saved_views.sql', '003_record_lists.sql']) {
      await old.exec(
        await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8'),
      );
      await old.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
    const s = await createWorkspace(old, {
      name: 'Upgrade',
      email: 'upgrade@example.com',
      password,
      displayName: 'Admin',
    });
    await scoped(old, s.actorId, s.workspaceId, async (ctx) => {
      await ctx.tx.query(
        "INSERT INTO customers(workspace_id,id,name,type,source,contact_name,email) VALUES($1,$2,'Named','group','email','Existing person','named@example.com'),($1,$3,'Inbox only','group','email','','office@example.com')",
        [s.workspaceId, randomUUID(), randomUUID()],
      );
    });
    await migrate(old);
    await migrate(old);
    await scoped(old, s.actorId, s.workspaceId, async (ctx) => {
      const records = (await ctx.tx.query('SELECT name,email,is_primary FROM people')).rows;
      expect(records).toEqual([
        { name: 'Existing person', email: 'named@example.com', is_primary: true },
      ]);
      expect(
        (await ctx.tx.query<{ count: number }>('SELECT count(*)::int AS count FROM customers'))
          .rows[0].count,
      ).toBe(2);
    });
  } finally {
    await old.close();
  }
});
