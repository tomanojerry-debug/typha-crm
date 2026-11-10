import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import {
  defaultListConfig,
  type ListField,
  type ListConfig,
  type WorkflowEntry,
} from '../shared/list-workflow.js';
import { defaultView } from '../shared/views.js';
const origin = 'http://localhost:3100',
  password = 'workflow-test-password';
let db: Database,
  admin: Agent,
  reader: Agent,
  w: string,
  actor: string,
  readerId: string,
  customer: string,
  first: string,
  second: string,
  fields: ListField[],
  otherFields: ListField[],
  entry: WorkflowEntry,
  other: WorkflowEntry;
const headers = () => ({ origin, 'x-workspace-id': w });
const getFields = async (id: string, who = admin) =>
  (await who.get(`/api/lists/${id}/fields`).set(headers()).expect(200)).body as ListField[];
const browse = async (id: string, config: ListConfig, who = admin, page = 1) =>
  (await who.post(`/api/lists/${id}/browse`).set(headers()).send({ config, page }).expect(200))
    .body;
const update = (
  id: string,
  row: WorkflowEntry,
  values: Record<string, string | null>,
  who = admin,
) =>
  who
    .patch(`/api/lists/${id}/entries/${row.id}`)
    .set(headers())
    .send({ version: row.version, values });
