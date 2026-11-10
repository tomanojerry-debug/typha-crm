// Synthetic, mocked-model integration tests. They do not establish real-model
// semantic accuracy; live document/source-quality validation is a separate check.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as attributes from '../server/attributes.js';
import { documentDetail, uploadDocument, processDocument } from '../server/documents.js';
import { sanitizeAttributeSources } from '../server/attribute-source-visibility.js';
import {
  documentAttributeLimits,
  listDocumentAttributeFields,
  organizeDocumentAttributes,
  isDocumentAttributeFieldAllowed,
  type DocumentAttributeOptions,
} from '../server/document-attributes.js';
import { callMiniMax, type AttributeModelInput } from '../server/attribute-model.js';
import type { AttributeSource, CompanyAttribute } from '../shared/attributes.js';
import type { DocumentDetail, DocumentSection } from '../shared/documents.js';

let db: Database, workspace: string, actor: string, editor: string, viewer: string;
let customer: string, otherCustomer: string, project: string, otherProject: string;
const quote = '星澜舞蹈学校主营芭蕾教学，成立于2012年。';
const unrelated = '附录：合作方海帆物流主营冷链运输，成立于2001年。';
const inScope = <T>(fn: (ctx: Context) => Promise<T>, who = actor) =>
  scoped(db, who, workspace, fn);
const mutate = (sql: string, params: unknown[]) => inScope((ctx) => ctx.tx.query(sql, params));

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Document attributes synthetic',
    email: 'document-attributes@example.invalid',
    password: 'synthetic-document-attributes-password',
    displayName: 'Admin',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  await inScope(async (ctx) => {
    customer = String(
      (
        await service.insert(ctx, 'customers', {
          name: '星澜舞蹈学校',
          type: 'group',
          source: 'other',
        })
      ).id,
    );
    otherCustomer = String(
      (
        await service.insert(ctx, 'customers', {
          name: '另一家公司',
          type: 'group',
          source: 'other',
        })
      ).id,
    );
    project = String(
      (
        await service.insert(ctx, 'projects', {
          name: '学校演出项目',
          customer_id: customer,
          type: 'custom',
        })
      ).id,
    );
    otherProject = String(
      (
        await service.insert(ctx, 'projects', {
          name: '其他客户项目',
          customer_id: otherCustomer,
          type: 'sample',
        })
      ).id,
    );
  });
  for (const role of ['editor', 'viewer'] as const) {
    const id = randomUUID();
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `document-${role}@example.invalid`,
      role,
      'unused-test-password-hash',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      workspace,
      id,
    ]);
    await mutate(
      'INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,$4)',
      [workspace, customer, id, role],
    );
    if (role === 'editor') editor = id;
    else viewer = id;
  }
}, 30000);
afterAll(() => db.close());

