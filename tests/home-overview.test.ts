import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import { overview } from '../server/home-overview.js';
import { readNotification } from '../server/mail-notifications.js';
import * as service from '../server/service.js';
import * as browse from '../server/browse.js';
import * as outgoingService from '../server/outgoing.js';
import { homeProjectDateLimit, homeProjectFilters } from '../shared/home-overview.js';

let db: Database,
  workspace: string,
  owner: string,
  other: string,
  viewer: string,
  foreignWorkspace: string,
  foreignActor: string,
  companyA: string,
  companyB: string,
  mailA: string,
  mailB: string,
  ownDraft: string,
  ownIssue: string,
  ownDocument: string,
  ownWeChat: string;
const run = <T>(fn: (ctx: Context) => Promise<T>, actor = owner, space = workspace) =>
  scoped(db, actor, space, fn);
const accountIds = new Map<string, string>();
async function mail(
  customer: string | null,
  patch: { historical?: boolean; muted?: boolean; project?: string; participants?: string[] } = {},
) {
  const id = randomUUID();
  await run((ctx) =>
    ctx.tx.query(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,
    fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason,
    received_after_connection,notification_enabled)
    VALUES($1,$2,$3,'fixture@163.com',$4,$5,$6,'客户咨询（合成）','[{"address":"client@example.invalid"}]','[]','[]',$10::jsonb,now(),'inbound',$7,'fixture',$8,$9)`,
      [
        workspace,
        id,
        accountIds.get(workspace),
        customer,
        patch.project || null,
        id,
        'PRIVATE_MAIL_BODY_NEVER_IN_OVERVIEW',
        !patch.historical,
        !patch.muted,
        JSON.stringify(patch.participants || []),
      ],
    ),
  );
  return id;
}
async function outgoing(
  actor: string,
  customer: string,
  status = 'draft',
  project: string | null = null,
) {
  const id = randomUUID();
  await run(
    (ctx) =>
      ctx.tx.query(
        `INSERT INTO outgoing_mail(workspace_id,customer_id,id,created_by,project_id,content,status)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          workspace,
          customer,
          id,
          actor,
          project,
          JSON.stringify({
            subject: '客户回复（合成）',
            body: 'PRIVATE_DRAFT_BODY_NEVER_IN_OVERVIEW',
            to: [],
            cc: [],
            bcc: [],
            attachments: [],
          }),
          status,
        ],
      ),
    actor,
  );
  return id;
}
async function document(actor: string, status = 'pending_association') {
  const id = randomUUID();
  await run(
    (ctx) =>
      ctx.tx.query(
        `INSERT INTO documents(workspace_id,id,uploaded_by,task_actor_id,request_id,name,format,size,
    content_hash,original_base64,status,sections) VALUES($1,$2,$3,$3,$4,'客户介绍（合成）.pdf','pdf',1,$5,$6,$7,$8::jsonb)`,
        [
          workspace,
          id,
          actor,
          randomUUID(),
          createHash('sha256').update(id).digest('hex'),
          'PRIVATE_ORIGINAL_NEVER_IN_OVERVIEW',
          status,
          JSON.stringify([{ label: '第1页', text: 'PRIVATE_DOCUMENT_BODY_NEVER_IN_OVERVIEW' }]),
        ],
      ),
    actor,
  );
  return id;
}
async function wechat(
  actor: string,
  messages: unknown[] = [{ text: 'PRIVATE_WECHAT_BODY_NEVER_IN_OVERVIEW' }],
) {
  const id = randomUUID();
  await run(
    (ctx) =>
      ctx.tx.query(
        `INSERT INTO wechat_queries(workspace_id,actor_id,id,request_id,account_key,identity,start_date,end_date,
    messages,entities,relations) VALUES($1,$2,$3,$4,'fixture-account','{"id":"fixture-person","name":"合成联系人","remark":"合成备注"}',
    '2026-10-26','2026-10-26',$5::jsonb,'[]','[]')`,
        [workspace, actor, id, randomUUID(), JSON.stringify(messages)],
      ),
    actor,
  );
  return id;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const first = await createWorkspace(db, {
    name: '首页概览合成验收',
    email: 'home-overview@example.invalid',
    displayName: 'Owner',
    password: 'fixture-password',
  });
  workspace = first.workspaceId;
  owner = first.actorId;
  const second = await createWorkspace(db, {
    name: '第二空间',
    email: 'home-overview-foreign@example.invalid',
    displayName: 'Other',
    password: 'fixture-password',
  });
  foreignWorkspace = second.workspaceId;
  foreignActor = second.actorId;
  other = randomUUID();
  viewer = randomUUID();
  for (const [actor, role] of [
    [other, 'admin'],
    [viewer, 'member'],
  ]) {
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      actor,
      `${actor}@example.invalid`,
      'Fixture',
      'unused',
    ]);
    await db.query('INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,$3)', [
      workspace,
      actor,
      role,
    ]);
  }
  companyA = (
    await run((ctx) =>
      service.insert(ctx, 'customers', {
        name: '已授权客户（合成）',
        type: 'group',
        source: 'other',
      }),
    )
  ).id as string;
  companyB = (
    await run((ctx) =>
      service.insert(ctx, 'customers', {
        name: '另一客户（合成）',
        type: 'group',
        source: 'other',
      }),
    )
  ).id as string;
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [workspace, companyA, viewer],
    ),
  );
  const account = randomUUID();
  accountIds.set(workspace, account);
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,'fixture@163.com','synthetic-not-a-secret',$3)",
      [workspace, account, owner],
    ),
  );
  mailA = await mail(companyA);
  mailB = await mail(companyB);
  ownDraft = await outgoing(owner, companyA);
  ownIssue = await outgoing(owner, companyA, 'failed');
  ownDocument = await document(owner);
  ownWeChat = await wechat(owner);
  await outgoing(other, companyA);
  await document(other);
  await wechat(other);
}, 30000);
afterAll(() => db?.close());

