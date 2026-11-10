import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as prospects from '../server/prospects.js';
import { resolveNoteSource } from '../server/note-sources.js';
import { createPerson } from '../server/people.js';
import { prospectStateContext } from '../server/prospect-context.js';
import type { CreateProspect, Prospect, ProspectRequirement } from '../shared/prospects.js';

let db: Database, w: string, boss: string, domestic: string, foreign: string, viewer: string;
let retail: string, group: string, distributor: string, otherWorkspace: string, otherBoss: string;
const run = <T>(fn: (ctx: Context) => Promise<T>, actor = boss, workspace = w) =>
  scoped(db, actor, workspace, fn);
const requirement = (patch: Partial<ProspectRequirement> = {}): ProspectRequirement => ({
  id: randomUUID(),
  title: '确认客户尺码要求',
  status: 'missing',
  waiting_on: 'customer',
  assignee_id: null,
  due_date: null,
  result: '',
  source_record_ids: [],
  ...patch,
});
const input = (patch: Partial<CreateProspect> = {}): CreateProspect => ({
  request_id: randomUUID(),
  customer_id: group,
  name: '舞服询盘（虚构）',
  owner_id: domestic,
  summary: '',
  requirements: [],
  source_refs: [],
  ...patch,
});
const make = (patch: Partial<CreateProspect> = {}) =>
  run((ctx) => prospects.create(ctx, input(patch)));
async function source(
  customerId = group,
  projectId: string | null = null,
  body = '客户希望确认尺码，尚未报价。',
) {
  return run(async (ctx) => {
    const record = await service.insert(ctx, 'customer_records', {
      customer_id: customerId,
      project_id: projectId,
      kind: 'customer_quote',
      body,
      created_by: boss,
    });
    return resolveNoteSource(ctx, customerId, { record_id: String(record.id) });
  });
}
const patch = (p: Prospect, changes: Record<string, unknown>, actor = boss) =>
  run(
    (ctx) =>
      prospects.update(ctx, p.id, { request_id: randomUUID(), version: p.version, ...changes }),
    actor,
  );

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const a = await createWorkspace(db, {
    name: '潜在客户虚构验收',
    email: 'prospect-boss@example.invalid',
    displayName: '老板',
    password: 'prospect-fixture-password',
  });
  w = a.workspaceId;
  boss = a.actorId;
  for (const name of ['domestic', 'foreign', 'viewer']) {
    const id = randomUUID();
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `prospect-${name}@example.invalid`,
      name,
      'unused',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      w,
      id,
    ]);
    if (name === 'domestic') domestic = id;
    else if (name === 'foreign') foreign = id;
    else viewer = id;
  }
  for (const [type, name] of [
    ['retail', '张女士（虚构）'],
    ['group', '甲舞校（虚构）'],
    ['distributor', '海外经销商（虚构）'],
  ] as const) {
    const row = await run((ctx) =>
      service.insert(ctx, 'customers', { name, type, source: 'other' }),
    );
    if (type === 'retail') retail = String(row.id);
    else if (type === 'group') group = String(row.id);
    else distributor = String(row.id);
  }
  await run(async (ctx) => {
    for (const [customer, actor, access] of [
      [retail, domestic, 'editor'],
      [group, domestic, 'editor'],
      [distributor, foreign, 'editor'],
      [group, viewer, 'viewer'],
    ])
      await ctx.tx.query(
        'INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,$4)',
        [w, customer, actor, access],
      );
  });
  const b = await createWorkspace(db, {
    name: '其他空间',
    email: 'prospect-other@example.invalid',
    displayName: '另一老板',
    password: 'prospect-fixture-password',
  });
  otherWorkspace = b.workspaceId;
  otherBoss = b.actorId;
}, 60000);
afterAll(async () => {
  await db?.close();
});

