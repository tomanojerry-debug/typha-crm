import { afterAll, beforeAll, beforeEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as attributes from '../server/attributes.js';
import * as relationships from '../server/relationships.js';
import * as wechat from '../server/wechat.js';
import { entitySchema } from '../server/entity-schema.js';
import { extractSnapshot } from '../server/communication-pipeline.js';
import { modelSnapshot } from '../server/ask.js';
import {
  knowledgeSnapshot,
  knowledgeView,
  recordEvidence,
  enqueueKnowledge,
  syncKnowledgeOnce,
  type KnowledgeTransport,
} from '../server/knowledge.js';
import type { KnowledgeSnapshot } from '../shared/knowledge.js';
let db: Database,
  w: string,
  actor: string,
  outsider: string,
  otherWorkspace: string,
  c: string,
  b: string,
  p: string,
  otherProject: string;
const asAdmin = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, w, fn);
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const a = await createWorkspace(db, {
    name: 'Graph tests',
    email: 'graph@example.invalid',
    displayName: 'Admin',
    password: 'graph-fixture-password',
  });
  w = a.workspaceId;
  actor = a.actorId;
  const o = await createWorkspace(db, {
    name: 'Other graph',
    email: 'graph-other@example.invalid',
    displayName: 'Other',
    password: 'graph-fixture-password',
  });
  outsider = o.actorId;
  otherWorkspace = o.workspaceId;
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    w,
    outsider,
  ]);
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await asAdmin(async (ctx) => {
    c = String(
      (await service.insert(ctx, 'customers', { name: '演示舞团', type: 'group', source: 'email' }))
        .id,
    );
    b = String(
      (
        await service.insert(ctx, 'customers', {
          name: 'B PRIVATE',
          type: 'group',
          source: 'email',
        })
      ).id,
    );
    p = String(
      (await service.insert(ctx, 'projects', { customer_id: c, name: '演出服', type: 'purchase' }))
        .id,
    );
    otherProject = String(
      (
        await service.insert(ctx, 'projects', {
          customer_id: b,
          name: 'B project',
          type: 'purchase',
        })
      ).id,
    );
  });
  await db.query('DELETE FROM knowledge_sync');
});
async function record(body: string, project: string | null = p) {
  return asAdmin((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: c,
      project_id: project,
      body,
      kind: 'customer_quote',
      created_by: actor,
    }),
  );
}
const fake: KnowledgeTransport = {
  async sync(s) {
    return s.sources.map((v, i) => ({
      id: v.id,
      fact: v.body,
      relation: 'requirement',
      valid_at: v.occurred_at,
      invalid_at: i < s.sources.length - 1 ? s.sources[i + 1].occurred_at : null,
      source_ids: [v.id],
      project_id: v.project_id,
      trust: v.trust,
    }));
  },
  async discard() {},
};
async function sync(transport: KnowledgeTransport = fake) {
  await db.query('DELETE FROM knowledge_sync WHERE customer_id<>$1', [c]);
  return syncKnowledgeOnce(db, transport);
}
const view = (filter = {}) => asAdmin((ctx) => knowledgeView(ctx, c, filter));