async function field(extra: Record<string, unknown> = {}) {
  return inScope((ctx) =>
    attributes.createField(ctx, {
      name: `主营业务 ${randomUUID().slice(0, 8)}`,
      kind: 'text',
      description: '当前公司的主营业务',
      ai_enabled: true,
      guidance: '只填写当前公司主营业务，保留主体和时间范围。',
      ...extra,
    }),
  );
}
async function document(
  sections: DocumentSection[] = [
    { label: '第1页', text: quote },
    { label: '第2页 · 附录', text: unrelated },
  ],
  projectId: string | null = null,
) {
  const record = await inScope((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: customer,
      project_id: projectId,
      kind: 'customer_quote',
      body: sections.map((section) => section.text).join('\n'),
      created_by: actor,
    }),
  );
  const value: DocumentDetail = {
    id: randomUUID(),
    name: '星澜公司介绍（虚构）.pdf',
    format: 'pdf',
    size: 1000,
    customer_id: customer,
    customer_name: '星澜舞蹈学校',
    project_id: projectId,
    project_name: projectId ? '学校演出项目' : null,
    record_id: String(record.id),
    status: 'ready',
    error: null,
    warnings: [],
    section_count: sections.length,
    version: 1,
    created_at: '2026-10-26T00:00:00.000Z',
    updated_at: '2026-10-26T00:00:00.000Z',
    can_edit: true,
    knowledge_state: 'ready',
    sections,
  };
  return value;
}
const sourceId = (input: AttributeModelInput) => input.sources[0].id;
function envelope(input: AttributeModelInput, value: unknown, text = quote) {
  return {
    value,
    explanation: '依据当前文档主体、字段及原文语义核对。',
    source_ids: value === null ? [] : [sourceId(input)],
    evidence: value === null ? [] : [{ source_id: sourceId(input), quote: text }],
    missing: [],
  };
}
const goodSelection = {
  field_allowed: true,
  related: true,
  subject_matches: true,
  temporal_fit: true,
  conflict: false,
  sections: [{ index: 0, quote }],
};
const goodVerification = {
  field_allowed: true,
  related: true,
  subject_matches: true,
  temporal_fit: true,
  negation_preserved: true,
  directly_supported: true,
  conflict: false,
};
function stage(input: AttributeModelInput) {
  return input.warnings
    .find((warning) => warning.startsWith('document-attribute-stage:'))!
    .split(':')[1];
}
function options(
  value: DocumentDetail,
  hook?: (input: AttributeModelInput, index: number) => Promise<unknown>,
) {
  const seen: AttributeModelInput[] = [];
  const config: DocumentAttributeOptions = {
    async loadDocument() {
      return structuredClone(value);
    },
    transport: {
      async generate(input) {
        seen.push(input);
        if (hook) return hook(input, seen.length - 1);
        if (stage(input) === 'select') return envelope(input, JSON.stringify(goodSelection));
        if (stage(input) === 'verify') return envelope(input, JSON.stringify(goodVerification));
        return envelope(input, '芭蕾教学');
      },
    },
  };
  return { config, seen };
}
function organize(
  doc: DocumentDetail,
  fields: CompanyAttribute[],
  config: DocumentAttributeOptions,
  who = actor,
) {
  return organizeDocumentAttributes(
    db,
    who,
    workspace,
    doc.id,
    { attribute_ids: fields.map((f) => f.id) },
    config,
  );
}
async function rawValues(id: string) {
  return (
    await db.query<{ value: unknown; origin: string; sources: unknown[]; run_id: string }>(
      'SELECT value,origin,sources,run_id FROM customer_attribute_values WHERE workspace_id=$1 AND customer_id=$2 AND attribute_id=$3',
      [workspace, customer, id],
    )
  ).rows;
}

it('lists only enabled ordinary fields, then saves a located document source with AI provenance', async () => {
  const enabled = await field(),
    disabled = await field({ ai_enabled: false });
  const doc = await document();
  const { config, seen } = options(doc);
  const listed = await inScope((ctx) => listDocumentAttributeFields(ctx, doc.id, config));
  expect(listed.fields.some((f) => f.id === enabled.id && f.current_value === null)).toBe(true);
  expect(listed.fields.some((f) => f.id === disabled.id)).toBe(false);
  const result = await organize(doc, [enabled], config);
  expect(result.results[0]).toMatchObject({
    status: 'filled',
    value: '芭蕾教学',
    evidence: [{ label: '第1页', quote }],
  });
  expect(seen.map(stage)).toEqual(['select', 'generate', 'verify']);
  expect(seen[1].sources[0].body).not.toContain('海帆物流');
  const saved = (await rawValues(enabled.id))[0];
  expect(saved).toMatchObject({
    value: '芭蕾教学',
    origin: 'ai',
    sources: [{ id: `record:${doc.record_id}`, kind: 'record', quote }],
  });
  expect(JSON.stringify(saved.sources)).toContain('第1页');
  const run = (
    await db.query<{ state: string; actor_id: string }>(
      'SELECT state,actor_id FROM customer_attribute_runs WHERE workspace_id=$1 AND id=$2',
      [workspace, saved.run_id],
    )
  ).rows[0];
  expect(run).toEqual({ state: 'applied', actor_id: actor });
});