it('returns only metadata and true category counts with deterministic issue-first ordering', async () => {
  const result = await run(overview);
  expect(result.counts).toEqual({
    mail: 2,
    draft: 1,
    outgoing_issue: 1,
    document: 1,
    wechat: 1,
    workflow: 0,
  });
  expect(result.total).toBe(6);
  expect(result.items).toHaveLength(6);
  expect(result.items[0]).toMatchObject({
    id: ownIssue,
    kind: 'outgoing_issue',
    status: 'failed',
    action_label: '查看并核对',
  });
  expect(result.items.find((item) => item.id === ownDraft)?.action_label).toBe('继续编辑');
  expect(new Set(result.items.map((item) => item.id))).toEqual(
    new Set([mailA, mailB, ownDraft, ownIssue, ownDocument, ownWeChat]),
  );
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(
    result.items.every(
      (item) => !('body' in item) && !('messages' in item) && !('original_base64' in item),
    ),
  ).toBe(true);
});
it('respects customer access and keeps drafts and pending material private to their actor', async () => {
  const result = await run(overview, viewer);
  expect(result.items.map((item) => item.id)).toEqual([mailA]);
  expect(result.counts).toEqual({
    mail: 1,
    draft: 0,
    outgoing_issue: 0,
    document: 0,
    wechat: 0,
    workflow: 0,
  });
  const otherResult = await run(overview, other);
  expect(otherResult.counts).toEqual({
    mail: 2,
    draft: 1,
    outgoing_issue: 0,
    document: 1,
    wechat: 1,
    workflow: 0,
  });
  expect(
    otherResult.items.some((item) =>
      [ownDraft, ownIssue, ownDocument, ownWeChat].includes(item.id),
    ),
  ).toBe(false);
});
it('returns a genuinely empty overview for an empty different workspace', async () => {
  expect(await run(overview, foreignActor, foreignWorkspace)).toEqual({
    items: [],
    total: 0,
    counts: { mail: 0, draft: 0, outgoing_issue: 0, document: 0, wechat: 0, workflow: 0 },
  });
});
it('tracks unread independently per actor and excludes historical, muted, unprocessed and empty inputs', async () => {
  const before = (await run(overview)).total;
  await mail(companyA, { historical: true });
  await mail(companyA, { muted: true });
  await document(owner, 'queued');
  await wechat(owner, []);
  expect((await run(overview)).total).toBe(before);
  await run((ctx) => readNotification(ctx, mailA));
  expect((await run(overview)).counts.mail).toBe(1);
  expect((await run(overview, other)).counts.mail).toBe(2);
  expect((await run(overview, viewer)).counts.mail).toBe(1);
});
it('counts all pending items before truncating the six-row preview', async () => {
  const before = await run(overview);
  for (let i = 0; i < 9; i++) await outgoing(owner, companyA);
  const result = await run(overview);
  expect(result.items).toHaveLength(6);
  expect(result.total).toBe(before.total + 9);
  expect(result.counts.draft).toBe(before.counts.draft + 9);
  expect(result.items[0].id).toBe(ownIssue);
});
it('keeps unassociated mail admin-only and immediately drops revoked customer access', async () => {
  const before = await run(overview);
  await mail(null);
  expect((await run(overview)).total).toBe(before.total + 1);
  expect((await run(overview, viewer)).counts.mail).toBe(1);
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, companyA, viewer],
    ),
  );
  expect((await run(overview, viewer)).total).toBe(0);
});
it('excludes archived customer/project navigation targets', async () => {
  const company = (
    await run((ctx) =>
      service.insert(ctx, 'customers', { name: '待归档（合成）', type: 'group', source: 'other' }),
    )
  ).id as string;
  const project = (
    await run((ctx) =>
      service.insert(ctx, 'projects', {
        customer_id: company,
        name: '待归档项目（合成）',
        type: 'purchase',
      }),
    )
  ).id as string;
  await mail(company, { project });
  await outgoing(owner, company, 'draft', project);
  const before = (await run(overview)).total;
  await run((ctx) =>
    service.update(ctx, 'projects', project, { version: 1, archived: true }, company),
  );
  expect((await run(overview)).total).toBe(before - 2);
  await outgoing(owner, company);
  const beforeCompany = (await run(overview)).total;
  await run((ctx) => service.update(ctx, 'customers', company, { version: 1, archived: true }));
  expect((await run(overview)).total).toBe(beforeCompany - 1);
});
it('uses Shanghai calendar dates and inclusive thirty-day project cutoff', () => {
  expect(homeProjectDateLimit(new Date('2026-10-26T15:59:59Z'))).toBe('2026-11-26');
  expect(homeProjectDateLimit(new Date('2026-10-26T16:00:00Z'))).toBe('2026-11-27');
  expect(homeProjectDateLimit(new Date('2027-01-31T02:00:00Z'))).toBe('2027-03-03');
});
it('filters recent projects on the server, retaining overdue and excluding empty, terminal and distant dates', async () => {
  for (const [name, due_date, stage] of [
    ['逾期', '2026-10-01', 'new'],
    ['今天', '2026-10-26', 'new'],
    ['第三十天', '2026-11-25', 'new'],
    ['第三十一天', '2026-11-26', 'new'],
    ['未设日期', null, 'new'],
    ['完成', '2026-10-27', 'completed'],
    ['取消', '2026-10-27', 'cancelled'],
  ])
    await run((ctx) =>
      service.insert(ctx, 'projects', {
        customer_id: companyA,
        name,
        type: 'purchase',
        due_date,
        stage,
      }),
    );
  const result = await run((ctx) =>
    browse.projects(ctx, {
      sort: 'due_date',
      direction: 'asc',
      filters: JSON.stringify(homeProjectFilters(new Date('2026-10-26T06:00:00Z'))),
    }),
  );
  expect(result.items.map((item) => item.name)).toEqual(['逾期', '今天', '第三十天']);
});