const field = (kind: string) => fields.find((f) => f.kind === kind)!;
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const setup = await createWorkspace(db, {
    name: 'Workflow',
    email: 'workflow@example.com',
    password,
    displayName: 'Owner',
  });
  w = setup.workspaceId;
  actor = setup.actorId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  reader = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'workflow@example.com', password })
    .expect(200);
  readerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'viewer@example.com', password, display_name: 'Viewer' })
      .expect(201)
  ).body.actor_id;
  await reader
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'viewer@example.com', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: '客户甲', type: 'group', source: 'email' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customer}/access/${readerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
  first = (
    await admin
      .post('/api/lists')
      .set(headers())
      .send({ name: '销售跟进', object: 'customers', entries: [{ customer_id: customer }] })
      .expect(201)
  ).body.id;
  second = (
    await admin
      .post('/api/lists')
      .set(headers())
      .send({ name: '客户成功', object: 'customers', entries: [{ customer_id: customer }] })
      .expect(201)
  ).body.id;
  fields = await getFields(first);
  otherFields = await getFields(second);
  entry = (await browse(first, defaultListConfig(fields))).items[0];
  other = (await browse(second, defaultListConfig(otherFields))).items[0];
}, 30000);
afterAll(async () => {
  await db.close();
});
describe('independent list workflows', () => {
  it('saves independent values without changing the customer or other list, with optimistic versions', async () => {
    expect(fields.map((f) => f.kind)).toEqual(['stage', 'member', 'date', 'currency']);
    const values = {
      [field('stage').id]: field('stage').options[1].id,
      [field('member').id]: actor,
      [field('date').id]: '2026-12-15',
      [field('currency').id]: '12000.50',
    };
    const changed = (await update(first, entry, values).expect(200)).body;
    expect(changed.version).toBe(2);
    await update(first, entry, { [field('currency').id]: '12' }).expect(409);
    entry = (await browse(first, defaultListConfig(fields))).items[0];
    expect(entry.field_values).toEqual(values);
    expect((await browse(second, defaultListConfig(otherFields))).items[0].field_values).toEqual(
      {},
    );
    const master = (await admin.get(`/api/customers/${customer}`).set(headers()).expect(200)).body;
    expect(master.status).toBe('potential');
    expect(master.owner_id).toBeNull();
    const otherStage = otherFields.find((f) => f.kind === 'stage')!;
    await update(second, other, { [otherStage.id]: otherStage.options[3].id }).expect(200);
    expect(
      (await browse(first, defaultListConfig(fields))).items[0].field_values[field('stage').id],
    ).toBe(field('stage').options[1].id);
  });
  it('validates field/list membership, stage options, date, money and workspace owner', async () => {
    const invalid = [
      { [otherFields[0].id]: otherFields[0].options[0].id },
      { [field('stage').id]: otherFields[0].options[0].id },
      { [field('date').id]: '2026-02-30' },
      { [field('currency').id]: '1.001' },
      { [field('currency').id]: '-1' },
      { [field('member').id]: randomUUID() },
    ];
    for (const values of invalid) await update(first, entry, values).expect(400);
    await admin
      .patch(`/api/lists/${second}/entries/${entry.id}`)
      .set(headers())
      .send({ version: entry.version, values: { [otherFields[0].id]: null } })
      .expect(404);
  });
  it('creates fields and stages, retains history on rename/reorder and preserves hidden values', async () => {
    const f = (
      await admin
        .post(`/api/lists/${first}/fields`)
        .set(headers())
        .send({
          name: '打样进度',
          kind: 'stage',
          options: [
            { label: '等待样衣', color: 'purple' },
            { label: '试穿通过', color: 'green' },
          ],
        })
        .expect(201)
    ).body as ListField;
    await update(first, entry, { [f.id]: f.options[0].id }).expect(200);
    await admin
      .patch(`/api/lists/${first}/fields/${f.id}`)
      .set(headers())
      .send({ version: f.version, options: [f.options[1]] })
      .expect(400);
    let changed = (
      await admin
        .patch(`/api/lists/${first}/fields/${f.id}`)
        .set(headers())
        .send({
          version: f.version,
          options: [f.options[1], { ...f.options[0], label: '等待确认' }],
        })
        .expect(200)
    ).body as ListField;
    await admin
      .patch(`/api/lists/${first}/fields/${f.id}`)
      .set(headers())
      .send({ version: f.version, name: '过期修改' })
      .expect(409);
    changed = (
      await admin
        .patch(`/api/lists/${first}/fields/${f.id}`)
        .set(headers())
        .send({ version: changed.version, archived: true })
        .expect(200)
    ).body;
    fields = await getFields(first);
    entry = (await browse(first, defaultListConfig(fields))).items[0];
    expect(entry.field_values[f.id]).toBe(f.options[0].id);
    await update(first, entry, { [f.id]: null }).expect(400);
    await admin
      .patch(`/api/lists/${first}/fields/${f.id}`)
      .set(headers())
      .send({ version: changed.version, archived: false })
      .expect(200);
    fields = await getFields(first);
    expect(fields.find((x) => x.id === f.id)?.options[1].label).toBe('等待确认');
  });
  it('filters and sorts typed values, totals money exactly, and counts board stages', async () => {
    const config = defaultListConfig(fields);
    config.sort = field('currency').id;
    config.filters.rules = [
      { field: field('currency').id, operator: 'gt', value: '12000' },
      { field: field('member').id, operator: 'eq', value: actor },
    ];
    const rows = await browse(first, config);
    expect(rows.total).toBe(1);
    expect(rows.sums[field('currency').id]).toBe('12000.50');
    expect(rows.groups[field('stage').options[1].id]).toBe(1);
    config.filters.rules[0].value = '13000';
    expect((await browse(first, config)).total).toBe(0);
    config.filters.match = 'any';
    expect((await browse(first, config)).total).toBe(1);
    config.filters = {
      match: 'all',
      rules: [{ field: field('date').id, operator: 'lt', value: '2027-01-01' }],
    };
    expect((await browse(first, config)).total).toBe(1);
  });
  it('persists board/columns/filters as list views and rejects foreign field configurations', async () => {
    const config = defaultListConfig(fields);
    config.columns.reverse();
    config.columns = ['name', ...config.columns.filter((c) => c !== 'name')];
    const saved = (
      await admin
        .post('/api/views')
        .set(headers())
        .send({
          name: '业务流程',
          object: 'customers',
          list_id: first,
          config: { ...defaultView('customers'), layout: 'board', list_config: config },
        })
        .expect(201)
    ).body;
    expect(saved.config.list_config).toEqual(config);
    await admin
      .post('/api/views')
      .set(headers())
      .send({
        name: '错误',
        object: 'customers',
        list_id: second,
        config: { ...defaultView('customers'), list_config: config },
      })
      .expect(400);
    await admin
      .post('/api/views')
      .set(headers())
      .send({
        name: '错误',
        object: 'customers',
        config: { ...defaultView('customers'), list_config: config },
      })
      .expect(400);
  });
  it('saves and restores an ungrouped people card view without a stage field', async () => {
    const id = (
      await admin
        .post('/api/lists')
        .set(headers())
        .send({ name: '联系人卡片', object: 'people' })
        .expect(201)
    ).body.id;
    const initialFields = await getFields(id),
      stage = initialFields.find((f) => f.kind === 'stage')!;
    await admin
      .patch(`/api/lists/${id}/fields/${stage.id}`)
      .set(headers())
      .send({ version: stage.version, archived: true })
      .expect(200);
    const activeFields = await getFields(id),
      config = defaultListConfig(activeFields);
    expect(config.group_by).toBeNull();
    const input = {
      name: '联系人卡片',
      object: 'people',
      list_id: id,
      config: { ...defaultView('people'), layout: 'board', list_config: config },
    };
    const saved = (await admin.post('/api/views').set(headers()).send(input).expect(201)).body;
    const restore = async () =>
      (await admin.get('/api/views').set(headers()).expect(200)).body.find(
        (view: { id: string }) => view.id === saved.id,
      );
    expect((await restore()).config).toEqual(input.config);
    const edited = { ...input, name: '重点联系人卡片' };
    await admin
      .patch(`/api/views/${saved.id}`)
      .set(headers())
      .send({ ...edited, version: saved.version })
      .expect(200);
    expect(await restore()).toMatchObject({ name: edited.name, config: edited.config });
    await admin
      .post('/api/views')
      .set(headers())
      .send({
        ...input,
        config: {
          ...input.config,
          list_config: {
            ...config,
            group_by: activeFields.find((f) => f.kind === 'member')!.id,
          },
        },
      })
      .expect(400);
  });
  it('keeps private lists isolated and denies viewer entry edits in API and RLS', async () => {
    await reader.get(`/api/lists/${first}/fields`).set(headers()).expect(404);
    await update(first, entry, { [field('stage').id]: null }, reader).expect(404);
    const own = (
      await reader
        .post('/api/lists')
        .set(headers())
        .send({ name: '只读客户', object: 'customers', entries: [{ customer_id: customer }] })
        .expect(201)
    ).body.id;
    const fs = await getFields(own, reader),
      r = (await browse(own, defaultListConfig(fs), reader)).items[0];
    expect(r.can_edit).toBe(false);
    await update(own, r, { [fs[0].id]: fs[0].options[0].id }, reader).expect(403);
    const changed = await scoped(db, readerId, w, (ctx) =>
      ctx.tx.query(
        'UPDATE list_entries SET field_values=$1 WHERE workspace_id=$2 AND id=$3 RETURNING id',
        [JSON.stringify({ [fs[0].id]: fs[0].options[0].id }), w, r.id],
      ),
    );
    expect(changed.rows).toEqual([]);
    await expect(
      scoped(db, readerId, w, (ctx) =>
        ctx.tx.query(
          'INSERT INTO list_entries(workspace_id,actor_id,list_id,object,customer_id,field_values) VALUES($1,$2,$3,$4,$5,$6)',
          [
            w,
            readerId,
            own,
            'customers',
            customer,
            JSON.stringify({ [fs[0].id]: fs[0].options[0].id }),
          ],
        ),
      ),
    ).rejects.toThrow();
    await admin
      .put(`/api/customers/${customer}/access/${readerId}`)
      .set(headers())
      .send({ access: null })
      .expect(200);
    expect((await browse(own, defaultListConfig(fs), reader)).items).toEqual([]);
  });
  it('rejects foreign field values at the database boundary', async () => {
    await expect(
      scoped(db, actor, w, (ctx) =>
        ctx.tx.query('UPDATE list_entries SET field_values=$1 WHERE workspace_id=$2 AND id=$3', [
          JSON.stringify({ [otherFields[0].id]: otherFields[0].options[0].id }),
          w,
          entry.id,
        ]),
      ),
    ).rejects.toThrow();
  });
  it('supports independent people and project list boards without rewriting master records', async () => {
    const person = (
      await admin
        .post('/api/people')
        .set(headers())
        .send({ customer_id: customer, name: '测试联系人' })
        .expect(201)
    ).body;
    const project = (
      await admin
        .post(`/api/customers/${customer}/projects`)
        .set(headers())
        .send({ name: '测试项目', type: 'sample' })
        .expect(201)
    ).body;
    for (const [object, record, key] of [
      ['people', person, 'person_id'],
      ['projects', project, 'project_id'],
    ] as const) {
      const id = (
        await admin
          .post('/api/lists')
          .set(headers())
          .send({
            name: `${object}流程`,
            object,
            entries: [{ customer_id: customer, [key]: record.id }],
          })
          .expect(201)
      ).body.id;
      const fs = await getFields(id),
        config = defaultListConfig(fs),
        r = (await browse(id, config)).items[0];
      expect(r.name).toBe(record.name);
      expect(r.customer_name).toBe('客户甲');
      await update(id, r, { [fs[0].id]: fs[0].options[1].id }).expect(200);
      await admin
        .post('/api/views')
        .set(headers())
        .send({
          name: '看板',
          object,
          list_id: id,
          config: { ...defaultView(object), layout: 'board', list_config: config },
        })
        .expect(201);
      const master = (
        await admin
          .get(
            object === 'people'
              ? `/api/people/${record.id}`
              : `/api/customers/${customer}/projects/${record.id}`,
          )
          .set(headers())
          .expect(200)
      ).body;
      if (object === 'projects') expect(master.stage).toBe(record.stage);
    }
  });
});