it('works with the canonical documents snapshot and stub Record, with live source sanitization', async () => {
  const f = await field();
  const uploaded = await inScope((ctx) =>
    uploadDocument(ctx, {
      request_id: randomUUID(),
      name: 'canonical-synthetic.pdf',
      content_base64: Buffer.from('%PDF-1.7\n% synthetic canonical document').toString('base64'),
      customer_id: customer,
    }),
  );
  await processDocument(db, actor, workspace, uploaded.id, {
    parser: async () => ({
      format: 'pdf',
      mime: 'application/pdf',
      size: 50,
      sections: [{ label: '第1页', text: quote }],
      warnings: [],
    }),
  });
  const doc = await inScope((ctx) => documentDetail(ctx, uploaded.id));
  expect(doc.status).toBe('ready');
  const { config } = options(doc);
  config.loadDocument = documentDetail;
  expect((await organize(doc, [f], config, editor)).results[0].status).toBe('filled');
  const stored = (await rawValues(f.id))[0];
  const safe = await inScope((ctx) =>
    sanitizeAttributeSources(ctx, customer, stored.sources as AttributeSource[]),
  );
  expect(safe.invalid).toBe(false);
  expect(safe.sources[0].quote).toBe(quote);
});

it('preserves every nonempty manual or old AI value including zero, false and multiselect', async () => {
  const definitions = await Promise.all([
    field(),
    field({ kind: 'number' }),
    field(),
    field({ kind: 'multi_select', options: ['芭蕾', '现代舞'] }),
  ]);
  const existing: unknown[] = ['人工资料', 0, false, ['芭蕾']];
  for (const [index, f] of definitions.entries())
    await mutate(
      'INSERT INTO customer_attribute_values(workspace_id,customer_id,attribute_id,id,value,origin) VALUES($1,$2,$3,$4,$5,$6)',
      [
        workspace,
        customer,
        f.id,
        randomUUID(),
        JSON.stringify(existing[index]),
        index % 2 ? 'ai' : 'manual',
      ],
    );
  const doc = await document(),
    { config, seen } = options(doc);
  const result = await organize(doc, definitions, config);
  expect(result.results.map((r) => r.status)).toEqual([
    'preserved',
    'preserved',
    'preserved',
    'preserved',
  ]);
  expect(result.results.map((r) => r.value)).toEqual(existing);
  expect(seen).toHaveLength(0);
  for (const [index, f] of definitions.entries())
    expect((await rawValues(f.id))[0].value).toEqual(existing[index]);
});

it('returns missing without writing a null value when the document has no related evidence', async () => {
  const f = await field(),
    doc = await document();
  const { config, seen } = options(doc, async () => ({
    value: JSON.stringify({ ...goodSelection, related: false, sections: [] }),
    explanation: '无相关信息',
    source_ids: [],
    evidence: [],
    missing: ['没有直接支持当前字段的原文'],
  }));
  const result = await organize(doc, [f], config);
  expect(result.results[0].status).toBe('missing');
  expect(await rawValues(f.id)).toHaveLength(0);
  expect(seen).toHaveLength(1);
});

it('rejects null judgments explicitly and leaves an otherwise successful batch unapplied', async () => {
  const first = await field(),
    second = await field(),
    doc = await document();
  const { config } = options(doc, async (input, index) => {
    if (index === 3) return envelope(input, null);
    return envelope(
      input,
      stage(input) === 'select'
        ? JSON.stringify(goodSelection)
        : stage(input) === 'verify'
          ? JSON.stringify(goodVerification)
          : '芭蕾教学',
    );
  });
  await expect(organize(doc, [first, second], config)).rejects.toMatchObject({ status: 502 });
  expect(await rawValues(first.id)).toHaveLength(0);
  expect(await rawValues(second.id)).toHaveLength(0);
  const verifyNull = options(doc, async (input) =>
    envelope(
      input,
      stage(input) === 'select'
        ? JSON.stringify(goodSelection)
        : stage(input) === 'verify'
          ? null
          : '芭蕾教学',
    ),
  );
  await expect(organize(doc, [first], verifyNull.config)).rejects.toMatchObject({ status: 502 });
  expect(await rawValues(first.id)).toHaveLength(0);
});

