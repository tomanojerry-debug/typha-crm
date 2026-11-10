import { randomUUID } from 'node:crypto';
import request, { type Agent } from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import type { MailTemplateInput, SavedMailTemplate } from '../shared/mail-template-storage.js';
import { mailVariableText, type MailVariableDocument } from '../shared/mail-variables.js';

const origin = 'http://localhost:3100';
const password = 'template-storage-fixture-password';
let db: Database;
let admin: Agent;
let editor: Agent;
let workspaceId: string;
let otherWorkspaceId: string;
let actorId: string;
let editorId: string;
let customerA: string;
let customerB: string;
let foreignCustomer: string;
let personA: string;
let personB: string;
const headers = () => ({ origin, 'x-workspace-id': workspaceId });
const input = (patch: Partial<MailTemplateInput> = {}): MailTemplateInput => ({
  name: '合成样衣跟进',
  subject: '请核对样衣意见',
  body: '请补充款式、版本和试穿尺寸，调整方案仍待评估。',
  ...patch,
});
const endpoint = (id = customerA, kind = 'customers') => `/api/${kind}/${id}/mail-templates`;
async function create(
  patch: Partial<MailTemplateInput> = {},
  user = admin,
  id = customerA,
  kind = 'customers',
) {
  return (await user.post(endpoint(id, kind)).set(headers()).send(input(patch)).expect(201))
    .body as SavedMailTemplate;
}
async function list(user = admin, id = customerA, kind = 'customers') {
  return (await user.get(endpoint(id, kind)).set(headers()).expect(200))
    .body as SavedMailTemplate[];
}
async function grant(access: 'viewer' | 'editor' | null) {
  if (access === null) {
    await scoped(db, actorId, workspaceId, (ctx) =>
      ctx.tx.query(
        'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
        [workspaceId, customerA, editorId],
      ),
    );
  } else {
    await admin
      .put(`/api/customers/${customerA}/access/${editorId}`)
      .set(headers())
      .send({ access })
      .expect(200);
  }
}
async function visible(user = actorId, workspace = workspaceId) {
  return (
    await scoped(db, user, workspace, (ctx) =>
      ctx.tx.query<{ id: string }>('SELECT id FROM mail_templates'),
    )
  ).rows.map((row) => row.id);
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Template storage fixtures',
    email: 'template-owner@example.com',
    password,
    displayName: 'Template owner',
  });
  workspaceId = seed.workspaceId;
  actorId = seed.actorId;
  const other = await createWorkspace(db, {
    name: 'Other template workspace',
    email: 'other-template-owner@example.com',
    password,
    displayName: 'Other owner',
  });
  otherWorkspaceId = other.workspaceId;
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'admin')", [
    otherWorkspaceId,
    actorId,
  ]);
  const app = createApp(db, { origin });
  admin = request.agent(app);
  editor = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'template-owner@example.com', password })
    .expect(200);
  editorId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'template-editor@example.com', display_name: 'Editor', password })
      .expect(201)
  ).body.actor_id;
  await editor
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'template-editor@example.com', password })
    .expect(200);
  async function customer(name: string, workspace = workspaceId) {
    return (
      await admin
        .post('/api/customers')
        .set({ origin, 'x-workspace-id': workspace })
        .send({ name, type: 'group', source: 'email', contact_name: `${name} contact` })
        .expect(201)
    ).body.id as string;
  }
  customerA = await customer('Synthetic template customer A');
  customerB = await customer('Synthetic template customer B');
  foreignCustomer = await customer('Foreign template customer', otherWorkspaceId);
  personA = (
    await admin.get('/api/people').set(headers()).query({ customer_id: customerA }).expect(200)
  ).body.items[0].id;
  personB = (
    await admin.get('/api/people').set(headers()).query({ customer_id: customerB }).expect(200)
  ).body.items[0].id;
  await grant('editor');
}, 30000);
afterAll(() => db?.close());