it('supports complete retail, group and distributor inquiries without invented companies or people', async () => {
  for (const [customer, type, owner] of [
    [retail, 'retail', domestic],
    [group, 'group', domestic],
    [distributor, 'distributor', foreign],
  ]) {
    const p = await make({ customer_id: customer, owner_id: owner, requirements: [requirement()] });
    expect(p.customer_type).toBe(type);
    expect(p.person_id).toBeNull();
    expect(p.requirements).toHaveLength(1);
    expect(p.stage).toBe('new');
  }
});
it('keeps multiple purchase intentions separate while preserving an active customer relationship', async () => {
  await run((ctx) =>
    ctx.tx.query("UPDATE customers SET status='active' WHERE workspace_id=$1 AND id=$2", [
      w,
      group,
    ]),
  );
  const a = await make({ name: '第一批演出服' }),
    b = await make({ name: '第二批练功服' });
  expect(a.id).not.toBe(b.id);
  expect(a.customer_id).toBe(b.customer_id);
  expect((await run((ctx) => service.customer(ctx, group))).status).toBe('active');
});
it('enforces customer ACL, workspace boundaries and viewer read-only access', async () => {
  const p = await make();
  expect((await run((ctx) => prospects.detail(ctx, p.id), domestic)).can_edit).toBe(true);
  expect((await run((ctx) => prospects.detail(ctx, p.id), viewer)).can_edit).toBe(false);
  await expect(run((ctx) => prospects.detail(ctx, p.id), foreign)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    run((ctx) => prospects.detail(ctx, p.id), otherBoss, otherWorkspace),
  ).rejects.toMatchObject({ status: 404 });
  await expect(run((ctx) => prospects.create(ctx, input()), viewer)).rejects.toMatchObject({
    status: 403,
  });
  await expect(patch(p, { summary: '无权修改' }, viewer)).rejects.toMatchObject({ status: 403 });
  expect(
    (await run((ctx) => prospects.list(ctx), foreign)).items.every(
      (x) => x.customer_id === distributor,
    ),
  ).toBe(true);
});
it('requires real customer scope and same-customer person identity', async () => {
  await expect(
    run((ctx) => prospects.create(ctx, { ...input(), customer_id: null })),
  ).rejects.toThrow();
  const wrongPerson = await run((ctx) =>
    createPerson(ctx, {
      customer_id: distributor,
      name: '海外联系人',
      job_title: '',
      email: '',
      phone: '',
      description: '',
    }),
  );
  await expect(make({ person_id: wrongPerson.id })).rejects.toMatchObject({ status: 404 });
});
it('assignment never grants access and only accessible active editors can own business states', async () => {
  await expect(make({ owner_id: foreign })).rejects.toMatchObject({ status: 400 });
  await expect(
    make({ requirements: [requirement({ assignee_id: viewer })] }),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (await run((ctx) => prospects.list(ctx), foreign)).items.some((p) => p.customer_id === group),
  ).toBe(false);
});
it('uses versioned inquiry authority and maps coarse project stage without changing inquiry type', async () => {
  const p = await make();
  const updated = await patch(p, { stage: 'proposal', summary: '正在讨论方案' });
  expect(updated.version).toBe(p.version + 1);
  const project = await run((ctx) => service.project(ctx, group, p.id));
  expect(project.type).toBe('inquiry');
  expect(project.stage).toBe('in_progress');
  await expect(patch(p, { stage: 'decision' })).rejects.toMatchObject({ status: 409 });
  await expect(
    run((ctx) => prospects.validateProjectUpdate(ctx, group, p.id, { type: 'sample' })),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    run((ctx) =>
      ctx.tx.query("UPDATE projects SET type='sample' WHERE workspace_id=$1 AND id=$2", [w, p.id]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
it('pausing an inquiry never invents customer waiting or changes requirement responsibility', async () => {
  const r = requirement({ waiting_on: 'internal', assignee_id: boss });
  const p = await make({ requirements: [r] });
  const paused = await patch(p, { lifecycle: 'paused' });
  expect(paused.lifecycle).toBe('paused');
  expect(paused.stage).toBe('new');
  expect(paused.requirements[0].waiting_on).toBe('internal');
  expect((await run((ctx) => service.project(ctx, group, p.id))).stage).toBe('in_progress');
});
it('projects the same stable requirement states into owner and explicit assignee task queues', async () => {
  const a = requirement(),
    b = requirement({ assignee_id: boss, waiting_on: 'internal', status: 'in_progress' });
  const p = await make({ requirements: [a, b] });
  const own = await run((ctx) => prospects.tasks(ctx), domestic);
  expect(own.items.find((t) => t.id === a.id)).toMatchObject({
    prospect_id: p.id,
    effective_assignee_id: domestic,
    waiting_on: 'customer',
  });
  expect(own.items.some((t) => t.id === b.id)).toBe(false);
  expect(
    (await run((ctx) => prospects.tasks(ctx))).items.find((t) => t.id === b.id)
      ?.effective_assignee_id,
  ).toBe(boss);
  expect(
    (await run((ctx) => prospects.tasks(ctx, { status: 'open' }))).items.some((t) => t.id === b.id),
  ).toBe(false);
  expect(
    (await run((ctx) => prospects.tasks(ctx, { status: 'in_progress' }))).items.some(
      (t) => t.id === b.id,
    ),
  ).toBe(true);
  const done = await patch(p, {
    requirements: [{ ...a, status: 'satisfied', result: '客户已提供尺码表' }, b],
  });
  expect(
    (await run((ctx) => prospects.tasks(ctx), domestic)).items.some((t) => t.id === a.id),
  ).toBe(false);
  expect(
    (await run((ctx) => prospects.tasks(ctx, { status: 'completed' }), domestic)).items.find(
      (t) => t.id === a.id,
    )?.prospect_version,
  ).toBe(done.version);
});
it('filters complete task and inquiry results on the server including dates and pagination', async () => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const p = await make({
    name: '独特日期筛选',
    requirements: [requirement({ due_date: today }), requirement({ due_date: '2020-01-01' })],
  });
  const current = await run((ctx) =>
    prospects.list(ctx, { q: '独特日期筛选', view: 'today', page_size: 1 }),
  );
  expect(current.total).toBe(1);
  expect(current.items[0].id).toBe(p.id);
  expect(
    (
      await run(
        (ctx) => prospects.tasks(ctx, { q: '独特日期筛选', view: 'overdue', page_size: 1 }),
        domestic,
      )
    ).total,
  ).toBe(1);
});
it('does not claim fulfillment without a result or allow duplicate requirement IDs', async () => {
  await expect(
    make({ requirements: [requirement({ status: 'satisfied' })] }),
  ).rejects.toMatchObject({ status: 400 });
  const r = requirement();
  await expect(make({ requirements: [r, r] })).rejects.toMatchObject({ status: 400 });
  await expect(
    make({ requirements: [requirement({ source_record_ids: [randomUUID()] })] }),
  ).rejects.toMatchObject({ status: 400 });
});
it('replays exact create and update requests once and rejects content reuse or superseded versions', async () => {
  const value = input(),
    p = await run((ctx) => prospects.create(ctx, value));
  expect(await run((ctx) => prospects.create(ctx, value))).toEqual(p);
  await expect(
    run((ctx) => prospects.create(ctx, { ...value, name: '另一个要求' })),
  ).rejects.toMatchObject({ status: 409 });
  const change = { request_id: randomUUID(), version: p.version, stage: 'needs' };
  const updated = await run((ctx) => prospects.update(ctx, p.id, change));
  expect(await run((ctx) => prospects.update(ctx, p.id, change))).toEqual(updated);
  await patch(updated, { stage: 'decision' });
  await expect(run((ctx) => prospects.update(ctx, p.id, change))).rejects.toMatchObject({
    status: 409,
  });
});
it('serializes concurrent identical creates into one persistent inquiry and mutation', async () => {
  const value = input({ name: '并发请求只建一笔' });
  const [a, b] = await Promise.all([
    run((ctx) => prospects.create(ctx, value)),
    run((ctx) => prospects.create(ctx, value)),
  ]);
  expect(a.id).toBe(b.id);
  expect((await run((ctx) => prospects.list(ctx, { q: value.name }))).total).toBe(1);
});
it('withdraws revoked customer tasks immediately without treating assignment as authorization', async () => {
  const p = await make({ customer_id: retail, requirements: [requirement()] });
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [w, retail, domestic],
    ),
  );
  try {
    expect(
      (await run((ctx) => prospects.tasks(ctx), domestic)).items.some(
        (t) => t.prospect_id === p.id,
      ),
    ).toBe(false);
    await expect(run((ctx) => prospects.detail(ctx, p.id), domestic)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await run((ctx) => prospects.tasks(ctx, { view: 'all' }))).items.some(
        (t) => t.prospect_id === p.id,
      ),
    ).toBe(false);
  } finally {
    await run((ctx) =>
      ctx.tx.query(
        "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
        [w, retail, domestic],
      ),
    );
  }
});
it('canonicalizes source titles, stores no derived project description and hides all stale derived content', async () => {
  const s = await source();
  const value = input({
    name: '客户秘密款式询盘',
    summary: '客户需要确认尺码',
    requirements: [requirement({ result: '原来源摘要', source_record_ids: [s.record_id] })],
    source_refs: [{ record_id: s.record_id, source_hash: s.source_hash, title: '伪造来源标题' }],
  });
  const p = await run((ctx) => prospects.create(ctx, value));
  expect(p.source_refs[0].title).toBe('业务原文');
  const project = await run((ctx) => service.project(ctx, group, p.id));
  expect(project.name).not.toContain('秘密');
  expect(project.description).toBe('');
  await db.query('UPDATE customer_records SET body=$3 WHERE workspace_id=$1 AND id=$2', [
    w,
    s.record_id,
    '原文已更新：暂时不咨询该款。',
  ]);
  const stale = await run((ctx) => prospects.detail(ctx, p.id));
  expect(stale.sources_valid).toBe(false);
  expect(stale.summary).toBe('');
  expect(stale.source_refs).toEqual([]);
  expect(stale.name).not.toContain('秘密');
  expect(stale.requirements[0].result).toBe('');
  expect(
    (await run((ctx) => prospects.tasks(ctx), domestic)).items.some((t) => t.prospect_id === p.id),
  ).toBe(false);
  await expect(patch(p, { source_refs: [], summary: '客户需要确认尺码' })).rejects.toMatchObject({
    status: 409,
  });
  await expect(run((ctx) => prospects.create(ctx, value))).rejects.toMatchObject({ status: 409 });
});
it('refuses cross-project evidence even for the same customer and allows explicit empty inquiry takeover', async () => {
  const p = await make();
  const s = await source(group, p.id);
  await expect(
    make({ source_refs: [{ record_id: s.record_id, source_hash: s.source_hash }] }),
  ).rejects.toMatchObject({ status: 409 });
  const raw = await run((ctx) =>
    service.insert(ctx, 'projects', {
      customer_id: group,
      name: '已有空询盘',
      type: 'inquiry',
      stage: 'new',
    }),
  );
  const rs = await source(group, String(raw.id));
  const adopted = await make({
    existing_project_id: String(raw.id),
    source_refs: [{ record_id: rs.record_id, source_hash: rs.source_hash }],
  });
  expect(adopted.id).toBe(raw.id);
  await expect(make({ existing_project_id: adopted.id })).rejects.toMatchObject({ status: 409 });
  const wrong = await source(distributor);
  await expect(
    make({ source_refs: [{ record_id: wrong.record_id, source_hash: wrong.source_hash }] }),
  ).rejects.toMatchObject({ status: 404 });
});
it('preserves unresolved states on acknowledged closure and reopens without changing the old event', async () => {
  const r = requirement(),
    p = await make({ requirements: [r] });
  await expect(patch(p, { lifecycle: 'closed', outcome: 'resolved' })).rejects.toMatchObject({
    status: 409,
  });
  const closed = await patch(p, {
    lifecycle: 'closed',
    outcome: 'resolved',
    acknowledge_open_requirements: true,
  });
  expect(closed.requirements[0].status).toBe('missing');
  expect(
    (await run((ctx) => prospects.tasks(ctx), domestic)).items.some((t) => t.id === r.id),
  ).toBe(false);
  const opened = await patch(closed, { lifecycle: 'active', outcome: null });
  expect(opened.requirements[0].id).toBe(r.id);
  const events = await run((ctx) =>
    ctx.tx.query<{ kind: string }>(
      'SELECT kind FROM prospect_events WHERE workspace_id=$1 AND project_id=$2 ORDER BY profile_version',
      [w, p.id],
    ),
  );
  expect(events.rows.map((e) => e.kind)).toEqual(['created', 'updated', 'reopened']);
});
it('blocks closure on another actor pending mail without exposing or cancelling that mail', async () => {
  const p = await make();
  const account = randomUUID(),
    outgoing = randomUUID();
  await db.query(
    'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
    [w, account, 'fake-sender@example.invalid', 'fake-secret', boss],
  );
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO outgoing_mail(workspace_id,customer_id,id,created_by,account_id,project_id,from_email,content,status,approved_version,approved_at,approved_digest) VALUES($1,$2,$3,$4,$5,$6,$7,'{}','approved',1,now(),'fixture')",
      [w, group, outgoing, boss, account, p.id, 'fake-sender@example.invalid'],
    ),
  );
  expect(
    (
      await run(
        (ctx) => ctx.tx.query('SELECT id FROM outgoing_mail WHERE id=$1', [outgoing]),
        domestic,
      )
    ).rows,
  ).toHaveLength(0);
  await expect(patch(p, { lifecycle: 'closed', outcome: 'won' }, domestic)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    (await db.query<{ status: string }>('SELECT status FROM outgoing_mail WHERE id=$1', [outgoing]))
      .rows[0].status,
  ).toBe('approved');
  await run((ctx) =>
    ctx.tx.query("UPDATE outgoing_mail SET status='cancelled' WHERE id=$1", [outgoing]),
  );
  const closed = await patch(p, { lifecycle: 'closed', outcome: 'won' }, domestic);
  expect(closed.outcome).toBe('won');
  await expect(
    run((ctx) =>
      ctx.tx.query("UPDATE outgoing_mail SET status='approved' WHERE id=$1", [outgoing]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

it('adds state context only for the exact current customer and inquiry, without another same-customer purchase intention', async () => {
  const a = await make({ name: '独立甲批次秘密要求', summary: '甲批次需要红色' });
  const b = await make({ name: '独立乙批次', summary: '乙批次需要蓝色' });
  const text = await run((ctx) => prospectStateContext(ctx, group, b.id));
  expect(text).toContain('乙批次需要蓝色');
  expect(text).not.toContain(a.name);
  expect(text).not.toContain(a.summary);
  expect(await run((ctx) => prospectStateContext(ctx, distributor, b.id))).toBeNull();
  const raw = await run((ctx) =>
    service.insert(ctx, 'projects', {
      customer_id: group,
      name: '普通样衣项目',
      type: 'sample',
      stage: 'new',
    }),
  );
  expect(await run((ctx) => prospectStateContext(ctx, group, String(raw.id)))).toBeNull();
});
it('never provides stale source-dependent title, summary or requirement text to model context', async () => {
  const s = await source();
  const p = await make({
    name: '保密需求标题',
    summary: '保密需求摘要',
    requirements: [requirement({ title: '保密尺码缺口' })],
    source_refs: [{ record_id: s.record_id, source_hash: s.source_hash }],
  });
  await db.query('UPDATE customer_records SET body=$3 WHERE workspace_id=$1 AND id=$2', [
    w,
    s.record_id,
    '原文修订后不同需求',
  ]);
  const text = await run((ctx) => prospectStateContext(ctx, group, p.id));
  expect(text).toContain('业务State来源失效不可引用旧内容');
  expect(text).not.toContain('保密');
});
it('refreshes model state versions and prioritizes unmet requirements with explicit truncation', async () => {
  const unmet = requirement({ title: '等待客户确认当前尺码' });
  const p = await make({
    requirements: [
      ...Array.from({ length: 30 }, () => requirement({ status: 'satisfied', result: '已核对' })),
      unmet,
    ],
  });
  const text = await run((ctx) => prospectStateContext(ctx, group, p.id));
  expect(text).toContain('"profile_version":1');
  expect(text).toContain('"requirements_total":31');
  expect(text).toContain('"requirements_shown":30');
  expect(text).toContain('"requirements_truncated":true');
  expect(text).toContain(unmet.title);
  const updated = await patch(p, {
    summary: '本轮只需继续确认使用日期',
    requirements: [requirement({ title: '确认使用日期' })],
  });
  const fresh = await run((ctx) => prospectStateContext(ctx, group, p.id));
  expect(fresh).toContain(`"profile_version":${updated.version}`);
  expect(fresh).toContain('确认使用日期');
  expect(fresh).not.toContain(unmet.title);
});