it('uses a dedicated judgment system while leaving the ordinary attribute system unchanged', async () => {
  const bodies: { messages: { content: string }[] }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                value: null,
                explanation: 'Synthetic transport fixture',
                source_ids: [],
                evidence: [],
                missing: [],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const basic: AttributeModelInput = {
    field: { name: '主营业务', kind: 'text', description: '', options: [] },
    guidance: '仅按直接原文',
    sources: [],
    warnings: [],
  };
  await callMiniMax(basic, 'synthetic-not-a-real-key', 'cn', fakeFetch);
  await callMiniMax(
    { ...basic, document_judgment: 'select' },
    'synthetic-not-a-real-key',
    'cn',
    fakeFetch,
  );
  await callMiniMax(
    { ...basic, document_judgment: 'verify' },
    'synthetic-not-a-real-key',
    'cn',
    fakeFetch,
  );
  expect(bodies[0].messages[0].content).toContain('你是 CRM 属性分析器');
  expect(bodies[0].messages[0].content).not.toContain('文档字段证据审核器');
  expect(bodies[1].messages[0].content).toContain('文档字段证据审核器');
  expect(bodies[1].messages[0].content).toContain('不能为null');
  expect(bodies[1].messages[0].content).toContain('select阶段完整外层格式示例');
  expect(bodies[1].messages[0].content).toContain('verify阶段完整外层格式示例');
  expect(bodies[1].messages[0].content).toContain('每条evidence也必须include source_id');
  expect(bodies[1].messages[0].content).toContain('绝不能代替source_id');
  expect(bodies[2].messages[0].content).toBe(bodies[1].messages[0].content);
});

it('blocks exact native, identity and transaction aliases on the server without banning customer requirements', async () => {
  for (const name of ['邮箱', 'EMAIL_ADDRESS', 'customer-id', '项目阶段', '确认单价', '邮件数量'])
    expect(isDocumentAttributeFieldAllowed(name)).toBe(false);
  for (const name of ['主营业务', '客户期望交期', '客户提出数量', '客户自述产能'])
    expect(isDocumentAttributeFieldAllowed(name)).toBe(true);
  const f = await field({ name: '邮箱' }),
    doc = await document(),
    { config, seen } = options(doc);
  const listed = await inScope((ctx) => listDocumentAttributeFields(ctx, doc.id, config));
  expect(listed.fields.some((item) => item.id === f.id)).toBe(false);
  await expect(organize(doc, [f], config)).rejects.toMatchObject({ status: 400 });
  expect(seen).toHaveLength(0);
  expect(await rawValues(f.id)).toHaveLength(0);
});