it('refreshes schema after creating, changing and archiving attributes and relationships', async () => {
  const first = await asAdmin(entitySchema);
  const field = await asAdmin((ctx) =>
    attributes.createField(ctx, { name: '演示数量' + c, kind: 'number' }),
  );
  const second = await asAdmin(entitySchema);
  expect(second.revision).not.toBe(first.revision);
  expect(second.company_attributes.some((f) => f.id === field.id)).toBe(true);
  const rel = await asAdmin((ctx) =>
    relationships.createDefinition(ctx, {
      source_object: 'people',
      target_object: 'projects',
      source_label: '参与' + c,
      target_label: '负责人',
      cardinality: 'many_to_many',
    }),
  );
  const third = await asAdmin(entitySchema);
  expect(third.revision).not.toBe(second.revision);
  expect(third.relationships.some((r) => r.id === rel.id)).toBe(true);
  const { id: fieldId, ...config } = field;
  await asAdmin((ctx) =>
    attributes.updateField(ctx, fieldId, { ...config, version: field.version, archived: true }),
  );
  const final = await asAdmin(entitySchema);
  expect(final.company_attributes.some((f) => f.id === field.id)).toBe(false);
  expect(
    (
      await asAdmin((ctx) =>
        modelSnapshot(ctx, { kind: 'entity', object: 'customers', customer_id: c, record_id: c }),
      )
    ).schema?.revision,
  ).toBe(final.revision);
});
it('persists pending sync transactionally, rolls back with the source and preserves customer scope', async () => {
  await expect(
    asAdmin(async (ctx) => {
      await service.insert(ctx, 'customer_records', {
        customer_id: c,
        body: 'rollback',
        kind: 'inference',
        created_by: actor,
      });
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect((await db.query('SELECT * FROM knowledge_sync')).rows).toHaveLength(0);
  await record('100件');
  expect((await view()).state).toBe('pending');
  await expect(scoped(db, outsider, w, (ctx) => knowledgeSnapshot(ctx, c))).rejects.toThrow();
  await expect(
    scoped(db, actor, otherWorkspace, (ctx) => knowledgeSnapshot(ctx, c)),
  ).rejects.toThrow();
  await scoped(db, outsider, w, async (ctx) => {
    expect((await ctx.tx.query('SELECT * FROM knowledge_sync')).rows).toHaveLength(0);
  });
});
it('publishes old/new sourced candidates without writing CRM fields and skips duplicate indexing', async () => {
  await record('100件');
  await record('80件');
  let calls = 0;
  const transport = {
    ...fake,
    async sync(s: KnowledgeSnapshot, g: string, old: string | null) {
      calls++;
      return fake.sync(s, g, old);
    },
  };
  await sync(transport);
  const result = await view();
  expect(result.state).toBe('ready');
  expect(result.facts).toHaveLength(2);
  expect(result.facts[0].invalid_at).not.toBeNull();
  expect(result.facts[1].sources).toHaveLength(1);
  await asAdmin((ctx) => enqueueKnowledge(ctx, c));
  await sync(transport);
  expect(calls).toBe(1);
  expect((await asAdmin((ctx) => service.customer(ctx, c))).version).toBe(1);
  expect(
    (
      await asAdmin((ctx) =>
        modelSnapshot(ctx, { kind: 'entity', object: 'projects', customer_id: c, record_id: p }),
      )
    ).sources.some((s) => s.id.startsWith('record:') && s.body.includes('derived_facts')),
  ).toBe(true);
});
it('invalidates a published graph immediately when sources or definitions change', async () => {
  await record('100件');
  await sync();
  expect((await view()).facts).toHaveLength(1);
  await record('80件');
  expect((await view()).facts).toHaveLength(0);
  expect((await view()).state).toBe('pending');
  await sync();
  await asAdmin((ctx) => attributes.createField(ctx, { name: '新增' + c, kind: 'text' }));
  expect((await view()).facts).toHaveLength(0);
});
it('does not publish stale async results and retries against fresh sources', async () => {
  await record('100件');
  await sync({
    ...fake,
    async sync(s, g, old) {
      await record('80件');
      return fake.sync(s, g, old);
    },
  });
  expect((await view()).state).toBe('pending');
  expect((await view()).facts).toHaveLength(0);
  await sync();
  expect((await view()).facts).toHaveLength(2);
});
it('rejects fabricated provenance and clears failed generations', async () => {
  await record('100件');
  let cleaned = 0;
  await sync({
    async sync() {
      return [
        {
          id: 'bad',
          fact: 'other private',
          relation: 'x',
          valid_at: null,
          invalid_at: null,
          source_ids: ['mail:foreign'],
          project_id: p,
          trust: 'customer_quote',
        },
      ];
    },
    async discard() {
      cleaned++;
    },
  });
  const result = await view();
  expect(result.state).toBe('failed');
  expect(result.facts).toHaveLength(0);
  expect(cleaned).toBe(1);
  expect(result.error).not.toContain('private');
});
it('keeps customer-level facts out of projects and rejects wrong customer project IDs', async () => {
  await record('项目100件');
  await record('公司背景', null);
  await sync();
  const v = await view({ project_id: p });
  expect(v.facts).toHaveLength(1);
  expect(v.facts[0].fact).toContain('100');
  await expect(view({ project_id: otherProject })).rejects.toThrow();
  const snapshot = await asAdmin((ctx) => knowledgeSnapshot(ctx, c));
  expect(JSON.stringify(snapshot)).not.toContain('B PRIVATE');
});
it('hides current projection after source membership changes even without an outbox trigger', async () => {
  await record('100件');
  await sync();
  await db.query("UPDATE customer_records SET body='changed by maintenance' WHERE customer_id=$1", [
    c,
  ]);
  expect((await view()).facts).toHaveLength(0);
  expect((await view()).state).toBe('pending');
});
it('lets an authorized viewer read the same projection without granting sync rights', async () => {
  await record('100件');
  await sync();
  await asAdmin((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [w, c, outsider],
    ),
  );
  const result = await scoped(db, outsider, w, (ctx) => knowledgeView(ctx, c));
  expect(result.state).toBe('ready');
  expect(result.facts).toHaveLength(1);
  expect(result.can_sync).toBe(false);
  await expect(scoped(db, outsider, w, (ctx) => enqueueKnowledge(ctx, c))).rejects.toThrow();
});
it('filters a person by all cited sources and preserves company confirmation as a separate trust class', async () => {
  const personId = randomUUID();
  await asAdmin((ctx) =>
    ctx.tx.query('INSERT INTO people(workspace_id,customer_id,id,name) VALUES($1,$2,$3,$4)', [
      w,
      c,
      personId,
      '演示联系人',
    ]),
  );
  const r = await record('客户期望80件');
  await asAdmin((ctx) =>
    ctx.tx.query(
      "INSERT INTO knowledge_wechat_evidence(workspace_id,customer_id,id,source_key,record_id,person_id,project_id,occurred_at,speaker,body,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,now(),'演示联系人','80件',$8)",
      [w, c, randomUUID(), randomUUID(), r.id, personId, p, actor],
    ),
  );
  await asAdmin((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: c,
      project_id: p,
      kind: 'company_confirmed',
      body: '公司确认先评估交期',
      created_by: actor,
    }),
  );
  await sync();
  const filtered = await view({ person_id: personId });
  expect(filtered.facts).toHaveLength(1);
  expect(filtered.facts[0].sources[0].speaker).toBe('演示联系人');
  const all = await view();
  expect(all.facts.some((f) => f.trust === 'company_confirmed')).toBe(true);
});
it('revalidates worker actor access before sending evidence and before publishing', async () => {
  await asAdmin(async (ctx) => {
    await ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [w, c, outsider],
    );
  });
  await record('100件');
  await scoped(db, outsider, w, (ctx) => enqueueKnowledge(ctx, c));
  let calls = 0;
  await sync({
    ...fake,
    async sync(s, g, old) {
      calls++;
      await asAdmin((ctx) =>
        ctx.tx.query('DELETE FROM customer_access WHERE customer_id=$1 AND actor_id=$2', [
          c,
          outsider,
        ]),
      );
      return fake.sync(s, g, old);
    },
  });
  expect(calls).toBe(1);
  expect((await view()).facts).toHaveLength(0);
  await db.query("UPDATE knowledge_sync SET state='pending',retry_at=NULL WHERE customer_id=$1", [
    c,
  ]);
  await sync({
    ...fake,
    async sync() {
      calls++;
      return [];
    },
  });
  expect(calls).toBe(1);
});
it('does not ingest unmatched mail; associates once and deduplicates sources', async () => {
  const account = randomUUID(),
    mail = randomUUID();
  await asAdmin(async (ctx) => {
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [w, account, account + '@example.invalid', 'fixture', actor],
    );
    await ctx.tx.query(
      "INSERT INTO mail_messages(workspace_id,id,account_id,account_email,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason) VALUES($1,$2,$3,'demo@example.invalid','one','100件','[]','[]','[]','[]',now(),'inbound','100件','unmatched')",
      [w, mail, account],
    );
  });
  expect((await asAdmin((ctx) => knowledgeSnapshot(ctx, c))).sources).toHaveLength(0);
  await asAdmin((ctx) =>
    ctx.tx.query(
      'UPDATE mail_messages SET customer_id=$1,project_id=$2 WHERE workspace_id=$3 AND id=$4',
      [c, p, w, mail],
    ),
  );
  const snapshot = await asAdmin((ctx) => knowledgeSnapshot(ctx, c));
  expect(snapshot.sources).toHaveLength(1);
  expect(snapshot.sources[0].channel).toBe('email');
  const recordId = snapshot.sources[0].record_id;
  expect(snapshot.sources[0].id).toBe(`record:${recordId}`);
  await asAdmin((ctx) =>
    ctx.tx.query('UPDATE mail_messages SET subject=$1 WHERE id=$2', ['更新主题', mail]),
  );
  expect((await asAdmin((ctx) => knowledgeSnapshot(ctx, c))).sources[0].record_id).toBe(recordId);
  await sync();
  await asAdmin((ctx) => enqueueKnowledge(ctx, c));
  await sync();
  expect((await view()).facts).toHaveLength(1);
  const context = await asAdmin((ctx) =>
    modelSnapshot(ctx, { kind: 'entity', object: 'customers', record_id: c, customer_id: c }),
  );
  expect(context.sources.filter((s) => s.id === `record::${recordId}`)).toHaveLength(1);
  expect(context.sources.some((s) => s.ref?.kind === 'mail' && s.ref.id === mail)).toBe(false);
  const details = await asAdmin((ctx) => recordEvidence(ctx, c, recordId));
  expect(details.sources[0].ref.id).toBe(mail);
  expect(details.sources[0].body).toContain('100件');
  expect(details.facts).toHaveLength(1);
  await expect(
    scoped(db, outsider, w, (ctx) => recordEvidence(ctx, c, recordId)),
  ).rejects.toThrow();
  await expect(asAdmin((ctx) => recordEvidence(ctx, b, recordId))).rejects.toThrow();
  await asAdmin(async (ctx) => {
    await ctx.tx.query('UPDATE mail_messages SET participants=$1::jsonb WHERE id=$2', [
      JSON.stringify(['blocked@example.invalid']),
      mail,
    ]);
    await ctx.tx.query(
      'INSERT INTO mail_exclusions(workspace_id,rules) VALUES($1,$2::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET rules=excluded.rules',
      [w, JSON.stringify(['blocked@example.invalid'])],
    );
  });
  await expect(asAdmin((ctx) => recordEvidence(ctx, c, recordId))).rejects.toThrow();
  expect((await asAdmin((ctx) => knowledgeSnapshot(ctx, c))).sources).toHaveLength(0);
  expect((await view()).facts).toHaveLength(0);
});
it('keeps originals readable after archival without reusing stale graph facts', async () => {
  const r = await record('历史沟通原文');
  await sync();
  await asAdmin((ctx) => ctx.tx.query('UPDATE customers SET archived_at=now() WHERE id=$1', [c]));
  const details = await asAdmin((ctx) => recordEvidence(ctx, c, String(r.id)));
  expect(details.sources[0].body).toBe('历史沟通原文');
  expect(details.facts).toHaveLength(0);
});
it('keeps unbound WeChat private and archives all read source messages once a source is bound', async () => {
  const contact = { id: 'wx-fixture', name: '演示老师', remark: '', wechat_id: 'fixture' };
  const options: wechat.WeChatOptions = {
    actorId: actor,
    connectorRequired: false,
    connectorBindingEnabled: false,
    transport: {
      async status() {
        return { state: 'ready', message: 'fixture', account_key: 'fixture-account' };
      },
      async resolve() {
        return [contact];
      },
      async openApp() {},
      async history() {
        return {
          messages: [
            {
              id: 'selected',
              at: '2026-10-22T02:00:00Z',
              speaker: '老师',
              from_me: false,
              text: '数量改为80件，等待公司确认。',
            },
            {
              id: 'private',
              at: '2026-10-22T03:00:00Z',
              speaker: '老师',
              from_me: false,
              text: 'UNSELECTED_PRIVATE_MESSAGE',
            },
          ],
          warnings: [],
        };
      },
    },
  };
  const result = await asAdmin((ctx) =>
    wechat.preview(
      ctx,
      { identity: '演示老师', start: '2026-10-22', end: '2026-10-22', request_id: randomUUID() },
      options,
    ),
  );
  const preview = result.preview!;
  expect((await asAdmin((ctx) => knowledgeSnapshot(ctx, c))).sources).toHaveLength(0);
  const input = { customer_id: c, project_id: p, person_id: null };
  const archived = await asAdmin((ctx) => wechat.associate(ctx, preview.id, input));
  expect(archived.record_count).toBe(2);
  const snapshot = await asAdmin((ctx) => knowledgeSnapshot(ctx, c));
  expect(snapshot.sources.some((s) => s.channel === 'wechat' && s.body.includes('80'))).toBe(true);
  expect(snapshot.sources.some((s) => s.body === 'UNSELECTED_PRIVATE_MESSAGE')).toBe(true);
  const context = await asAdmin((ctx) =>
    modelSnapshot(ctx, { kind: 'entity', object: 'customers', record_id: c, customer_id: c }),
  );
  expect(JSON.stringify(context)).toContain('数量改为80件');
  expect(JSON.stringify(context)).toContain('UNSELECTED_PRIVATE_MESSAGE');
  await asAdmin((ctx) => wechat.associate(ctx, preview.id, input));
  expect((await asAdmin((ctx) => knowledgeSnapshot(ctx, c))).sources).toHaveLength(
    snapshot.sources.length,
  );
  const fullResult = await asAdmin((ctx) =>
    wechat.preview(
      ctx,
      { identity: '演示老师', start: '2026-10-22', end: '2026-10-22', request_id: randomUUID() },
      options,
    ),
  );
  expect(fullResult.preview).toMatchObject({
    state: 'associated',
    archive_automatic: true,
    archive_new_records: 0,
    record_count: 2,
  });
  await expect(
    asAdmin((ctx) =>
      wechat.associate(ctx, fullResult.preview!.id, { ...input, customer_id: b, project_id: null }),
    ),
  ).rejects.toThrow('改变归属');
  expect((await asAdmin((ctx) => knowledgeSnapshot(ctx, c))).sources).toHaveLength(
    snapshot.sources.length,
  );
  expect(
    (await asAdmin((ctx) => knowledgeSnapshot(ctx, c))).sources.find(
      (source) => source.body === 'UNSELECTED_PRIVATE_MESSAGE',
    )?.speaker_side,
  ).toBe('external');

  expect(
    (
      await scoped(db, outsider, w, (ctx) =>
        ctx.tx.query('SELECT * FROM knowledge_wechat_evidence'),
      )
    ).rows,
  ).toHaveLength(0);
});

it('publishes validated candidates with facts atomically and returns them through the original Record', async () => {
  const r = await record('预计80件');
  await sync({
    ...fake,
    async sync(s, g, old) {
      const extraction = await extractSnapshot(s, [], async (input) => ({
        version: input.version,
        record_id: input.record_id,
        trust: 'unconfirmed',
        entities: [],
        attributes: [],
        relations: [],
        changes: [],
        uncertainties: [],
      }));
      return { facts: await fake.sync(s, g, old), extractions: extraction.extractions };
    },
  });
  const details = await asAdmin((ctx) => recordEvidence(ctx, c, String(r.id)));
  expect(details.extractions).toHaveLength(1);
  expect(details.extractions[0].record_id).toBe(r.id);
  await scoped(db, outsider, w, async (ctx) =>
    expect((await ctx.tx.query('SELECT extractions FROM knowledge_sync')).rows).toEqual([]),
  );
  await record('后续80件仍待核对');
  expect((await asAdmin((ctx) => recordEvidence(ctx, c, String(r.id)))).extractions).toEqual([]);
});