async function workflow(
  actor: string,
  customerId: string | null,
  step: 'configure' | 'ready' | 'decision' | 'review' | 'completed' | 'cancelled',
  options: {
    kind?: 'summary' | 'reply' | 'update';
    mail_id?: string;
    document_id?: string;
    project_id?: string;
    person_id?: string;
  } = {},
) {
  const id = randomUUID(),
    chatId = randomUUID();
  const config = {
    customer_id: customerId,
    person_id: options.person_id || null,
    project_id: options.project_id || null,
    source_kinds: ['mail', 'wechat'],
    date_start: null,
    date_end: null,
    mail_id: options.mail_id || null,
    document_id: options.document_id || null,
    material: null,
    instruction: 'PRIVATE_WORKFLOW_INSTRUCTION_NEVER_IN_OVERVIEW',
    field_ids: [],
  };
  await run(async (ctx) => {
    await ctx.tx.query(
      'INSERT INTO agent_chats(workspace_id,actor_id,id,title,customer_id) VALUES($1,$2,$3,$4,NULL)',
      [workspace, actor, chatId, 'PRIVATE_CHAT_TITLE_NEVER_IN_OVERVIEW'],
    );
    await ctx.tx.query(
      `INSERT INTO home_workflows(workspace_id,actor_id,id,chat_id,kind,step,customer_id,person_id,project_id,config,result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
      [
        workspace,
        actor,
        id,
        chatId,
        options.kind || 'summary',
        step,
        customerId,
        config.person_id,
        config.project_id,
        JSON.stringify(config),
        JSON.stringify({ body: 'PRIVATE_WORKFLOW_BODY_NEVER_IN_OVERVIEW' }),
      ],
    );
  }, actor);
  return { id, chatId };
}
it('opens overview outgoing rows with the real read/compose services and preserves their scope', async () => {
  for (const id of [ownDraft, ownIssue]) {
    const draft = await run((ctx) => outgoingService.getOutgoing(ctx, id));
    expect(draft.customer_id).toBe(companyA);
    expect(draft.person_id).toBeNull();
    expect(draft.status).toBe(id === ownDraft ? 'draft' : 'failed');
    expect(
      (await run((ctx) => outgoingService.composeOptions(ctx, draft.customer_id, 'customers')))
        .accounts,
    ).toHaveLength(1);
  }
  await expect(
    run((ctx) => outgoingService.getOutgoing(ctx, ownDraft), other),
  ).rejects.toMatchObject({ status: 404 });
});
it('resumes unfinished workflows through their original chat while excluding completed, cancelled and other actors', async () => {
  const before = await run(overview);
  const configure = await workflow(owner, null, 'configure');
  const ready = await workflow(owner, companyA, 'ready');
  const decision = await workflow(owner, companyA, 'decision', { kind: 'reply' });
  const review = await workflow(owner, companyA, 'review', { kind: 'update' });
  await workflow(owner, companyA, 'completed');
  await workflow(owner, companyA, 'cancelled');
  const otherTask = await workflow(other, companyA, 'decision', { kind: 'reply' });
  const result = await run(overview);
  expect(result.total).toBe(before.total + 3);
  expect(result.counts.workflow).toBe(3);
  expect(result.items.some((item) => item.id === ready.id)).toBe(false);
  expect(result.items.filter((item) => item.kind === 'workflow').map((item) => item.id)).toEqual(
    expect.arrayContaining([decision.id, review.id]),
  );
  expect(result.items.find((item) => item.id === decision.id)).toMatchObject({
    chat_id: decision.chatId,
    workflow_kind: 'reply',
    status: 'decision',
    subtitle: expect.stringContaining('需要你决定'),
  });
  expect(result.items.find((item) => item.id === review.id)?.subtitle).toContain('资料变更待保存');
  expect(result.items.some((item) => item.id === otherTask.id)).toBe(false);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(result.items[0].id).toBe(ownIssue);
  await run((ctx) =>
    ctx.tx.query("UPDATE home_workflows SET step='cancelled' WHERE workspace_id=$1 AND id=$2", [
      workspace,
      configure.id,
    ]),
  );
  expect((await run(overview)).counts.workflow).toBe(2);
  expect((await run(overview, other)).counts.workflow).toBe(1);
  expect(ready.chatId).not.toBe(decision.chatId);
});
it('keeps generated summaries available in their chats without counting them as unfinished work', async () => {
  const before = await run(overview);
  const summary = await workflow(owner, companyA, 'ready');
  const after = await run(overview);
  expect(after.total).toBe(before.total);
  expect(after.counts.workflow).toBe(before.counts.workflow);
  expect(after.items.some((item) => item.id === summary.id)).toBe(false);
  const stored = await run((ctx) =>
    ctx.tx.query<{ chat_id: string; result: { body: string } }>(
      'SELECT chat_id,result FROM home_workflows WHERE workspace_id=$1 AND id=$2',
      [workspace, summary.id],
    ),
  );
  expect(stored.rows[0]).toEqual({
    chat_id: summary.chatId,
    result: { body: 'PRIVATE_WORKFLOW_BODY_NEVER_IN_OVERVIEW' },
  });
  await run((ctx) =>
    ctx.tx.query('UPDATE home_workflows SET result=NULL WHERE workspace_id=$1 AND id=$2', [
      workspace,
      summary.id,
    ]),
  );
  expect((await run(overview)).counts.workflow).toBe(before.counts.workflow + 1);
});
it('hides workflows whose chosen source belongs to another scope, has failed, or is no longer readable', async () => {
  const before = (await run(overview)).counts.workflow;
  await workflow(owner, companyA, 'decision', { kind: 'reply', mail_id: mailB });
  await workflow(owner, null, 'configure', { document_id: await document(other) });
  const failedDoc = await document(owner);
  await run((ctx) =>
    ctx.tx.query("UPDATE documents SET status='failed' WHERE workspace_id=$1 AND id=$2", [
      workspace,
      failedDoc,
    ]),
  );
  await workflow(owner, null, 'configure', { document_id: failedDoc });
  expect((await run(overview)).counts.workflow).toBe(before);
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [workspace, companyA, viewer],
    ),
  );
  await workflow(viewer, companyA, 'decision');
  expect((await run(overview, viewer)).counts.workflow).toBe(1);
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, companyA, viewer],
    ),
  );
  expect((await run(overview, viewer)).counts.workflow).toBe(0);
});
it.each(['038_home_workflows.sql', '041_agent_mail_harness.sql'])(
  'applies %s without changing existing table data or business triggers',
  async (migration) => {
    const isolated = await openDatabase();
    try {
      const directory = new URL('../server/migrations/', import.meta.url);
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith('.sql') && name < migration)
        .sort())
        await isolated.exec(await readFile(new URL(name, directory), 'utf8'));
      const fixture = await createWorkspace(isolated, {
        name: '迁移隔离校验',
        email: 'overview-migration@example.invalid',
        displayName: 'Fixture',
        password: 'synthetic-password',
      });
      await scoped(isolated, fixture.actorId, fixture.workspaceId, (ctx) =>
        service.insert(ctx, 'customers', {
          name: '原有客户（合成）',
          type: 'group',
          source: 'other',
        }),
      );
      if (migration === '041_agent_mail_harness.sql') {
        const id = randomUUID();
        await isolated.query(
          'INSERT INTO agent_chats(workspace_id,actor_id,id,title) VALUES($1,$2,$3,$4)',
          [fixture.workspaceId, fixture.actorId, id, '迁移前旧流程'],
        );
        await isolated.query(
          `INSERT INTO home_workflows(workspace_id,actor_id,id,chat_id,kind,config)
         VALUES($1,$2,$3,$4,'reply','{"customer_id":null,"person_id":null,"project_id":null}')`,
          [fixture.workspaceId, fixture.actorId, randomUUID(), id],
        );
      }
      const tables = (
        await isolated.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows.map((row) => row.tablename);
      async function digestTables() {
        const values: Record<string, string> = {};
        for (const table of tables) {
          const rows = (
            await isolated.query<{ value: string }>(
              `SELECT to_jsonb(t)::text AS value FROM "${table}" t ORDER BY to_jsonb(t)::text`,
            )
          ).rows;
          values[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        }
        return values;
      }
      const triggers = () =>
        isolated.query(
          "SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
        );
      const before = await digestTables(),
        beforeTriggers = (await triggers()).rows;
      await isolated.exec(await readFile(new URL(migration, directory), 'utf8'));
      expect(await digestTables()).toEqual(before);
      expect(
        (await triggers()).rows.filter((row) => tables.includes(row.relname as string)),
      ).toEqual(beforeTriggers);
      expect(
        (await isolated.query('SELECT count(*)::int AS count FROM home_workflows')).rows[0].count,
      ).toBe(migration === '041_agent_mail_harness.sql' ? 1 : 0);
      expect(
        (await isolated.query('SELECT count(*)::int AS count FROM home_workflow_requests')).rows[0]
          .count,
      ).toBe(0);
    } finally {
      await isolated.close();
    }
  },
  30000,
);

it('lets the actual outgoing draft lifecycle replace the reply workflow card without duplicate pending states', async () => {
  const before = await run(overview);
  const task = await workflow(owner, companyA, 'review', { kind: 'reply' });
  expect((await run(overview)).counts.workflow).toBe(before.counts.workflow + 1);
  await run((ctx) =>
    ctx.tx.query('UPDATE home_workflows SET draft_id=$3 WHERE workspace_id=$1 AND id=$2', [
      workspace,
      task.id,
      ownDraft,
    ]),
  );
  const after = await run(overview);
  expect(after.counts.workflow).toBe(before.counts.workflow);
  expect(after.counts.draft).toBe(before.counts.draft);
  expect(after.items.some((item) => item.id === task.id)).toBe(false);
});
it('applies current mail exclusion RLS to both unread rows and workflow source navigation', async () => {
  const blocked = await mail(companyA, { participants: ['blocked@example.invalid'] });
  const task = await workflow(owner, companyA, 'decision', { kind: 'reply', mail_id: blocked });
  const before = await run(overview);
  await run((ctx) =>
    ctx.tx.query(
      `INSERT INTO mail_exclusions(workspace_id,rules) VALUES($1,'["blocked@example.invalid"]')
    ON CONFLICT(workspace_id) DO UPDATE SET rules=EXCLUDED.rules`,
      [workspace],
    ),
  );
  try {
    const after = await run(overview);
    expect(after.counts.mail).toBe(before.counts.mail - 1);
    expect(after.counts.workflow).toBe(before.counts.workflow - 1);
    expect(after.items.some((item) => item.id === task.id || item.id === blocked)).toBe(false);
  } finally {
    await run((ctx) =>
      ctx.tx.query("UPDATE mail_exclusions SET rules='[]' WHERE workspace_id=$1", [workspace]),
    );
  }
});
