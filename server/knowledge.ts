import { createHash, randomUUID } from 'node:crypto';
import { documentKnowledgeSources } from './document-sources.js';
import { currentNoteKnowledgeSources } from './note-sources.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Database } from './db.js';
import { ApiError, scoped, type Context } from './security.js';
import { customer, activeCustomer, project } from './service.js';
import { person } from './people.js';
import { entitySchema } from './entity-schema.js';
import {
  extractionRevision,
  validateExtractions,
  type RecordExtraction,
  type ExtractionRecord,
} from './communication-pipeline.js';
import { extractionAgentSource } from './communication-extraction.js';
import {
  activityAgentSources,
  activityRecordAttributions,
  mergeActivityContext,
} from './activity-context.js';
import type { AgentSource } from '../shared/agent.js';
import type { KnowledgeSelection } from '../shared/knowledge-search.js';
import type {
  KnowledgeFact,
  KnowledgeSnapshot,
  KnowledgeSource,
  KnowledgeView,
  KnowledgeGraph,
  KnowledgeGraphView,
} from '../shared/knowledge.js';

export interface KnowledgeTransport {
  sync(
    snapshot: KnowledgeSnapshot,
    generation: string,
    previous: string | null,
    cached?: RecordExtraction[],
  ): Promise<unknown>;
  discard(workspace: string, customer: string, generation: string): Promise<void>;
}
type State = {
  workspace_id: string;
  customer_id: string;
  actor_id: string;
  requested_version: number;
  applied_version: number;
  state: 'pending' | 'syncing' | 'ready' | 'failed';
  digest: string | null;
  generation: string | null;
  schema_revision: string | null;
  facts: KnowledgeFact[];
  graph: KnowledgeGraph | null;
  extractions: RecordExtraction[];
  synced_at: string | null;
  error: string | null;
};
const digestOf = (snapshot: KnowledgeSnapshot) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        ...snapshot,
        actor_id: undefined,
        extraction_revision: extractionRevision,
        graph_revision: 4,
      }),
    )
    .digest('hex');
// Search publications use the exact same digest as generation publication. The
// caller must obtain the snapshot under the current server-verified RLS scope.
export const knowledgeSourceDigest = digestOf;
const iso = (value: unknown) => new Date(String(value)).toISOString();