it('explicitly persists customer templates and reads the same list from a person or company', async () => {
  const saved = await create({ body: '  合成客户原话\n第二行  ' }, admin, personA, 'people');
  expect(saved).toMatchObject({
    scope: 'customer',
    customer_id: customerA,
    body: '  合成客户原话\n第二行  ',
    description: '',
    keywords: [],
  });
  expect(saved.id).toMatch(/^[\da-f-]{36}$/);
  expect(saved.created_at).toBeTruthy();
  expect(saved).not.toHaveProperty('actor_id');
  expect(saved).not.toHaveProperty('workspace_id');
  expect(await list()).toContainEqual(saved);
  expect(await list(admin, personA, 'people')).toContainEqual(saved);
  expect(await list(admin, customerB)).not.toContainEqual(saved);
});

it('only makes an explicitly personal template available to the same author in other customers', async () => {
  const personal = await create({ scope: 'personal', name: '本人通用合成模板' });
  const customer = await create({ name: '客户 A 专用合成模板' });
  expect(personal.customer_id).toBeNull();
  expect(await list(admin, personB, 'people')).toContainEqual(personal);
  expect(await list(admin, customerB)).not.toContainEqual(customer);
  expect(await list(editor)).not.toContainEqual(personal);
  expect(await visible(editorId)).not.toContain(personal.id);
  expect(await visible(editorId)).not.toContain(customer.id);
  const own = await create({ scope: 'personal' }, editor);
  expect(await list(editor)).toContainEqual(own);
  expect(await list()).not.toContainEqual(own);
  expect(await visible()).not.toContain(own.id);
});

it('returns the original template for an exact retry after a lost create response', async () => {
  const request_id = randomUUID();
  const saved = await create({ request_id, name: 'Retry-safe customer fixture' });
  const retry = await create(
    { request_id, name: 'Retry-safe customer fixture' },
    admin,
    personA,
    'people',
  );
  expect(retry).toEqual(saved);
  expect((await list()).filter((item) => item.id === saved.id)).toHaveLength(1);
  const persisted = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM mail_templates WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
    [workspaceId, actorId, request_id],
  );
  expect(persisted.rows[0].count).toBe(1);
  const personalId = randomUUID();
  expect(await create({ request_id: personalId, scope: 'personal' })).toEqual(
    await create({ request_id: personalId, scope: 'personal' }),
  );
});

it('rejects reuse for changed content or another customer while other authors and workspaces have independent request keys', async () => {
  const request_id = randomUUID();
  const saved = await create({ request_id });
  for (const patch of [
    { name: 'Different title' },
    { subject: 'Different subject' },
    { body: 'Different body' },
    { description: 'Different description' },
    { scope: 'personal' },
  ]) {
    const response = await admin
      .post(endpoint())
      .set(headers())
      .send({ ...input({ request_id }), ...patch })
      .expect(409);
    expect(response.body).not.toHaveProperty('body');
    expect(JSON.stringify(response.body)).not.toContain(saved.body);
  }
  const crossCustomer = await admin
    .post(endpoint(customerB))
    .set(headers())
    .send(input({ request_id }))
    .expect(409);
  expect(JSON.stringify(crossCustomer.body)).not.toContain(saved.body);
  const otherAuthor = await create({ request_id }, editor);
  expect(otherAuthor.id).not.toBe(saved.id);
  const otherWorkspace = (
    await admin
      .post(endpoint(foreignCustomer))
      .set({ origin, 'x-workspace-id': otherWorkspaceId })
      .send(input({ request_id }))
      .expect(201)
  ).body as SavedMailTemplate;
  expect(otherWorkspace.id).not.toBe(saved.id);
  await admin
    .post(endpoint())
    .set(headers())
    .send(input({ request_id: 'invalid' }))
    .expect(400);
});