it('uses the narrow definer lock for editors whose ordinary RLS lock queries cannot see rows', async () => {
  const f = await field();
  const counts = await inScope(async (ctx) => {
    const read = await ctx.tx.query(
      'SELECT id FROM customer_attributes WHERE workspace_id=$1 AND id=$2',
      [workspace, f.id],
    );
    const invisibleLock = await ctx.tx.query(
      'SELECT id FROM customer_attributes WHERE workspace_id=$1 AND id=$2 FOR SHARE',
      [workspace, f.id],
    );
    const hiddenAccess = await ctx.tx.query(
      'SELECT actor_id FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3 FOR SHARE',
      [workspace, customer, editor],
    );
    await ctx.tx.query('SELECT crm_lock_document_attribute_scope($1,$2,$3::uuid[])', [
      workspace,
      customer,
      [f.id],
    ]);
    return {
      read: read.rows.length,
      lock: invisibleLock.rows.length,
      access: hiddenAccess.rows.length,
    };
  }, editor);
  expect(counts).toEqual({ read: 1, lock: 0, access: 0 });
  const stored = (
    await db.query<{ prosecdef: boolean; definition: string }>(
      "SELECT p.prosecdef,pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.oid='crm_lock_document_attribute_scope(uuid,uuid,uuid[])'::regprocedure",
    )
  ).rows[0];
  expect(stored.prosecdef).toBe(true);
  expect(stored.definition).toContain('FOR SHARE');
  await expect(
    inScope(
      (ctx) =>
        ctx.tx.query('SELECT crm_lock_document_attribute_scope($1,$2,$3::uuid[])', [
          workspace,
          otherCustomer,
          [f.id],
        ]),
      editor,
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('locks the selected same-company project under editor RLS before applying document fields', async () => {
  const f = await field(),
    doc = await document(undefined, project),
    { config } = options(doc);
  const lock = await inScope(
    (ctx) =>
      ctx.tx.query<{ id: string }>(
        'SELECT id FROM projects WHERE workspace_id=$1 AND customer_id=$2 AND id=$3 FOR SHARE',
        [workspace, customer, project],
      ),
    editor,
  );
  expect(lock.rows).toEqual([{ id: project }]);
  expect((await organize(doc, [f], config, editor)).results[0].status).toBe('filled');
});

it('does not accept a real but unrelated quotation as proof of the field value', async () => {
  const f = await field(),
    doc = await document();
  const { config } = options(doc, async (input) => {
    if (stage(input) === 'select')
      return envelope(
        input,
        JSON.stringify({ ...goodSelection, sections: [{ index: 1, quote: unrelated }] }),
        unrelated,
      );
    if (stage(input) === 'generate') return envelope(input, '冷链运输', unrelated);
    return envelope(
      input,
      JSON.stringify({
        ...goodVerification,
        related: false,
        subject_matches: false,
        directly_supported: false,
      }),
      unrelated,
    );
  });
  expect((await organize(doc, [f], config)).results[0].status).toBe('missing');
  expect(await rawValues(f.id)).toHaveLength(0);
});

it('stops on a conflict, and checks time, negation, subject and protected-field semantics independently', async () => {
  const f = await field(),
    doc = await document();
  for (const key of [
    'conflict',
    'temporal_fit',
    'negation_preserved',
    'subject_matches',
    'field_allowed',
  ] as const) {
    const { config } = options(doc, async (input) => {
      if (stage(input) === 'select') return envelope(input, JSON.stringify(goodSelection));
      if (stage(input) === 'generate') return envelope(input, '芭蕾教学');
      return envelope(input, JSON.stringify({ ...goodVerification, [key]: key === 'conflict' }));
    });
    expect((await organize(doc, [f], config)).results[0].status).toBe(
      key === 'conflict' ? 'conflict' : 'missing',
    );
    expect(await rawValues(f.id)).toHaveLength(0);
  }
});

it('keeps relevant facts from an appendix instead of excluding the whole section category', async () => {
  const text = '附录：星澜舞蹈学校主营芭蕾教学，成立于2012年。';
  const f = await field(),
    doc = await document([{ label: '附录A · 第8段', text }]);
  const { config } = options(doc, async (input) => {
    const value =
      stage(input) === 'select'
        ? JSON.stringify({ ...goodSelection, sections: [{ index: 0, quote: text }] })
        : stage(input) === 'verify'
          ? JSON.stringify(goodVerification)
          : '芭蕾教学';
    return envelope(input, value, text);
  });
  expect((await organize(doc, [f], config)).results[0]).toMatchObject({
    status: 'filled',
    evidence: [{ label: '附录A · 第8段', quote: text }],
  });
});

it('rejects client field IDs from another workspace, disabled fields, duplicate IDs and extra input', async () => {
  const f = await field({ ai_enabled: false }),
    doc = await document(),
    { config, seen } = options(doc);
  await expect(organize(doc, [f], config)).rejects.toMatchObject({ status: 400 });
  await expect(
    organizeDocumentAttributes(
      db,
      actor,
      workspace,
      doc.id,
      { attribute_ids: [randomUUID()] },
      config,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    organizeDocumentAttributes(
      db,
      actor,
      workspace,
      doc.id,
      { attribute_ids: [f.id, f.id] },
      config,
    ),
  ).rejects.toThrow();
  await expect(
    organizeDocumentAttributes(
      db,
      actor,
      workspace,
      doc.id,
      { attribute_ids: [f.id], customer_id: otherCustomer },
      config,
    ),
  ).rejects.toThrow();
  const other = await createWorkspace(db, {
    name: 'Other workspace document field',
    email: 'other-doc-field@example.invalid',
    password: 'other-document-field-password',
    displayName: 'Other admin',
  });
  const foreign = await scoped(db, other.actorId, other.workspaceId, (ctx) =>
    attributes.createField(ctx, {
      name: '不在授权工作空间的字段',
      kind: 'text',
      ai_enabled: true,
      guidance: '读取其他公司字段',
    }),
  );
  await expect(organize(doc, [foreign], config)).rejects.toMatchObject({ status: 400 });
  expect(seen).toHaveLength(0);
});

it('rejects readonly actors, pending ownership and project or Record mismatches before any model call', async () => {
  const f = await field(),
    doc = await document(),
    { config, seen } = options(doc);
  await expect(organize(doc, [f], config, viewer)).rejects.toMatchObject({ status: 403 });
  const pending = {
    ...doc,
    customer_id: null,
    record_id: null,
    status: 'pending_association' as const,
  };
  await expect(organize(pending, [f], options(pending).config)).rejects.toMatchObject({
    status: 409,
  });
  const wrongProject = { ...doc, project_id: otherProject };
  await expect(organize(wrongProject, [f], options(wrongProject).config)).rejects.toMatchObject({
    status: 404,
  });
  const wrongRecord = { ...doc, record_id: randomUUID() };
  await expect(organize(wrongRecord, [f], options(wrongRecord).config)).rejects.toMatchObject({
    status: 409,
  });
  expect(seen).toHaveLength(0);
});

it('stops subsequent calls and writes when access is revoked during generation', async () => {
  await mutate(
    "UPDATE customer_access SET access='editor' WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3",
    [workspace, customer, editor],
  );
  const f = await field(),
    doc = await document();
  const { config, seen } = options(doc, async (input) => {
    await mutate(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, customer, editor],
    );
    return envelope(input, JSON.stringify(goodSelection));
  });
  await expect(organize(doc, [f], config, editor)).rejects.toMatchObject({ status: 409 });
  expect(seen).toHaveLength(1);
  expect(await rawValues(f.id)).toHaveLength(0);
  await mutate(
    "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
    [workspace, customer, editor],
  );
});

it('returns a scope-change error if access is revoked after the final judgment but before application', async () => {
  const f = await field(),
    doc = await document();
  const { config } = options(doc, async (input) => {
    if (stage(input) === 'select') return envelope(input, JSON.stringify(goodSelection));
    if (stage(input) === 'generate') return envelope(input, '芭蕾教学');
    await mutate(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, customer, editor],
    );
    return envelope(input, JSON.stringify(goodVerification));
  });
  await expect(organize(doc, [f], config, editor)).rejects.toMatchObject({ status: 409 });
  expect(await rawValues(f.id)).toHaveLength(0);
  await mutate(
    "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
    [workspace, customer, editor],
  );
});

it('preserves a concurrent manual edit and prevents applying stale model results', async () => {
  const f = await field(),
    doc = await document();
  const { config, seen } = options(doc, async (input) => {
    if (stage(input) === 'select') return envelope(input, JSON.stringify(goodSelection));
    await inScope((ctx) =>
      attributes.saveValue(ctx, customer, f.id, {
        value: '人工并发填写',
        version: 0,
        attribute_version: f.version,
      }),
    );
    return envelope(input, '芭蕾教学');
  });
  await expect(organize(doc, [f], config)).rejects.toMatchObject({ status: 409 });
  expect(seen).toHaveLength(2);
  expect((await rawValues(f.id))[0]).toMatchObject({ value: '人工并发填写', origin: 'manual' });
});

it('aborts if the field definition or document version changes during semantic checks', async () => {
  const f = await field(),
    doc = await document();
  const { config } = options(doc, async (input) => {
    const { id: _id, ...definition } = f;
    await inScope((ctx) =>
      attributes.updateField(ctx, f.id, { ...definition, guidance: '变更后的字段口径' }),
    );
    return envelope(input, JSON.stringify(goodSelection));
  });
  await expect(organize(doc, [f], config)).rejects.toMatchObject({ status: 409 });
  expect(await rawValues(f.id)).toHaveLength(0);
  const newer = await field();
  const changed = options(doc, async (input) => {
    doc.version++;
    return envelope(input, JSON.stringify(goodSelection));
  });
  await expect(organize(doc, [newer], changed.config)).rejects.toMatchObject({ status: 409 });
  expect(await rawValues(newer.id)).toHaveLength(0);
});

it('requires actual boolean semantic decisions, an existing excerpt, and direct candidate quotations', async () => {
  const f = await field(),
    doc = await document();
  for (const selection of [
    { ...goodSelection, related: 'true' },
    { ...goodSelection, sections: [{ index: 0, quote: '原文里根本不存在的摘录' }] },
  ]) {
    const { config } = options(doc, async (input) => envelope(input, JSON.stringify(selection)));
    await expect(organize(doc, [f], config)).rejects.toMatchObject({ status: 502 });
  }
  const badQuote = options(doc, async (input) => {
    if (stage(input) === 'select') return envelope(input, JSON.stringify(goodSelection));
    return envelope(input, '芭蕾教学', unrelated);
  });
  await expect(organize(doc, [f], badQuote.config)).rejects.toMatchObject({ status: 502 });
  expect(await rawValues(f.id)).toHaveLength(0);
});

it('repairs an incorrect section ordinal only when its exact quotation has one authorized match', async () => {
  const f = await field(),
    doc = await document();
  const { config, seen } = options(doc, async (input) => {
    const value =
      stage(input) === 'select'
        ? JSON.stringify({ ...goodSelection, sections: [{ index: 1, quote }] })
        : stage(input) === 'verify'
          ? JSON.stringify(goodVerification)
          : '芭蕾教学';
    return envelope(input, value);
  });
  expect((await organize(doc, [f], config)).results[0]).toMatchObject({
    status: 'filled',
    evidence: [{ label: '第1页', quote }],
  });
  const selectedChunks = JSON.parse(seen[1].sources[0].body).original_chunks.evidence;
  expect(selectedChunks).toEqual([{ index: 0, label: '第1页', body: quote }]);
});

it('rejects unmatched or ambiguous quotations when the claimed section does not contain them', async () => {
  const f = await field(),
    doc = await document();
  const missing = options(doc, async (input) =>
    envelope(
      input,
      JSON.stringify({
        ...goodSelection,
        sections: [{ index: 1, quote: '任何段落都没有的内容' }],
      }),
    ),
  );
  await expect(organize(doc, [f], missing.config)).rejects.toMatchObject({ status: 502 });
  const repeated = await document([
    { label: '第1页', text: quote },
    { label: '第2页', text: unrelated },
    { label: '第3页', text: quote },
  ]);
  const ambiguous = options(repeated, async (input) =>
    envelope(
      input,
      JSON.stringify({
        ...goodSelection,
        sections: [{ index: 1, quote }],
      }),
    ),
  );
  await expect(organize(repeated, [f], ambiguous.config)).rejects.toMatchObject({ status: 502 });
  expect(await rawValues(f.id)).toHaveLength(0);
  // A claimed index that actually contains the quote remains authoritative;
  // uniqueness is required for correction, not for a correctly located quote.
  expect((await organize(repeated, [f], options(repeated).config)).results[0]).toMatchObject({
    status: 'filled',
    evidence: [{ label: '第1页', quote }],
  });
});

it('accepts optional judgment evidence indexes without trusting them as source locators', async () => {
  const f = await field(),
    doc = await document();
  for (const extra of [
    { index: -1 },
    { index: 3, source_id: `record:${randomUUID()}` },
    { index: 3, quote: '根本不存在的原始引文' },
    { index: 3, unexpected: '仍不接受未知字段' },
  ]) {
    const { config } = options(doc, async (input) => ({
      ...envelope(input, JSON.stringify(goodSelection)),
      evidence: [{ source_id: sourceId(input), quote, ...extra }],
    }));
    await expect(organize(doc, [f], config)).rejects.toMatchObject({ status: 502 });
    expect(await rawValues(f.id)).toHaveLength(0);
  }
  const { config } = options(doc, async (input) => {
    if (stage(input) === 'generate') return envelope(input, '芭蕾教学');
    const value = stage(input) === 'select' ? goodSelection : goodVerification;
    return {
      ...envelope(input, JSON.stringify(value)),
      // This optional metadata deliberately differs from the canonical
      // selection index; it must not change the server-computed locator.
      evidence: [{ source_id: sourceId(input), quote, index: 3 }],
    };
  });
  expect((await organize(doc, [f], config)).results[0]).toMatchObject({
    status: 'filled',
    value: '芭蕾教学',
    evidence: [{ label: '第1页', quote }],
  });
});

it('reports model failures explicitly and rolls back the batch instead of partially filling fields', async () => {
  const first = await field(),
    second = await field(),
    doc = await document();
  const { config } = options(doc, async (input, index) => {
    if (index >= 3) throw new Error('mocked provider failure');
    return envelope(
      input,
      stage(input) === 'select'
        ? JSON.stringify(goodSelection)
        : stage(input) === 'verify'
          ? JSON.stringify(goodVerification)
          : '芭蕾教学',
    );
  });
  await expect(organize(doc, [first, second], config)).rejects.toMatchObject({ status: 502 });
  expect(await rawValues(first.id)).toHaveLength(0);
  expect(await rawValues(second.id)).toHaveLength(0);
});

it('does not silently truncate oversized document scans or silently accept changed source text', async () => {
  const f = await field(),
    doc = await document();
  const oversized = {
    ...doc,
    sections: Array.from({ length: documentAttributeLimits.sections + 1 }, (_, index) => ({
      label: `第${index}段`,
      text: quote,
    })),
  };
  const { config, seen } = options(oversized);
  await expect(organize(oversized, [f], config)).rejects.toMatchObject({ status: 409 });
  expect(seen).toHaveLength(0);
  const changed = { ...doc, sections: [{ label: '第1页', text: '非原始Record的篡改文字' }] };
  await expect(organize(changed, [f], options(changed).config)).rejects.toMatchObject({
    status: 409,
  });
});

it('keeps legitimate number zero and selected options without inventing extra options', async () => {
  const f = await field({ kind: 'number', guidance: '仅填写明确写明的分公司数量，0也是有效值' });
  const text = '星澜舞蹈学校当前分公司数量为0家。',
    doc = await document([{ label: '第3页', text }], project);
  const { config } = options(doc, async (input) =>
    envelope(
      input,
      stage(input) === 'select'
        ? JSON.stringify({ ...goodSelection, sections: [{ index: 0, quote: text }] })
        : stage(input) === 'verify'
          ? JSON.stringify(goodVerification)
          : 0,
      text,
    ),
  );
  expect((await organize(doc, [f], config)).results[0]).toMatchObject({
    status: 'filled',
    value: 0,
  });
  expect((await rawValues(f.id))[0].value).toBe(0);
  const selectionField = await field({ kind: 'select', options: ['芭蕾', '现代舞'] });
  const opts = options(await document(), async (input) =>
    envelope(input, stage(input) === 'select' ? JSON.stringify(goodSelection) : '未知新选项'),
  );
  const newDoc = await document();
  opts.config.loadDocument = async () => newDoc;
  await expect(organize(newDoc, [selectionField], opts.config)).rejects.toMatchObject({
    status: 502,
  });
  expect(await rawValues(selectionField.id)).toHaveLength(0);
});
