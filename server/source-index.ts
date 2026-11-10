import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { ApiError, scoped, type Context } from './security.js';
import { activeCustomer, customer, project } from './service.js';
import { person } from './people.js';
import { documentKnowledgeSources } from './document-sources.js';
import { currentNoteKnowledgeSources } from './note-sources.js';
import { ensureCommunicationRecords } from './knowledge.js';
import { activityRecordAttributions } from './activity-context.js';
import { validateEmbeddingVectors } from './local-embedding-transport.js';
import {
  sourceEmbeddingModel,
  sourceEmbeddingRevision,
  type LocalEmbeddingTransport,
  type SourceSearchPrepared,
  type SourceSearchPlan,
  type SourceSearchSelection,
  type SourceSearchFilter,
} from '../shared/source-search.js';
import type { KnowledgeSource } from '../shared/knowledge.js';

const chunkerRevision = 'raw-text-256-overlap-64-token-window-pool-unicode-v2';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = () => new ApiError(409, '生成期间原文、索引或可见范围已变化，请重新整理');
type IndexState = {
  requested_version: number;
  applied_version: number;
  digest: string | null;
  state: string;
  model_revision: string | null;
  lease_token: string | null;
  error?: string | null;
  indexed_at?: string | null;
};
type Chunk = {
  id: string;
  source: KnowledgeSource;
  source_hash: string;
  start: number;
  end: number;
  body: string;
};
const iso = (value: unknown) => new Date(String(value)).toISOString();