it('keeps the same author separated across workspaces in API lists and direct SQL', async () => {
  const first = await create({ scope: 'personal', name: 'First workspace fixture' });
  const foreign = (
    await admin
      .post(endpoint(foreignCustomer))
      .set({ origin, 'x-workspace-id': otherWorkspaceId })
      .send(input({ scope: 'personal', name: 'Second workspace fixture' }))
      .expect(201)
  ).body as SavedMailTemplate;
  expect(await visible()).toContain(first.id);
  expect(await visible()).not.toContain(foreign.id);
  expect(await visible(actorId, otherWorkspaceId)).toContain(foreign.id);
  expect(await visible(actorId, otherWorkspaceId)).not.toContain(first.id);
  expect(await list()).not.toContainEqual(foreign);
  await admin.get(endpoint(foreignCustomer)).set(headers()).expect(404);
  await admin.post(endpoint(foreignCustomer)).set(headers()).send(input()).expect(404);
  await editor.get(endpoint(customerB)).set(headers()).expect(404);
  await editor.get(endpoint(personB, 'people')).set(headers()).expect(404);
  await editor
    .post(endpoint(personB, 'people'))
    .set(headers())
    .send(input({ scope: 'personal' }))
    .expect(404);
});

it('rejects identity, customer, mail recipients and other unrecognized payload fields', async () => {
  for (const patch of [
    { actor_id: actorId },
    { workspace_id: workspaceId },
    { customer_id: customerB },
    { id: randomUUID() },
    { to: ['fixture@example.com'] },
    { attachments: [] },
    { confirmed: true },
    { keywords: ['private'] },
  ]) {
    await admin
      .post(endpoint())
      .set(headers())
      .send({ ...input(), ...patch })
      .expect(400);
  }
  await admin.get(endpoint('invalid')).set(headers()).expect(400);
});

it('validates template content and supports an intentionally empty subject', async () => {
  for (const patch of [
    { name: '' },
    { name: 'x'.repeat(81) },
    { name: 'one\ntwo' },
    { subject: 'injected\r\nBcc: fixture@example.com' },
    { subject: 'x'.repeat(501) },
    { body: ' \n ' },
    { body: 'x'.repeat(20001) },
    { description: 'x'.repeat(201) },
    { scope: 'company' },
  ]) {
    await admin
      .post(endpoint())
      .set(headers())
      .send({ ...input(), ...patch })
      .expect(400);
  }
  expect((await create({ name: '  Blank subject  ', subject: '' })).name).toBe('Blank subject');
});