export async function knowledgeSnapshot(
  ctx: Context,
  customerId: string,
  includeArchived = false,
): Promise<KnowledgeSnapshot> {
  const c = await customer(ctx, customerId);
  if (!includeArchived) activeCustomer(c);
  const schema = await entitySchema(ctx);
  const storedCustomer = (
    await ctx.tx.query<Record<string, unknown>>(
      'SELECT * FROM customers WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, customerId],
    )
  ).rows[0];
  const entities: KnowledgeSnapshot['entities'] = [
    { id: c.id, object: 'customers', name: c.name, attributes: storedCustomer },
  ];
  for (const object of ['people', 'projects'] as const) {
    const rows = (
      await ctx.tx.query<{ id: string; name: string } & Record<string, unknown>>(
        `SELECT * FROM ${object} WHERE workspace_id=$1 AND customer_id=$2 AND ($3::boolean OR archived_at IS NULL) ORDER BY id`,
        [ctx.workspaceId, customerId, includeArchived],
      )
    ).rows;
    entities.push(...rows.map((r) => ({ id: r.id, object, name: r.name, attributes: r })));
  }
  const values = (
    await ctx.tx.query<{ attribute_id: string; value: unknown; origin: string }>(
      `SELECT v.attribute_id,v.value,v.origin FROM customer_attribute_values v JOIN customer_attributes a ON a.workspace_id=v.workspace_id AND a.id=v.attribute_id
    WHERE v.workspace_id=$1 AND v.customer_id=$2 AND NOT a.archived ORDER BY v.attribute_id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  entities[0].attributes.custom_attributes = values;
  const customRows = (
    await ctx.tx.query<
      { id: string; object_id: string; name: string; project_id: string | null } & Record<
        string,
        unknown
      >
    >(
      'SELECT * FROM custom_object_records WHERE workspace_id=$1 AND customer_id=$2 AND ($3::boolean OR archived_at IS NULL) ORDER BY object_id,id',
      [ctx.workspaceId, customerId, includeArchived],
    )
  ).rows;
  for (const row of customRows) {
    const definition = schema.objects?.find((o) => o.id === row.object_id);
    if (!definition) continue;
    const activeFields = new Set(definition.attributes.map((a) => a.id));
    const rawValues = row.values as Record<string, unknown>;
    const { field_provenance, ...rowAttributes } = row;
    const provenance =
      field_provenance && typeof field_provenance === 'object'
        ? Object.fromEntries(
            Object.entries(field_provenance).map(([id, value]) => {
              const item = value as { origin?: string; state?: string; sources?: { id: string }[] };
              return [
                id,
                {
                  origin: item.origin,
                  state: item.state,
                  source_record_ids: (item.sources || [])
                    .filter((source) => source.id.startsWith('record:'))
                    .map((source) => source.id.slice(7)),
                },
              ];
            }),
          )
        : {};
    entities.push({
      id: row.id,
      object: row.object_id,
      name: row.name,
      attributes: {
        ...rowAttributes,
        field_provenance: provenance,
        values: Object.fromEntries(
          Object.entries(rawValues).filter(([id]) => activeFields.has(id)),
        ),
      },
    });
  }
  const ids = new Set(entities.map((e) => e.id));
  const relationships = (
    await ctx.tx.query<KnowledgeSnapshot['relationships'][number]>(
      'SELECT id,definition_id,source_id,target_id FROM relationship_edges WHERE workspace_id=$1 AND customer_id=$2 ORDER BY id',
      [ctx.workspaceId, customerId],
    )
  ).rows.filter((e) => ids.has(e.source_id) && ids.has(e.target_id));
  relationships.push(
    ...entities
      .filter((e) => e.object === 'people' || e.object === 'projects')
      .map((e) => ({
        id: `system:${e.id}`,
        definition_id: e.object === 'people' ? 'system-company-people' : 'system-company-projects',
        source_id: customerId,
        target_id: e.id,
      })),
  );
  for (const row of customRows) {
    if (!ids.has(row.id)) continue;
    relationships.push({
      id: `system:custom-company:${row.object_id}:${row.id}`,
      definition_id: `custom-company:${row.object_id}`,
      source_id: row.id,
      target_id: customerId,
    });
    if (row.project_id && ids.has(row.project_id))
      relationships.push({
        id: `system:custom-project:${row.object_id}:${row.id}`,
        definition_id: `custom-project:${row.object_id}`,
        source_id: row.id,
        target_id: row.project_id,
      });
  }
  const sources: KnowledgeSource[] = [];
  const validProject = (id: string | null) => !id || ids.has(id);
  const mails = (
    await ctx.tx.query<{
      id: string;
      record_id: string;
      project_id: string | null;
      subject: string;
      body: string;
      occurred_at: string;
      direction: string;
      sender: unknown;
      person_ids: string[];
    }>(
      `SELECT m.id,r.id AS record_id,m.project_id,m.subject,m.body,m.occurred_at,m.direction,m.sender,
    coalesce((SELECT jsonb_agg(p.person_id ORDER BY p.person_id) FROM mail_people p WHERE p.workspace_id=m.workspace_id AND p.message_id=m.id),'[]') AS person_ids
    FROM mail_messages m JOIN customer_records r ON r.workspace_id=m.workspace_id AND r.source_mail_id=m.id
    WHERE m.workspace_id=$1 AND m.customer_id=$2 ORDER BY m.occurred_at,m.id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  for (const m of mails)
    if (validProject(m.project_id) && m.body.trim())
      sources.push({
        id: `record:${m.record_id}`,
        record_id: m.record_id,
        channel: 'email',
        trust: 'customer_quote',
        project_id: m.project_id,
        person_ids: m.person_ids.filter((id) => ids.has(id)),
        occurred_at: iso(m.occurred_at),
        title: m.subject || '邮件',
        speaker: Array.isArray(m.sender)
          ? m.sender
              .map((s: { name?: string; address?: string }) => s.name || s.address || '未明确')
              .join('、') || '发件人待核对'
          : '发件人待核对',
        body: m.body,
        speaker_side: m.direction === 'outbound' ? 'internal' : 'external',
        message_id: m.id,
        ref: {
          kind: 'mail',
          id: m.id,
          customer_id: customerId,
          ...(m.project_id ? { project_id: m.project_id } : {}),
          title: m.subject || '邮件',
          description: '沟通原文；发送不等于公司正式确认',
        },
      });
  const evidence = (
    await ctx.tx.query<{
      id: string;
      record_id: string;
      project_id: string | null;
      person_id: string | null;
      occurred_at: string;
      speaker: string;
      body: string;
      message_id: string | null;
      from_me: boolean | null;
    }>(
      'SELECT id,record_id,project_id,person_id,occurred_at,speaker,body,message_id,from_me FROM knowledge_wechat_evidence WHERE workspace_id=$1 AND customer_id=$2 ORDER BY occurred_at,id',
      [ctx.workspaceId, customerId],
    )
  ).rows;
  for (const e of evidence)
    if (validProject(e.project_id) && (!e.person_id || ids.has(e.person_id)))
      sources.push({
        id: `record:${e.record_id}:part:${e.id}`,
        record_id: e.record_id,
        channel: 'wechat',
        trust: 'customer_quote',
        project_id: e.project_id,
        person_ids: e.person_id ? [e.person_id] : [],
        occurred_at: iso(e.occurred_at),
        title: '已关联的微信原文',
        speaker: e.speaker || '说话人待核对',
        body: e.body,
        speaker_side: e.from_me === null ? 'unknown' : e.from_me ? 'internal' : 'external',
        ...(e.message_id ? { message_id: e.message_id } : {}),
        ref: {
          kind: 'record',
          id: e.record_id,
          customer_id: customerId,
          ...(e.project_id ? { project_id: e.project_id } : {}),
          title: '微信关联记录',
          description: '自动归档的微信文字，保留原消息说话人与来源',
        },
      });
  const records = (
    await ctx.tx.query<{
      id: string;
      project_id: string | null;
      kind: KnowledgeSource['trust'];
      body: string;
      created_at: string;
      occurred_at: string;
    }>(
      `SELECT r.id,r.project_id,r.kind,r.body,r.created_at,r.occurred_at FROM customer_records r WHERE r.workspace_id=$1 AND r.customer_id=$2 AND r.source_kind='manual'
    AND NOT EXISTS(SELECT 1 FROM knowledge_wechat_evidence e WHERE e.workspace_id=r.workspace_id AND e.record_id=r.id)
    ORDER BY r.created_at,r.id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  const activityAuthors = await activityRecordAttributions(ctx, customerId);
  for (const r of records)
    if (validProject(r.project_id))
      sources.push({
        id: `record:${r.id}`,
        record_id: r.id,
        channel: 'record',
        trust: r.kind,
        project_id: r.project_id,
        person_ids: (activityAuthors.get(r.id)?.person_ids || []).filter((id) => ids.has(id)),
        occurred_at: iso(r.occurred_at),
        title: '业务记录',
        speaker: activityAuthors.has(r.id)
          ? `${activityAuthors.get(r.id)!.actor_name}（本人内部陈述）`
          : '业务记录，提出者以原文为准',
        ...(activityAuthors.has(r.id) ? { speaker_side: 'internal' as const } : {}),
        body: r.body,
        ref: {
          kind: 'record',
          id: r.id,
          customer_id: customerId,
          ...(r.project_id ? { project_id: r.project_id } : {}),
          title: '业务记录',
          description: r.kind,
        },
      });
  sources.push(...(await documentKnowledgeSources(ctx, customerId)));
  sources.push(...(await currentNoteKnowledgeSources(ctx, customerId)));
  sources.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
  return JSON.parse(
    JSON.stringify({
      workspace_id: ctx.workspaceId,
      customer_id: customerId,
      actor_id: ctx.actorId,
      schema,
      entities,
      relationships,
      sources,
    }),
  );
}

export async function ensureCommunicationRecords(ctx: Context, customerId: string) {
  await customer(ctx, customerId, true);
  // Backfill pre-feature emails under the requesting actor's existing RLS scope.
  await ctx.tx.query(
    `INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,source_mail_id,occurred_at)
    SELECT m.workspace_id,m.customer_id,m.project_id,gen_random_uuid(),'customer_quote',
    '邮件来源记录：'||left(m.subject,500)||E'\\n完整原文保存在关联邮件中；沟通内容不代表公司正式确认。',$3,'email',m.id,m.occurred_at
    FROM mail_messages m WHERE m.workspace_id=$1 AND m.customer_id=$2
    AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.workspace_id=m.workspace_id AND r.source_mail_id=m.id)
    ON CONFLICT(workspace_id,source_mail_id) DO NOTHING`,
    [ctx.workspaceId, customerId, ctx.actorId],
  );
}

export async function enqueueKnowledge(ctx: Context, customerId: string) {
  activeCustomer(await customer(ctx, customerId));
  if (
    !(
      await ctx.tx.query<{ ok: boolean }>('SELECT crm_access($1,$2,true) AS ok', [
        ctx.workspaceId,
        customerId,
      ])
    ).rows[0].ok
  )
    throw new ApiError(403, '需要客户编辑权限');
  await ensureCommunicationRecords(ctx, customerId);
  await ctx.tx.query(
    `INSERT INTO knowledge_sync(workspace_id,customer_id,actor_id) VALUES($1,$2,$3)
    ON CONFLICT(workspace_id,customer_id) DO UPDATE SET actor_id=$3,requested_version=knowledge_sync.requested_version+1,
    state='pending',attempts=0,error=NULL,retry_at=NULL,updated_at=now()`,
    [ctx.workspaceId, customerId, ctx.actorId],
  );
  return { queued: true };
}

export async function knowledgeView(
  ctx: Context,
  customerId: string,
  filter: { project_id?: string; person_id?: string } = {},
  enabled = true,
): Promise<KnowledgeView> {
  const c = await customer(ctx, customerId);
  if (filter.project_id) {
    const p = await project(ctx, customerId, filter.project_id);
    if (p.archived_at) throw new ApiError(409, '项目已归档');
  }
  if (filter.person_id) {
    const p = await person(ctx, filter.person_id, customerId);
    if (p.archived_at) throw new ApiError(409, '联系人已归档');
  }
  const schema = await entitySchema(ctx);
  const row = (
    await ctx.tx.query<State>(
      'SELECT * FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
      [ctx.workspaceId, customerId],
    )
  ).rows[0];
  const can_sync = (
    await ctx.tx.query<{ ok: boolean }>('SELECT crm_access($1,$2,true) AS ok', [
      ctx.workspaceId,
      customerId,
    ])
  ).rows[0].ok;
  const base: KnowledgeView = {
    state: enabled ? row?.state || 'not_synced' : 'disabled',
    schema_revision: schema.revision,
    synced_at: row?.synced_at || null,
    error: row?.error || null,
    can_sync: can_sync && enabled && !c.archived_at,
    facts: [],
  };
  if (c.archived_at) return { ...base, state: 'not_synced' };
  if (!row || !row.digest) return base;
  if (
    Number(row.applied_version) !== Number(row.requested_version) ||
    row.schema_revision !== schema.revision
  ) {
    if (base.state === 'ready') base.state = 'pending';
    return base;
  }
  const snapshot = await knowledgeSnapshot(ctx, customerId);
  if (digestOf(snapshot) !== row.digest) {
    base.state = 'pending';
    return base;
  }
  if (row.state !== 'ready') return base;
  const map = new Map(snapshot.sources.map((s) => [s.id, s]));
  base.facts = row.facts.flatMap((f) => {
    const sources = f.source_ids.map((id) => map.get(id));
    if (
      !sources.length ||
      sources.some(
        (s) =>
          !s ||
          (filter.project_id && s.project_id !== filter.project_id) ||
          (filter.person_id && !s.person_ids.includes(filter.person_id)),
      )
    )
      return [];
    return [
      {
        ...f,
        sources: sources.map((s) => ({
          id: s!.id,
          record_id: s!.record_id,
          channel: s!.channel,
          title: s!.title,
          speaker: s!.speaker,
          occurred_at: s!.occurred_at,
          ref: s!.ref,
          excerpt: s!.channel === 'wechat' ? s!.body : '',
        })),
      },
    ];
  });
  return base;
}

export async function knowledgeGraphView(
  ctx: Context,
  customerId: string,
  filter: { project_id?: string } = {},
  enabled = true,
): Promise<KnowledgeGraphView> {
  // The ordinary view revalidates customer/project ownership, current schema,
  // source digest and authorization before any stored graph can be exposed.
  const view = await knowledgeView(ctx, customerId, filter, enabled);
  const empty: KnowledgeGraphView = {
    ...view,
    nodes: [],
    edges: [],
    generation: null,
    provenance: 'unavailable',
    sources: [],
  };
  if (view.state !== 'ready') return empty;
  const stored = (
    await ctx.tx.query<State>(
      'SELECT graph,generation FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
      [ctx.workspaceId, customerId],
    )
  ).rows[0];
  if (!stored?.graph) return empty;
  const snapshot = await knowledgeSnapshot(ctx, customerId);
  const graph = validateGraph(stored.graph, snapshot, view.facts, false);
  // A message without a model claim (e.g. a greeting) is still an authorized
  // source. Fact extraction is not an authorization directory.
  const eligibleSources = snapshot.sources.filter(
    (s) => !filter.project_id || s.project_id === filter.project_id,
  );
  const sourceIds = new Set(eligibleSources.map((s) => s.id));
  // Only explicit project relationships or that project's evidence can make a
  // contact visible in a project graph. Company membership alone is insufficient.
  const crmIds = new Set(
    snapshot.entities
      .filter(
        (e) =>
          !filter.project_id ||
          e.id === customerId ||
          e.id === filter.project_id ||
          e.attributes.project_id === filter.project_id,
      )
      .map((e) => e.id),
  );
  if (filter.project_id) {
    for (const edge of snapshot.relationships) {
      if (edge.source_id === filter.project_id) crmIds.add(edge.target_id);
      if (edge.target_id === filter.project_id) crmIds.add(edge.source_id);
    }
    for (const s of snapshot.sources)
      if (s.project_id === filter.project_id) s.person_ids.forEach((id) => crmIds.add(id));
  }
  const nodes = graph.nodes.filter((n) =>
    n.origin === 'crm'
      ? crmIds.has(n.id)
      : n.source_ids.length > 0 && n.source_ids.every((id) => sourceIds.has(id)),
  );
  const keys = new Set(nodes.map((n) => n.key));
  const edges = graph.edges.filter(
    (e) =>
      keys.has(e.source) &&
      keys.has(e.target) &&
      (e.kind === 'crm_relationship' || e.source_ids.every((id) => sourceIds.has(id))),
  );
  return {
    ...view,
    nodes,
    edges,
    generation: stored.generation,
    provenance: 'graphiti_persisted',
    sources: eligibleSources.map((s) => ({
      id: s.id,
      record_id: s.record_id,
      channel: s.channel,
      title: s.title,
      speaker: s.speaker,
      occurred_at: s.occurred_at,
      ref: s.ref,
      excerpt: s.channel === 'wechat' ? s.body : '',
    })),
  };
}

export async function knowledgeAgentSources(
  ctx: Context,
  customerId: string,
  filter: { project_id?: string; person_id?: string } = {},
  selection?: KnowledgeSelection,
): Promise<AgentSource[]> {
  const view = await knowledgeView(ctx, customerId, filter);
  const snapshot = await knowledgeSnapshot(ctx, customerId);
  const sourceMap = new Map(snapshot.sources.map((s) => [s.id, s]));
  const records = new Map<string, { sources: KnowledgeSource[]; facts: KnowledgeFact[] }>();
  const eligible = snapshot.sources.filter(
    (s) =>
      (!filter.project_id || s.project_id === filter.project_id) &&
      (!filter.person_id || s.person_ids.includes(filter.person_id)),
  );
  const factMap = new Map(view.facts.map((f) => [f.id, f]));
  if (selection?.fact_ids.some((id) => !factMap.has(id)))
    throw new ApiError(409, '检索依据或可见范围已变化，请重新提问');
  const eligibleIds = new Set(eligible.map((s) => s.id));
  if (
    selection?.episode_record_ids?.some((id) => {
      const sources = snapshot.sources.filter((s) => s.record_id === id);
      return !sources.length || sources.some((s) => !eligibleIds.has(s.id));
    })
  )
    throw new ApiError(409, '检索依据或可见范围已变化，请重新提问');
  const selectedFacts = selection
    ? selection.fact_ids.map((id) => factMap.get(id)!)
    : view.facts.slice(0, 60);
  // Insert selected evidence first. The outer snapshot groups correction-chain
  // Records atomically before applying its byte budget. Every Record is still
  // one source even when several graph facts or WeChat fragments refer to it.
  if (selection) {
    const selectedRecords = [
      ...new Set([
        ...selectedFacts.flatMap((f) => f.sources.map((s) => s.record_id)),
        ...(selection.episode_record_ids || []),
      ]),
    ];
    for (const id of selectedRecords)
      records.set(id, { sources: eligible.filter((s) => s.record_id === id), facts: [] });
  }
  const priorityRecords = records.size;
  const recentRecords = [...new Set(eligible.map((s) => s.record_id))].slice(-40).reverse();
  for (const id of recentRecords)
    if (!records.has(id))
      records.set(id, { sources: eligible.filter((s) => s.record_id === id), facts: [] });
  for (const f of selectedFacts)
    for (const s of f.sources) {
      const record = records.get(s.record_id) || { sources: [], facts: [] };
      if (!record.sources.some((v) => v.id === s.id)) record.sources.push(sourceMap.get(s.id)!);
      if (!record.facts.some((v) => v.id === f.id)) record.facts.push(f);
      records.set(s.record_id, record);
    }
  const stored =
    view.state === 'ready'
      ? (
          await ctx.tx.query<State>(
            'SELECT extractions FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
            [ctx.workspaceId, customerId],
          )
        ).rows[0]?.extractions
      : [];
  const extracted = stored?.length ? (await validateExtractions(snapshot, stored)).records : [];
  const bundles: AgentSource[] = [...records].map(([id, record]) => {
    const candidate = extracted.find(
      (r) =>
        r.input.record_id === id &&
        r.source_ids.every((s) => record.sources.some((v) => v.id === s)),
    );
    const base = candidate
      ? JSON.parse(extractionAgentSource(candidate.output, candidate.input).body)
      : {
          evidence: record.sources.map((s) => ({
            speaker: s.speaker,
            occurred_at: s.occurred_at,
            channel: s.channel,
            body: s.body.slice(0, 6000),
          })),
        };
    return {
      id: `record::${id}`,
      title: record.sources[0].title,
      ref: {
        kind: 'record',
        id,
        customer_id: customerId,
        ...(record.sources[0].project_id ? { project_id: record.sources[0].project_id } : {}),
        title: record.sources[0].title,
        description: record.sources[0].note
          ? `内部笔记 v${record.sources[0].note.version}，原文与图谱共用来源`
          : '原始记录、结构化候选及Graphiti来源',
        ...(record.sources[0].note
          ? {
              note_id: record.sources[0].note.id,
              note_revision_id: record.sources[0].note.revision_id,
              note_version: record.sources[0].note.version,
              source_hash: record.sources[0].ref.source_hash,
            }
          : {}),
      },
      body: JSON.stringify({
        ...base,
        derived_facts: record.facts.map((f) => ({
          fact: f.fact,
          relation: f.relation,
          valid_at: f.valid_at,
          invalid_at: f.invalid_at,
          trust: f.trust,
        })),
        notice:
          '原文、结构化候选与图事实来自同一Record，不是多份独立证据。所有引用只使用外层来源id。纠正/修改请求不代表公司确认；消息时间与生效时间分开，按Asia/Shanghai显示。',
        ...(record.sources[0].note ? { note: record.sources[0].note } : {}),
      }),
    };
  });
  if (view.state !== 'ready')
    bundles.unshift({
      id: 'knowledge:status',
      title: '沟通知识同步状态',
      body: `状态：${view.state}。提供可授权读取的原始Record，最新图候选尚未就绪；不得推断历史未变化。`,
    });
  // Custom rows are existing CRM values, never synthetic evidence Records. A
  // person scope has no custom-row relationship and must not inherit company data.
  if (!filter.person_id) {
    const customBundles: AgentSource[] = [];
    for (const row of snapshot.entities
      .filter(
        (e) =>
          snapshot.schema.objects?.some((o) => o.id === e.object && o.kind === 'custom') &&
          (!filter.project_id || e.attributes.project_id === filter.project_id),
      )
      .slice(0, 40)) {
      const definition = snapshot.schema.objects!.find((o) => o.id === row.object)!;
      const values = row.attributes.values as Record<string, unknown>;
      const visible: unknown[] = [];
      const fields = definition.attributes.filter((a) => !a.system);
      let size = 0;
      for (const a of fields) {
        const stored = values[a.id] ?? null;
        const truncated = typeof stored === 'string' && stored.length > 1200;
        const value = {
          field: a.name,
          type: a.type,
          multiple: a.multiple,
          value: truncated ? stored.slice(0, 1200) : stored,
          ...(truncated ? { truncated: true } : {}),
          ...(a.currency ? { currency: a.currency } : {}),
        };
        size += Buffer.byteLength(JSON.stringify(value));
        if (size > 12000) break;
        visible.push(value);
      }
      customBundles.push({
        id: `custom::${row.object}::${row.id}`,
        title: `${definition.name} · ${row.name}`,
        body: JSON.stringify({
          object: definition.name,
          name: row.name,
          project_id: row.attributes.project_id,
          origin: 'manual',
          version: row.attributes.version,
          updated_at: row.attributes.updated_at,
          values: visible,
          omitted_fields: fields.length - visible.length,
          notice:
            '已保存的客户归属资料行；当前没有逐值业务证据，不据此宣称公司已确认。它不是沟通Record，也不是新的独立证据。',
        }),
      });
    }
    // Keep saved custom rows ahead of long historical Record bundles so the
    // caller's bounded context can include them. The caller reports truncation.
    if (selection) bundles.splice(priorityRecords, 0, ...customBundles);
    else bundles.unshift(...customBundles);
  }
  const activities = await activityAgentSources(ctx, customerId, filter);
  mergeActivityContext(bundles, activities.sources);
  if (activities.sources.length)
    bundles.push({
      id: 'activity:context-scope',
      title: '活动上下文范围',
      body: activities.warnings.join('\n'),
    });
  return bundles;
}

export async function recordEvidence(ctx: Context, customerId: string, recordId: string) {
  await customer(ctx, customerId);
  const record = (
    await ctx.tx.query<Record<string, unknown>>(
      'SELECT * FROM customer_records WHERE workspace_id=$1 AND customer_id=$2 AND id=$3',
      [ctx.workspaceId, customerId, recordId],
    )
  ).rows[0];
  if (!record) throw new ApiError(404, '记录不存在或无权访问');
  const snapshot = await knowledgeSnapshot(ctx, customerId, true);
  const graph = await knowledgeView(ctx, customerId);
  const stored =
    graph.state === 'ready'
      ? (
          await ctx.tx.query<State>(
            'SELECT extractions FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
            [ctx.workspaceId, customerId],
          )
        ).rows[0]?.extractions
      : [];
  const extractions = stored?.length
    ? (await validateExtractions(snapshot, stored)).records
        .filter((r) => r.input.record_id === recordId)
        .map((r) => r.output)
    : [];
  return {
    extractions,
    record,
    sources: snapshot.sources.filter((s) => s.record_id === recordId),
    graph_state: graph.state,
    facts: graph.facts.filter((f) => f.sources.some((s) => s.record_id === recordId)),
  };
}

const graphIdentity = z.string().min(1).max(250);
const graphSources = z.array(z.string().min(1).max(120)).max(200);
const graphSchema = z.strictObject({
  nodes: z
    .array(
      z.strictObject({
        key: graphIdentity,
        id: graphIdentity,
        group: graphIdentity,
        name: z.string().min(1).max(500),
        labels: z.array(z.string().max(120)).max(20),
        origin: z.enum(['crm', 'candidate', 'claim']),
        object_id: z.string().max(100).nullable(),
        attributes: z.record(z.string(), z.unknown()),
        source_ids: graphSources,
        record_ids: z.array(z.string().max(120)).max(200),
      }),
    )
    .max(6000),
  edges: z
    .array(
      z.strictObject({
        key: graphIdentity,
        id: graphIdentity,
        group: graphIdentity,
        source: graphIdentity,
        target: graphIdentity,
        label: z.string().max(200),
        fact: z.string().max(6000),
        kind: z.enum([
          'crm_relationship',
          'attribute_candidate',
          'relation_candidate',
          'explicit_correction',
          'proposed_change',
        ]),
        valid_at: z.iso.datetime({ offset: true }).nullable(),
        invalid_at: z.iso.datetime({ offset: true }).nullable(),
        source_ids: graphSources,
        record_ids: z.array(z.string().max(120)).max(200),
        project_id: z.uuid().nullable(),
        trust: z.enum(['customer_quote', 'inference', 'company_confirmed']).nullable(),
      }),
    )
    .max(6000),
});

function validateGraph(
  raw: unknown,
  snapshot: KnowledgeSnapshot,
  facts: KnowledgeFact[],
  checkFacts = true,
  records?: ExtractionRecord[],
): KnowledgeGraph {
  const graph = graphSchema.parse(raw);
  const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  const crm = new Map(snapshot.entities.map((e) => [e.id, e]));
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const factMap = new Map(facts.map((f) => [f.id, f]));
  if (
    nodes.size !== graph.nodes.length ||
    new Set(graph.edges.map((e) => e.key)).size !== graph.edges.length
  )
    throw new Error('Duplicate graph identity');
  const groupOf = (s: KnowledgeSource) =>
    'evidence_' +
    createHash('sha256')
      .update(
        `[${s.project_id ? JSON.stringify(s.project_id) : 'null'}, ${JSON.stringify(s.trust)}]`,
      )
      .digest('hex')
      .slice(0, 32);
  const stableId = (...parts: string[]) => {
    const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const expectedNodes = new Map<
    string,
    { name: string; origin: string; object_id: string | null; attributes: Record<string, unknown> }
  >();
  const expectedEdges = new Map<
    string,
    {
      source: string;
      target: string;
      kind: string;
      label: string;
      valid_at: string | null;
      source_ids: string[];
    }
  >();
  const claimEvidence = new Map<string, string[]>();
  for (const r of records || []) {
    const group = groupOf(sources.get(r.source_ids[0])!),
      rid = r.output.record_id;
    const identity = new Map(
      r.output.entities.map((e) => [e.ref, e.canonical_id || stableId(rid, 'entity', e.ref)]),
    );
    for (const e of r.output.entities) {
      const object =
        e.object_id ||
        ({ company: 'customers', person: 'people', project: 'projects' } as Record<string, string>)[
          e.kind
        ] ||
        null;
      expectedNodes.set(`${group}:${identity.get(e.ref)}`, {
        name: e.name,
        origin: 'candidate',
        object_id: object,
        attributes: {
          canonical_id: e.canonical_id || '',
          candidate: true,
          object_id: object || '',
        },
      });
    }
    for (const c of [...r.output.attributes, ...r.output.relations]) {
      const id = stableId(rid, c.id),
        key = `${group}:${id}`;
      const observed = [
        ...new Set(
          c.evidence.map((e) => r.input.messages.find((m) => m.id === e.message_id)!.occurred_at),
        ),
      ];
      expectedNodes.set(key, {
        name: 'entity_ref' in c ? c.field_label : c.label,
        origin: 'claim',
        object_id: null,
        attributes: {
          ...c,
          observed_at: observed,
          speaker: r.input.speakers.find((s) => s.id === c.speaker_id)!.name,
        },
      });
      expectedEdges.set(key, {
        source: `${group}:${identity.get('entity_ref' in c ? c.entity_ref : c.from_ref)}`,
        target: 'entity_ref' in c ? key : `${group}:${identity.get(c.to_ref)}`,
        kind: 'entity_ref' in c ? 'attribute_candidate' : 'relation_candidate',
        label: 'entity_ref' in c ? c.field_label : c.label,
        valid_at: c.effective_at,
        source_ids: [...new Set(c.evidence.map((e) => e.message_id))],
      });
      claimEvidence.set(id, [...new Set(c.evidence.map((e) => e.message_id))]);
    }
    r.output.changes.forEach((c, i) => {
      const newId = stableId(rid, c.new_claim_id);
      const oldId = [...r.output.attributes, ...r.output.relations].some(
        (v) => v.id === c.old_claim_id,
      )
        ? stableId(rid, c.old_claim_id)
        : c.old_claim_id;
      expectedEdges.set(`${group}:${stableId(rid, 'change', String(i))}`, {
        source: `${group}:${stableId(rid, c.new_claim_id)}`,
        target: `${group}:${oldId}`,
        kind: c.kind,
        label: c.kind === 'explicit_correction' ? '明确纠正候选' : '修改请求候选',
        valid_at: null,
        source_ids: [
          ...new Set([
            ...c.evidence.map((e) => e.message_id),
            ...(claimEvidence.get(oldId) || []),
            ...(claimEvidence.get(newId) || []),
          ]),
        ],
      });
    });
  }
  const provenance = (entry: { group: string; source_ids: string[]; record_ids: string[] }) => {
    if (
      !entry.source_ids.length ||
      entry.source_ids.some((id) => !sources.has(id) || groupOf(sources.get(id)!) !== entry.group)
    )
      throw new Error('Invalid graph provenance');
    const expected = new Set(entry.source_ids.map((id) => sources.get(id)!.record_id));
    if (
      expected.size !== entry.record_ids.length ||
      entry.record_ids.some((id) => !expected.has(id))
    )
      throw new Error('Invalid graph Record lineage');
  };
  for (const n of graph.nodes) {
    if (n.key !== `${n.group}:${n.id}`) throw new Error('Invalid graph key');
    if (n.origin === 'crm') {
      const entity = crm.get(n.id);
      if (
        n.group !== 'crm' ||
        n.source_ids.length ||
        n.record_ids.length ||
        !entity ||
        entity.object !== n.object_id ||
        entity.name !== n.name ||
        !isDeepStrictEqual(entity.attributes, n.attributes)
      )
        throw new Error('Invalid CRM graph node');
    } else {
      provenance(n);
      const expected = expectedNodes.get(n.key);
      if (
        records &&
        (!expected ||
          expected.origin !== n.origin ||
          expected.object_id !== n.object_id ||
          expected.name !== n.name ||
          !isDeepStrictEqual(expected.attributes, n.attributes))
      )
        throw new Error('Graph node disagrees with validated extraction');
      const canonical = n.attributes.canonical_id;
      if (
        canonical &&
        (typeof canonical !== 'string' ||
          !crm.has(canonical) ||
          crm.get(canonical)!.object !== n.object_id)
      )
        throw new Error('Invalid graph canonical identity');
    }
  }
  for (const e of graph.edges) {
    if (
      e.key !== `${e.group}:${e.id}` ||
      !nodes.has(e.source) ||
      !nodes.has(e.target) ||
      nodes.get(e.source)!.group !== e.group ||
      nodes.get(e.target)!.group !== e.group
    )
      throw new Error('Invalid graph endpoint');
    if (e.kind === 'crm_relationship') {
      const relation = snapshot.relationships.find((r) => r.id === e.id);
      const definition = [
        ...snapshot.schema.relationships,
        ...(snapshot.schema.references || []),
      ].find((d) => d.id === relation?.definition_id);
      let storedDefinition: unknown;
      try {
        storedDefinition = JSON.parse(e.fact);
      } catch {
        throw new Error('Invalid CRM relationship definition');
      }
      if (
        e.group !== 'crm' ||
        e.source_ids.length ||
        e.record_ids.length ||
        e.trust ||
        e.project_id ||
        !relation ||
        !definition ||
        e.label !== definition.source_label ||
        !isDeepStrictEqual(storedDefinition, definition) ||
        e.source !== `crm:${relation.source_id}` ||
        e.target !== `crm:${relation.target_id}`
      )
        throw new Error('Invalid CRM graph relationship');
    } else {
      provenance(e);
      const expected = expectedEdges.get(e.key);
      if (e.invalid_at !== null)
        throw new Error('Candidates cannot automatically invalidate information');
      if (
        records &&
        (!expected ||
          expected.source !== e.source ||
          expected.target !== e.target ||
          expected.kind !== e.kind ||
          expected.label !== e.label ||
          (expected.valid_at === null
            ? e.valid_at !== null
            : e.valid_at === null || Date.parse(expected.valid_at) !== Date.parse(e.valid_at)) ||
          expected.source_ids.some((id) => !e.source_ids.includes(id)))
      )
        throw new Error('Graph edge disagrees with validated extraction');
      if (
        e.source_ids.some(
          (id) =>
            sources.get(id)!.project_id !== e.project_id || sources.get(id)!.trust !== e.trust,
        )
      )
        throw new Error('Mixed graph provenance');
      const fact = factMap.get(e.id);
      if (
        checkFacts &&
        (!fact ||
          fact.fact !== e.fact ||
          fact.relation !== e.label ||
          fact.valid_at !== e.valid_at ||
          fact.invalid_at !== e.invalid_at ||
          !isDeepStrictEqual(fact.source_ids, e.source_ids))
      )
        throw new Error('Graph and fact readback disagree');
    }
  }
  if (
    records &&
    (graph.nodes.length !== snapshot.entities.length + expectedNodes.size ||
      graph.edges.length !== snapshot.relationships.length + expectedEdges.size)
  )
    throw new Error('Incomplete graph readback');
  return graph;
}

const factsSchema = z
  .array(
    z.strictObject({
      id: z.string().min(1).max(100),
      fact: z.string().min(1).max(4000),
      relation: z.string().max(200),
      valid_at: z.iso.datetime({ offset: true }).nullable(),
      invalid_at: z.iso.datetime({ offset: true }).nullable(),
      source_ids: z.array(z.string().max(120)).min(1).max(200),
      project_id: z.uuid().nullable(),
      trust: z.enum(['customer_quote', 'inference', 'company_confirmed']),
    }),
  )
  .max(3000);

// A single global worker limits LLM and CPU load. Lease + immutable generation prevents
// a crashed or stale worker from publishing partial graph writes.
export async function syncKnowledgeOnce(
  db: Database,
  transport: KnowledgeTransport,
  scope?: { workspace_id: string; customer_id: string },
) {
  if (scope) {
    z.uuid().parse(scope.workspace_id);
    z.uuid().parse(scope.customer_id);
  }
  const job = await db.transaction(
    async (tx) =>
      (
        await tx.query<State & { lease_token: string }>(
          `UPDATE knowledge_sync SET lease_token=$1,lease_until=now()+interval '20 minutes',state='syncing'
    WHERE (workspace_id,customer_id)=(SELECT workspace_id,customer_id FROM knowledge_sync
    WHERE attempts<3 AND (state IN ('pending','failed') OR (state='syncing' AND lease_until<now()))
    AND (lease_until IS NULL OR lease_until<now()) AND (retry_at IS NULL OR retry_at<=now())
    ${scope ? 'AND workspace_id=$2 AND customer_id=$3' : ''}
    ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
          [randomUUID(), ...(scope ? [scope.workspace_id, scope.customer_id] : [])],
        )
      ).rows[0],
  );
  if (!job) return false;
  const generation = randomUUID();
  let published = false;
  try {
    const snapshot = await scoped(db, job.actor_id, job.workspace_id, async (ctx) => {
      if (
        !(
          await ctx.tx.query<{ ok: boolean }>('SELECT crm_access($1,$2,true) AS ok', [
            ctx.workspaceId,
            job.customer_id,
          ])
        ).rows[0].ok
      )
        throw new ApiError(403, '权限已变化');
      await ensureCommunicationRecords(ctx, job.customer_id);
      job.requested_version = (
        await ctx.tx.query<{ requested_version: number }>(
          'SELECT requested_version FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
          [ctx.workspaceId, job.customer_id],
        )
      ).rows[0].requested_version;
      return knowledgeSnapshot(ctx, job.customer_id);
    });
    if (
      snapshot.sources.length > 200 ||
      snapshot.sources.some((s) => s.body.length > 24000) ||
      JSON.stringify(snapshot).length > 1500000
    )
      throw new ApiError(
        422,
        '已超过轻量同步容量（每客户200份文字来源、单份24000字、总快照150万字符），本次未同步；大批量分批同步尚未启用',
      );
    const digest = digestOf(snapshot);
    const raw =
      job.digest === digest
        ? { facts: job.facts, extractions: job.extractions, graph: job.graph }
        : await transport.sync(snapshot, generation, job.generation, job.extractions || []);
    // Legacy test/in-process transports can supply a facts-only projection. The
    // production Graphiti transport always requires validated Record extractions.
    const result = Array.isArray(raw)
      ? { facts: raw, extractions: [], graph: null }
      : z
          .strictObject({
            facts: z.unknown(),
            extractions: z.array(z.unknown()),
            graph: z.unknown().optional(),
          })
          .parse(raw);
    const facts = factsSchema.parse(result.facts);
    const validated = result.extractions.length
      ? await validateExtractions(snapshot, result.extractions)
      : null;
    const extractions = validated?.extractions || [];
    const graph = result.graph
      ? validateGraph(result.graph, snapshot, facts, true, validated?.records || [])
      : null;

    const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
    if (new Set(facts.map((f) => f.id)).size !== facts.length) throw new Error('duplicate facts');
    for (const f of facts)
      if (
        f.source_ids.some((id) => {
          const s = sources.get(id);
          return !s || s.project_id !== f.project_id || s.trust !== f.trust;
        })
      )
        throw new Error('invalid provenance');
    published = await scoped(db, job.actor_id, job.workspace_id, async (ctx) => {
      if (digestOf(await knowledgeSnapshot(ctx, job.customer_id)) !== digest) return false;
      return !!(
        await ctx.tx.query(
          `UPDATE knowledge_sync SET applied_version=requested_version,state='ready',digest=$4,schema_revision=$5,
        generation=$6,facts=$7::jsonb,extractions=$9::jsonb,graph=$10::jsonb,synced_at=now(),error=NULL,lease_token=NULL,lease_until=NULL,retry_at=NULL
        WHERE workspace_id=$1 AND customer_id=$2 AND lease_token=$3 AND requested_version=$8 RETURNING customer_id`,
          [
            job.workspace_id,
            job.customer_id,
            job.lease_token,
            digest,
            snapshot.schema.revision,
            job.digest === digest ? job.generation : generation,
            JSON.stringify(facts),
            job.requested_version,
            JSON.stringify(extractions),
            graph ? JSON.stringify(graph) : null,
          ],
        )
      ).rows.length;
    });
    if (!published)
      await db.query(
        `UPDATE knowledge_sync SET state='pending',lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND customer_id=$2 AND lease_token=$3`,
        [job.workspace_id, job.customer_id, job.lease_token],
      );
    if (published && job.generation && job.digest !== digest)
      await transport.discard(job.workspace_id, job.customer_id, job.generation).catch(() => {});
  } catch (error) {
    // Never persist model/provider output or raw exception strings containing source text.
    const safe =
      error instanceof ApiError && error.status === 422
        ? error.message
        : '同步失败：请检查 Graphiti 运行环境、模型配置和客户权限后重试';
    await db.query(
      `UPDATE knowledge_sync SET state='failed',attempts=attempts+1,error=$4,lease_token=NULL,lease_until=NULL,retry_at=now()+interval '5 minutes'
      WHERE workspace_id=$1 AND customer_id=$2 AND lease_token=$3`,
      [job.workspace_id, job.customer_id, job.lease_token, safe],
    );
  } finally {
    if (!published)
      await transport.discard(job.workspace_id, job.customer_id, generation).catch(() => {});
  }
  return true;
}

export function startKnowledgeWorker(db: Database, transport?: KnowledgeTransport) {
  let stopping = false,
    flight: Promise<unknown> | undefined;
  const tick = () => {
    if (!stopping && !flight && transport)
      flight = syncKnowledgeOnce(db, transport)
        .catch(() => {})
        .finally(() => {
          flight = undefined;
        });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await flight;
  };
}