/** Read every authorized canonical text source independently of the graph's sync limits. */
export async function sourceMaterials(
  ctx: Context,
  customerId: string,
): Promise<KnowledgeSource[]> {
  activeCustomer(await customer(ctx, customerId));
  const [projects, people] = await Promise.all([
    ctx.tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE workspace_id=$1 AND customer_id=$2 AND archived_at IS NULL',
      [ctx.workspaceId, customerId],
    ),
    ctx.tx.query<{ id: string }>(
      'SELECT id FROM people WHERE workspace_id=$1 AND customer_id=$2 AND archived_at IS NULL',
      [ctx.workspaceId, customerId],
    ),
  ]);
  const projectIds = new Set(projects.rows.map((r) => r.id));
  const personIds = new Set(people.rows.map((r) => r.id));
  const validProject = (id: string | null) => !id || projectIds.has(id);
  const sources: KnowledgeSource[] = [];
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
    FROM mail_messages m JOIN customer_records r ON r.workspace_id=m.workspace_id AND r.customer_id=m.customer_id AND r.source_mail_id=m.id
    WHERE m.workspace_id=$1 AND m.customer_id=$2 ORDER BY m.occurred_at,m.id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  for (const m of mails)
    if (validProject(m.project_id) && m.body.trim()) {
      const speaker = Array.isArray(m.sender)
        ? m.sender
            .map((s: { name?: string; address?: string }) => s.name || s.address || '未明确')
            .join('、')
        : '发件人待核对';
      sources.push({
        id: `record:${m.record_id}`,
        record_id: m.record_id,
        channel: 'email',
        trust: 'customer_quote',
        project_id: m.project_id,
        person_ids: m.person_ids.filter((id) => personIds.has(id)),
        occurred_at: iso(m.occurred_at),
        title: m.subject || '邮件',
        speaker,
        speaker_side: m.direction === 'outbound' ? 'internal' : 'external',
        message_id: m.id,
        body: m.body,
        ref: {
          kind: 'record',
          id: m.record_id,
          customer_id: customerId,
          ...(m.project_id ? { project_id: m.project_id } : {}),
          title: m.subject || '邮件',
          description: '邮件原文及派生知识共用此Record',
        },
      });
    }
  const wechat = (
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
      `SELECT e.id,e.record_id,e.project_id,e.person_id,e.occurred_at,e.speaker,e.body,e.message_id,e.from_me
    FROM knowledge_wechat_evidence e JOIN customer_records r ON r.workspace_id=e.workspace_id AND r.customer_id=e.customer_id AND r.id=e.record_id
    WHERE e.workspace_id=$1 AND e.customer_id=$2 ORDER BY e.occurred_at,e.id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  for (const e of wechat)
    if (validProject(e.project_id) && (!e.person_id || personIds.has(e.person_id)) && e.body.trim())
      sources.push({
        id: `record:${e.record_id}:part:${e.id}`,
        record_id: e.record_id,
        channel: 'wechat',
        trust: 'customer_quote',
        project_id: e.project_id,
        person_ids: e.person_id ? [e.person_id] : [],
        occurred_at: iso(e.occurred_at),
        title: '微信沟通原文',
        speaker: e.speaker || '说话人待核对',
        speaker_side: e.from_me === null ? 'unknown' : e.from_me ? 'internal' : 'external',
        ...(e.message_id ? { message_id: e.message_id } : {}),
        body: e.body,
        ref: {
          kind: 'record',
          id: e.record_id,
          customer_id: customerId,
          ...(e.project_id ? { project_id: e.project_id } : {}),
          title: '微信沟通记录',
          description: '原文及派生知识共用此Record',
        },
      });
  const records = (
    await ctx.tx.query<{
      id: string;
      project_id: string | null;
      kind: KnowledgeSource['trust'];
      body: string;
      occurred_at: string;
    }>(
      `SELECT r.id,r.project_id,r.kind,r.body,r.occurred_at FROM customer_records r WHERE r.workspace_id=$1 AND r.customer_id=$2 AND r.source_kind='manual'
      AND NOT EXISTS(SELECT 1 FROM knowledge_wechat_evidence e WHERE e.workspace_id=r.workspace_id AND e.record_id=r.id) ORDER BY r.occurred_at,r.id`,
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
        person_ids: (activityAuthors.get(r.id)?.person_ids || []).filter((id) => personIds.has(id)),
        occurred_at: iso(r.occurred_at),
        title: '业务记录',
        speaker: activityAuthors.has(r.id)
          ? `${activityAuthors.get(r.id)!.actor_name}（本人内部陈述）`
          : '提出者以原文为准',
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
  if (sources.length > 10000 || sources.reduce((sum, s) => sum + s.body.length, 0) > 30000000)
    throw new ApiError(422, '原文索引超过本地单客户容量（10000份来源或3000万字符），请分批整理');
  return sources;
}
const materialDigest = (sources: KnowledgeSource[]) =>
  hash([sourceEmbeddingRevision, chunkerRevision, sources]);
function makeChunks(sources: KnowledgeSource[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const source of sources) {
    const sourceHash = hash(source);
    for (let offset = 0; offset < source.body.length; offset += 192) {
      // Keep offsets in JavaScript UTF-16 units; quote validation uses the same string.slice semantics.
      // Never split a surrogate pair (common in WeChat emoji) at either boundary.
      const atLowSurrogate = (i: number) =>
        i > 0 &&
        i < source.body.length &&
        source.body.charCodeAt(i) >= 0xdc00 &&
        source.body.charCodeAt(i) <= 0xdfff &&
        source.body.charCodeAt(i - 1) >= 0xd800 &&
        source.body.charCodeAt(i - 1) <= 0xdbff;
      const start = atLowSurrogate(offset) ? offset - 1 : offset;
      let end = Math.min(start + 256, source.body.length);
      if (atLowSurrogate(end)) end--;
      const body = source.body.slice(start, end);
      if (body.trim()) {
        const hex = hash([
          source.id,
          sourceHash,
          start,
          end,
          sourceEmbeddingRevision,
          chunkerRevision,
        ]);
        const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        chunks.push({ id, source, source_hash: sourceHash, start, end, body });
      }
      if (end === source.body.length) break;
    }
  }
  if (chunks.length > 25000)
    throw new ApiError(422, '原文索引超过本地单客户25000个切片容量，请分批整理');
  return chunks;
}
async function indexState(ctx: Context, customerId: string) {
  return (
    await ctx.tx.query<IndexState>(
      'SELECT requested_version,applied_version,digest,state,model_revision,lease_token,error,indexed_at FROM source_index_sync WHERE workspace_id=$1 AND customer_id=$2',
      [ctx.workspaceId, customerId],
    )
  ).rows[0];
}

/** Read-only publication status. A stored ready flag alone is never sufficient. */
export async function sourceIndexStatus(
  ctx: Context,
  customerId: string,
  filter: { project_id?: string; person_id?: string } = {},
) {
  if (filter.project_id) await project(ctx, customerId, filter.project_id);
  if (filter.person_id) await person(ctx, filter.person_id, customerId);
  const materials = await sourceMaterials(ctx, customerId),
    stored = await indexState(ctx, customerId);
  const current =
    stored?.state === 'ready' &&
    stored.digest === materialDigest(materials) &&
    stored.model_revision === sourceEmbeddingRevision &&
    Number(stored.requested_version) === Number(stored.applied_version);
  const eligible = materials.filter(
    (s) =>
      (!filter.project_id || s.project_id === filter.project_id) &&
      (!filter.person_id || s.person_ids.includes(filter.person_id)),
  );
  const ids = eligible.map((s) => s.id);
  const count = (
    await ctx.tx.query<{ chunks: number; records: number }>(
      `SELECT count(*)::int AS chunks,count(DISTINCT record_id)::int AS records
       FROM source_chunks WHERE workspace_id=$1 AND customer_id=$2 AND source_id=ANY($3::text[])`,
      [ctx.workspaceId, customerId, ids],
    )
  ).rows[0];
  return {
    state: current ? 'ready' : stored?.state === 'ready' ? 'pending' : stored?.state || 'pending',
    requested_version: Number(stored?.requested_version || 0),
    applied_version: Number(stored?.applied_version || 0),
    current: !!current,
    error: stored?.error || null,
    indexed_at: stored?.indexed_at ? iso(stored.indexed_at) : null,
    source_count: eligible.length,
    record_count: new Set(eligible.map((s) => s.record_id)).size,
    chunk_count: Number(count?.chunks || 0),
    indexed_record_count: Number(count?.records || 0),
    model: sourceEmbeddingModel,
    model_revision: stored?.model_revision || null,
  };
}

/** Idempotent local indexing; only changed chunks are embedded, always outside the CRM transaction. */
export async function ensureSourceIndex(
  db: Database,
  actorId: string,
  workspaceId: string,
  customerId: string,
  transport?: LocalEmbeddingTransport,
) {
  if (!transport) throw new ApiError(503, '本地原文向量模型未配置，无法自动整理历史资料');
  const prepared = await scoped(db, actorId, workspaceId, async (ctx) => {
    const c = await customer(ctx, customerId, true);
    activeCustomer(c);
    // Pre-feature emails may not have a Record yet. Backfill that canonical ID
    // without requiring Graphiti extraction or a successful graph publication.
    await ensureCommunicationRecords(ctx, customerId);
    const sources = await sourceMaterials(ctx, customerId),
      digest = materialDigest(sources);
    const state = await indexState(ctx, customerId);
    if (
      state?.state === 'ready' &&
      state.digest === digest &&
      state.model_revision === sourceEmbeddingRevision &&
      Number(state.applied_version) === Number(state.requested_version)
    )
      return null;
    await ctx.tx.query(
      `INSERT INTO source_index_sync(workspace_id,customer_id,actor_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,customer_id) DO NOTHING`,
      [workspaceId, customerId, actorId],
    );
    const lease = randomUUID();
    const claimed = (
      await ctx.tx.query<{ requested_version: number }>(
        `UPDATE source_index_sync SET state='indexing',lease_token=$4,lease_until=now()+interval '10 minutes',actor_id=$3
      WHERE workspace_id=$1 AND customer_id=$2 AND (lease_until IS NULL OR lease_until<now()) RETURNING requested_version`,
        [workspaceId, customerId, actorId, lease],
      )
    ).rows[0];
    if (!claimed) throw new ApiError(409, '原文正在建立索引，请稍后重试');
    const chunks = makeChunks(sources);
    const stored = new Set(
      (
        await ctx.tx.query<{ id: string }>(
          'SELECT id FROM source_chunks WHERE workspace_id=$1 AND customer_id=$2 AND model_revision=$3 AND chunker_revision=$4',
          [workspaceId, customerId, sourceEmbeddingRevision, chunkerRevision],
        )
      ).rows.map((r) => r.id),
    );
    return {
      chunks,
      digest,
      lease,
      version: Number(claimed.requested_version),
      missing: chunks.filter((c) => !stored.has(c.id)),
    };
  });
  if (!prepared) return;
  try {
    const vectors = new Map<string, number[]>();
    for (let start = 0; start < prepared.missing.length; start += 128) {
      const batch = prepared.missing.slice(start, start + 128);
      const result = await transport.embed({
        texts: batch.map(
          (c) => `${c.source.title.slice(0, 80)}\n${c.source.speaker.slice(0, 40)}\n${c.body}`,
        ),
      });
      if (result.model !== sourceEmbeddingModel || result.dimensions !== 384)
        throw new Error('Local embedding model mismatch');
      validateEmbeddingVectors(result.vectors, batch.length);
      batch.forEach((c, i) => vectors.set(c.id, result.vectors[i]));
    }
    await scoped(db, actorId, workspaceId, async (ctx) => {
      await customer(ctx, customerId, true);
      const sources = await sourceMaterials(ctx, customerId),
        state = await indexState(ctx, customerId);
      if (
        materialDigest(sources) !== prepared.digest ||
        state?.lease_token !== prepared.lease ||
        Number(state.requested_version) !== prepared.version
      )
        throw changed();
      for (const c of prepared.missing)
        await ctx.tx.query(
          `INSERT INTO source_chunks(workspace_id,customer_id,id,record_id,source_id,project_id,person_ids,source_hash,start_offset,end_offset,body,model_revision,chunker_revision,embedding)
        VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11,$12,$13,$14::vector) ON CONFLICT(workspace_id,id) DO NOTHING`,
          [
            workspaceId,
            customerId,
            c.id,
            c.source.record_id,
            c.source.id,
            c.source.project_id,
            c.source.person_ids,
            c.source_hash,
            c.start,
            c.end,
            c.body,
            sourceEmbeddingRevision,
            chunkerRevision,
            JSON.stringify(vectors.get(c.id)),
          ],
        );
      await ctx.tx.query('SELECT crm_prune_source_chunks($1,$2,$3::uuid[])', [
        workspaceId,
        customerId,
        prepared.chunks.map((c) => c.id),
      ]);
      await ctx.tx.query(
        `UPDATE source_index_sync SET state='ready',applied_version=requested_version,digest=$4,model_revision=$5,lease_token=NULL,lease_until=NULL,error=NULL,attempts=0,retry_at=NULL,indexed_at=now(),updated_at=now() WHERE workspace_id=$1 AND customer_id=$2 AND lease_token=$3`,
        [workspaceId, customerId, prepared.lease, prepared.digest, sourceEmbeddingRevision],
      );
    });
  } catch (error) {
    await db.query(
      `UPDATE source_index_sync SET state='failed',lease_token=NULL,lease_until=NULL,attempts=attempts+1,retry_at=now()+interval '5 minutes',error=$4 WHERE workspace_id=$1 AND customer_id=$2 AND lease_token=$3`,
      [
        workspaceId,
        customerId,
        prepared.lease,
        error instanceof ApiError && error.status === 422
          ? error.message
          : '原文索引未完成，请检查本地模型与客户权限后重试',
      ],
    );
    if (error instanceof ApiError && [403, 404].includes(error.status)) throw changed();
    throw error;
  }
}

export async function prepareSourceSearch(
  ctx: Context,
  customerId: string,
  query: string,
  filter: SourceSearchFilter = {},
): Promise<SourceSearchPrepared> {
  const question = z.string().trim().min(1).max(2000).parse(query);
  const scopeFilter = z
    .strictObject({
      project_id: z.uuid().optional(),
      person_id: z.uuid().optional(),
      note_only: z.boolean().optional(),
    })
    .parse(filter);
  if (scopeFilter.project_id) {
    const p = await project(ctx, customerId, scopeFilter.project_id);
    if (p.archived_at) throw changed();
  }
  if (scopeFilter.person_id) {
    const p = await person(ctx, scopeFilter.person_id, customerId);
    if (p.archived_at) throw changed();
  }
  const materials = await sourceMaterials(ctx, customerId),
    state = await indexState(ctx, customerId),
    digest = materialDigest(materials);
  if (
    !state ||
    state.state !== 'ready' ||
    state.digest !== digest ||
    state.model_revision !== sourceEmbeddingRevision ||
    Number(state.requested_version) !== Number(state.applied_version)
  )
    throw new ApiError(409, '原文索引尚未就绪，请先整理原文后重试');
  return {
    scope: {
      workspace_id: ctx.workspaceId,
      actor_id: ctx.actorId,
      customer_id: customerId,
      filter: scopeFilter,
    },
    query: question,
    source_digest: digest,
    index_version: Number(state.applied_version),
    model_revision: sourceEmbeddingRevision,
  };
}
export async function executeSourceSearch(
  prepared: SourceSearchPrepared,
  transport?: LocalEmbeddingTransport,
): Promise<SourceSearchPlan> {
  if (!transport) throw new ApiError(503, '本地原文向量模型未配置');
  const result = await transport.embed({ texts: [prepared.query] });
  if (result.model !== sourceEmbeddingModel || result.dimensions !== 384)
    throw new Error('Local embedding model mismatch');
  validateEmbeddingVectors(result.vectors, 1);
  const { query: _, ...rest } = prepared;
  return { ...rest, vector: result.vectors[0] };
}
export async function validateSourceSearch(
  ctx: Context,
  plan: SourceSearchPlan,
): Promise<SourceSearchSelection> {
  if (
    ctx.workspaceId !== plan.scope.workspace_id ||
    ctx.actorId !== plan.scope.actor_id ||
    plan.model_revision !== sourceEmbeddingRevision
  )
    throw changed();
  validateEmbeddingVectors([plan.vector], 1);
  try {
    const current = await prepareSourceSearch(
      ctx,
      plan.scope.customer_id,
      '复核',
      plan.scope.filter,
    );
    if (
      current.source_digest !== plan.source_digest ||
      current.index_version !== plan.index_version
    )
      throw changed();
    const materials = await sourceMaterials(ctx, plan.scope.customer_id),
      sourceMap = new Map(materials.map((s) => [s.id, s]));
    // Exact pgvector search on a materialized authorized subset. The LIMIT can never
    // consume another customer's, project's or person's rows before authorization.
    const hits = (
      await ctx.tx.query<{
        id: string;
        record_id: string;
        source_id: string;
        source_hash: string;
        start_offset: number;
        end_offset: number;
        body: string;
        score: number;
      }>(
        `WITH permitted AS MATERIALIZED (SELECT c.* FROM source_chunks c WHERE c.workspace_id=$1 AND c.customer_id=$2 AND c.model_revision=$3 AND c.chunker_revision=$4
        AND ($5::uuid IS NULL OR c.project_id=$5) AND ($6::uuid IS NULL OR $6=ANY(c.person_ids))
        AND EXISTS(SELECT 1 FROM customer_records r WHERE r.workspace_id=c.workspace_id AND r.customer_id=c.customer_id AND r.id=c.record_id AND (NOT $8::boolean OR r.source_kind='note')))
       SELECT id,record_id,source_id,source_hash,start_offset,end_offset,body,1-(embedding <=> $7::vector) AS score FROM permitted
       WHERE 1-(embedding <=> $7::vector)>=0.2 ORDER BY embedding <=> $7::vector,id LIMIT 12`,
        [
          ctx.workspaceId,
          plan.scope.customer_id,
          sourceEmbeddingRevision,
          chunkerRevision,
          plan.scope.filter.project_id || null,
          plan.scope.filter.person_id || null,
          JSON.stringify(plan.vector),
          !!plan.scope.filter.note_only,
        ],
      )
    ).rows;
    const grouped = new Map<string, typeof hits>();
    for (const hit of hits) {
      const source = sourceMap.get(hit.source_id);
      if (
        !source ||
        source.record_id !== hit.record_id ||
        hash(source) !== hit.source_hash ||
        source.body.slice(hit.start_offset, hit.end_offset) !== hit.body
      )
        throw changed();
      const list = grouped.get(hit.record_id) || [];
      list.push(hit);
      grouped.set(hit.record_id, list);
    }
    const sources = [...grouped].map(([recordId, chunks]) => {
      const source = sourceMap.get(chunks[0].source_id)!;
      return {
        id: `record::${recordId}`,
        title: source.title,
        ref: source.ref,
        body: JSON.stringify({
          evidence: chunks
            .sort(
              (a, b) => a.source_id.localeCompare(b.source_id) || a.start_offset - b.start_offset,
            )
            .map((c) => {
              const s = sourceMap.get(c.source_id)!;
              return {
                source_id: s.id,
                channel: s.channel,
                speaker: s.speaker,
                speaker_side: s.speaker_side || 'unknown',
                occurred_at: s.occurred_at,
                trust: s.trust,
                start_offset: c.start_offset,
                end_offset: c.end_offset,
                body: c.body,
                ...(s.note ? { note: s.note } : {}),
              };
            }),
          notice:
            '按语义召回的原文片段。原文、结构化提取和图事实共用同一Record，不是独立证据；相似度不证明事实。客户说法、推断和公司确认分别判断；无直接依据不要生成属性值。',
        }),
      };
    });
    return {
      sources,
      record_ids: [...grouped.keys()],
      digest: hash([
        plan.source_digest,
        plan.index_version,
        hits.map((h) => [h.id, h.source_hash]),
      ]),
      warnings: [
        '原文已按当前客户及授权范围进行本地向量召回；最多12个相关切片，结果不代表完整历史，需核对说话人、时间及纠正。',
      ],
    };
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status)) throw changed();
    throw error;
  }
}

export async function syncSourceIndexOnce(db: Database, transport: LocalEmbeddingTransport) {
  const job = (
    await db.query<{
      workspace_id: string;
      customer_id: string;
      actor_id: string;
    }>(`SELECT workspace_id,customer_id,actor_id FROM source_index_sync
    WHERE attempts<3 AND (state IN ('pending','failed') OR (state='indexing' AND lease_until<now()))
    AND (lease_until IS NULL OR lease_until<now()) AND (retry_at IS NULL OR retry_at<=now()) ORDER BY updated_at LIMIT 1`)
  ).rows[0];
  if (!job) return false;
  try {
    await ensureSourceIndex(db, job.actor_id, job.workspace_id, job.customer_id, transport);
  } catch {
    // Preparation failures happen before a lease exists (e.g. revoked actor).
    // Bound those retries too, without replacing another active worker's lease.
    await db.query(
      `UPDATE source_index_sync SET state='failed',attempts=attempts+1,retry_at=now()+interval '5 minutes',error='原文索引未完成，请检查本地模型与客户权限后重试'
      WHERE workspace_id=$1 AND customer_id=$2 AND state IN ('pending','indexing') AND (lease_until IS NULL OR lease_until<now())`,
      [job.workspace_id, job.customer_id],
    );
  }
  return true;
}
export function startSourceIndexWorker(db: Database, transport?: LocalEmbeddingTransport) {
  let stopping = false,
    flight: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (!stopping && !flight && transport)
      flight = syncSourceIndexOnce(db, transport)
        .catch(() => {})
        .finally(() => {
          flight = undefined;
        });
  }, 5000);
  timer.unref();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await flight;
  };
}