it('requires edit permission to create even a personal template and keeps revoked rows hidden', async () => {
  const customer = await create({}, editor);
  const personal = await create({ scope: 'personal' }, editor);
  await grant('viewer');
  try {
    expect(await list(editor)).toContainEqual(customer);
    await editor.post(endpoint()).set(headers()).send(input()).expect(403);
    await editor
      .post(endpoint(personA, 'people'))
      .set(headers())
      .send(input({ scope: 'personal' }))
      .expect(403);
    await expect(
      scoped(db, editorId, workspaceId, (ctx) =>
        ctx.tx.query(
          "INSERT INTO mail_templates(workspace_id,actor_id,id,customer_id,name,subject,body) VALUES($1,$2,$3,$4,'test','','test')",
          [workspaceId, editorId, randomUUID(), customerA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await grant(null);
    await editor.get(endpoint()).set(headers()).expect(404);
    await editor.get(endpoint(personA, 'people')).set(headers()).expect(404);
    expect(await visible(editorId)).not.toContain(customer.id);
    expect(await visible(editorId)).toContain(personal.id);
  } finally {
    await grant('editor');
  }
});

it('rejects archived targets and hides their private customer templates at the database boundary', async () => {
  const saved = await create();
  await scoped(db, actorId, workspaceId, (ctx) =>
    ctx.tx.query('UPDATE customers SET archived_at=now() WHERE id=$1', [customerA]),
  );
  try {
    await admin.get(endpoint()).set(headers()).expect(409);
    await admin.get(endpoint(personA, 'people')).set(headers()).expect(409);
    await admin.post(endpoint()).set(headers()).send(input()).expect(409);
    expect(await visible()).not.toContain(saved.id);
  } finally {
    await scoped(db, actorId, workspaceId, (ctx) =>
      ctx.tx.query('UPDATE customers SET archived_at=NULL WHERE id=$1', [customerA]),
    );
  }
  await scoped(db, actorId, workspaceId, (ctx) =>
    ctx.tx.query('UPDATE people SET archived_at=now() WHERE id=$1', [personA]),
  );
  try {
    await admin.get(endpoint(personA, 'people')).set(headers()).expect(409);
    await admin.post(endpoint(personA, 'people')).set(headers()).send(input()).expect(409);
  } finally {
    await scoped(db, actorId, workspaceId, (ctx) =>
      ctx.tx.query('UPDATE people SET archived_at=NULL WHERE id=$1', [personA]),
    );
  }
});

it('enforces author, workspace, customer and membership boundaries on direct inserts', async () => {
  const insert = (workspace: string, actor: string, customer: string | null) =>
    scoped(db, actorId, workspaceId, (ctx) =>
      ctx.tx.query(
        `INSERT INTO mail_templates(workspace_id,actor_id,id,scope,customer_id,name,subject,body)
          VALUES($1,$2,$3,$4,$5,'test','','test')`,
        [workspace, actor, randomUUID(), customer ? 'customer' : 'personal', customer],
      ),
    );
  await expect(insert(workspaceId, editorId, null)).rejects.toThrow(/row-level security/);
  await expect(insert(otherWorkspaceId, actorId, null)).rejects.toThrow(/row-level security/);
  await expect(insert(workspaceId, actorId, foreignCustomer)).rejects.toThrow();
  await expect(
    db.query(
      "INSERT INTO mail_templates(workspace_id,actor_id,id,customer_id,name,subject,body) VALUES($1,$2,$3,$4,'test','','test')",
      [workspaceId, actorId, randomUUID(), foreignCustomer],
    ),
  ).rejects.toThrow(/foreign key constraint/);
  await expect(
    db.query(
      "INSERT INTO mail_templates(workspace_id,actor_id,id,scope,name,subject,body) VALUES($1,$2,$3,'personal','test','','test')",
      [workspaceId, randomUUID(), randomUUID()],
    ),
  ).rejects.toThrow(/foreign key constraint/);
  await expect(
    scoped(db, actorId, workspaceId, (ctx) =>
      ctx.tx.query(
        "INSERT INTO mail_templates(workspace_id,actor_id,id,scope,customer_id,name,subject,body) VALUES($1,$2,$3,'personal',$4,'test','','test')",
        [workspaceId, actorId, randomUUID(), customerA],
      ),
    ),
  ).rejects.toThrow(/check constraint/);
  await db.query('UPDATE memberships SET active=false WHERE workspace_id=$1 AND actor_id=$2', [
    workspaceId,
    editorId,
  ]);
  try {
    await editor.get(endpoint()).set(headers()).expect(404);
    const raw = await db.transaction(async (tx) => {
      await tx.query(
        "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [workspaceId, editorId],
      );
      await tx.exec('SET LOCAL ROLE light_crm_app');
      return tx.query('SELECT * FROM mail_templates');
    });
    expect(raw.rows).toEqual([]);
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
          [workspaceId, editorId],
        );
        await tx.exec('SET LOCAL ROLE light_crm_app');
        return tx.query(
          "INSERT INTO mail_templates(workspace_id,actor_id,id,scope,name,subject,body) VALUES($1,$2,$3,'personal','test','','test')",
          [workspaceId, editorId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  } finally {
    await db.query('UPDATE memberships SET active=true WHERE workspace_id=$1 AND actor_id=$2', [
      workspaceId,
      editorId,
    ]);
  }
});

it('prevents changing a saved template identity or moving it between scopes', async () => {
  const customer = await create();
  const personal = await create({ scope: 'personal' });
  for (const [sql, values] of [
    ['UPDATE mail_templates SET actor_id=$1 WHERE id=$2', [editorId, customer.id]],
    ['UPDATE mail_templates SET id=$1 WHERE id=$2', [randomUUID(), customer.id]],
    ['UPDATE mail_templates SET request_id=$1 WHERE id=$2', [randomUUID(), customer.id]],
    ['UPDATE mail_templates SET workspace_id=$1 WHERE id=$2', [otherWorkspaceId, personal.id]],
    ['UPDATE mail_templates SET customer_id=$1 WHERE id=$2', [customerB, customer.id]],
    ["UPDATE mail_templates SET scope='personal',customer_id=NULL WHERE id=$1", [customer.id]],
    [
      "UPDATE mail_templates SET scope='customer',customer_id=$1 WHERE id=$2",
      [customerA, personal.id],
    ],
  ] as [string, unknown[]][]) {
    await expect(db.query(sql, values)).rejects.toThrow('mail template scope is immutable');
  }
  await expect(
    scoped(db, actorId, workspaceId, (ctx) =>
      ctx.tx.query("UPDATE mail_templates SET name='changed' WHERE id=$1", [customer.id]),
    ),
  ).rejects.toThrow(/permission denied/);
});

it('saves only unbound variable references and includes the complete document in exact retries', async () => {
  const variable_document: MailVariableDocument = {
    version: 1,
    subject: [
      {
        type: 'variable',
        id: randomUUID(),
        root: 'customer',
        field: 'customers:name',
        label: '当前公司 › 公司名称',
      },
    ],
    body: [
      {
        type: 'variable',
        id: randomUUID(),
        root: 'recipient',
        field: 'people:name',
        label: '收件人 › 姓名',
        fallback: '',
      },
      { type: 'text', text: '您好，请核对。' },
    ],
  };
  const request_id = randomUUID();
  const value = {
    request_id,
    scope: 'personal' as const,
    variable_document,
    subject: mailVariableText(variable_document.subject),
    body: mailVariableText(variable_document.body),
  };
  const saved = await create(value);
  expect(saved.variable_document).toEqual(variable_document);
  expect(JSON.stringify(saved)).not.toContain('Synthetic template customer A');
  expect(
    (await list(admin, customerB)).find((item) => item.id === saved.id)?.variable_document,
  ).toEqual(variable_document);
  expect(await create(value)).toEqual(saved);
  const changed = structuredClone(variable_document);
  changed.subject[0] = {
    ...changed.subject[0],
    root: 'recipient_company',
  } as (typeof changed.subject)[0];
  await admin
    .post(endpoint())
    .set(headers())
    .send(input({ ...value, variable_document: changed }))
    .expect(409);
});

it('rejects mismatched, unrecognized or ambiguous template variable documents without reading record values', async () => {
  const variable_document: MailVariableDocument = {
    version: 1,
    subject: [],
    body: [
      {
        type: 'variable',
        id: randomUUID(),
        root: 'recipient',
        field: 'people:name',
        label: '收件人 › 姓名',
      },
    ],
  };
  await admin.post(endpoint()).set(headers()).send(input({ variable_document })).expect(400);
  const value = { variable_document, subject: '', body: mailVariableText(variable_document.body) };
  await admin
    .post(endpoint())
    .set(headers())
    .send({
      ...input(value),
      variable_document: {
        ...variable_document,
        body: [{ ...variable_document.body[0], field: 'people:secret' }],
      },
    })
    .expect(400);
  await admin
    .post(endpoint())
    .set(headers())
    .send(
      input({
        ...value,
        variable_document: {
          ...variable_document,
          body: [...variable_document.body, ...variable_document.body],
        },
      }),
    )
    .expect(400);
  await admin
    .post(endpoint())
    .set(headers())
    .send({ ...input(value), variable_document: { ...variable_document, recipient_id: personA } })
    .expect(400);
});
