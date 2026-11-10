import { z } from 'zod';
import { ApiError, type Context } from './security.js';
import { customer, activeCustomer, project } from './service.js';
import { person } from './people.js';
import type { NoteSourceRef } from '../shared/notes.js';
import type { KnowledgeSource } from '../shared/knowledge.js';

export interface NoteSourceMaterial extends NoteSourceRef {
  body: string;
  project_id: string | null;
  person_ids: string[];
  note_id?: string;
  note_revision_id?: string;
  person_scope_complete?: boolean;
  project_scope_complete?: boolean;
}
const uuid = z.string().uuid();
export const notePersonRecordMatch = `EXISTS(SELECT 1 FROM note_revisions nr JOIN notes nn ON nn.workspace_id=nr.workspace_id AND nn.current_revision_id=nr.id JOIN note_people np ON np.workspace_id=nr.workspace_id AND np.revision_id=nr.id WHERE nr.workspace_id=r.workspace_id AND nr.customer_id=r.customer_id AND nr.record_id=r.id AND nn.archived_at IS NULL AND np.person_id=$4)`;

export async function resolveNoteSource(
  ctx: Context,
  customerId: string,
  input: { record_id: string; source_id?: string },
  filter: { project_id?: string; person_id?: string } = {},
): Promise<NoteSourceMaterial> {
  activeCustomer(await customer(ctx, uuid.parse(customerId)));
  if (filter.project_id) await project(ctx, customerId, uuid.parse(filter.project_id));
  if (filter.person_id) await person(ctx, uuid.parse(filter.person_id), customerId);
  const payload = (
    await ctx.tx.query<{
      payload: {
        record_id: string;
        customer_id: string;
        project_id: string | null;
        person_ids: string[];
        body: string;
        source_hash: string;
        title?: string;
        note_id?: string;
        revision_id?: string;
        person_scope_complete?: boolean;
        project_scope_complete?: boolean;
      } | null;
    }>('SELECT crm_note_read_source($1,$2) AS payload', [
      ctx.workspaceId,
      uuid.parse(input.record_id),
    ])
  ).rows[0]?.payload;
  if (
    !payload ||
    payload.customer_id !== customerId ||
    !payload.body?.trim() ||
    (filter.project_id &&
      (payload.project_id !== filter.project_id || payload.project_scope_complete === false)) ||
    (filter.person_id &&
      (!payload.person_ids.includes(filter.person_id) || payload.person_scope_complete === false))
  )
    throw new ApiError(404, '笔记来源不存在、已变化或不在当前授权范围');
  return {
    record_id: payload.record_id,
    source_id: `record:${payload.record_id}`,
    source_hash: payload.source_hash,
    title: payload.title || '业务原文',
    quote: payload.body.slice(0, 1000),
    body: payload.body,
    project_id: payload.project_id,
    person_ids: payload.person_ids,
    person_scope_complete: payload.person_scope_complete,
    project_scope_complete: payload.project_scope_complete,
    ...(payload.note_id ? { note_id: payload.note_id, note_revision_id: payload.revision_id } : {}),
  };
}

export async function noteRecordVisible(
  ctx: Context,
  recordId: string,
  filter: { project_id?: string; person_id?: string } = {},
): Promise<boolean> {
  const row = (
    await ctx.tx.query<{ id: string }>(
      `SELECT r.id FROM customer_records r WHERE r.workspace_id=$1 AND r.id=$2
       AND ($3::uuid IS NULL OR r.project_id=$3)
       AND ($4::uuid IS NULL OR ${notePersonRecordMatch})`,
      [ctx.workspaceId, recordId, filter.project_id || null, filter.person_id || null],
    )
  ).rows[0];
  return !!row;
}

/** Canonical current originals only. Derived blocks are views over their root sources. */
export async function currentNoteKnowledgeSources(
  ctx: Context,
  customerId: string,
): Promise<KnowledgeSource[]> {
  const rows = (
    await ctx.tx.query<{
      id: string;
      revision_id: string;
      version: number;
      title: string;
      content_hash: string;
      record_id: string;
      project_id: string | null;
      body: string;
      person_ids: string[];
      created_at: string;
      author: string;
      source_hash: string;
    }>(
      `SELECT n.id,nr.id AS revision_id,nr.version,nr.title,nr.content_hash,nr.record_id,nr.project_id,r.body,nr.created_at,
       coalesce(m.display_name,'内部成员') AS author,
       coalesce((SELECT array_agg(p.person_id ORDER BY p.person_id) FROM note_people p WHERE p.workspace_id=nr.workspace_id AND p.revision_id=nr.id),'{}'::uuid[]) AS person_ids,
       (crm_note_read_source(n.workspace_id,nr.record_id)->>'source_hash') AS source_hash
       FROM notes n JOIN note_revisions nr ON nr.workspace_id=n.workspace_id AND nr.id=n.current_revision_id
       JOIN customer_records r ON r.workspace_id=nr.workspace_id AND r.id=nr.record_id
       LEFT JOIN workspace_people m ON m.workspace_id=nr.workspace_id AND m.actor_id=nr.created_by
       WHERE n.workspace_id=$1 AND n.customer_id=$2 AND n.archived_at IS NULL
       ORDER BY nr.created_at,n.id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  return rows.map((r) => ({
    id: `record:${r.record_id}`,
    record_id: r.record_id,
    channel: 'record',
    trust: 'inference',
    project_id: r.project_id,
    person_ids: r.person_ids,
    occurred_at: new Date(r.created_at).toISOString(),
    title: `${r.title} · v${r.version}`,
    speaker: `${r.author}（内部笔记，不代表公司正式确认）`,
    speaker_side: 'internal',
    body: r.body,
    note: {
      id: r.id,
      revision_id: r.revision_id,
      version: r.version,
      content_hash: r.content_hash,
    },
    ref: {
      kind: 'record',
      id: r.record_id,
      customer_id: customerId,
      ...(r.project_id ? { project_id: r.project_id } : {}),
      title: r.title,
      description: `笔记正式版本 v${r.version}；内部署名陈述`,
      note_id: r.id,
      note_revision_id: r.revision_id,
      note_version: r.version,
      source_hash: r.source_hash,
    },
  }));
}

export async function noteSourceCandidates(
  ctx: Context,
  input: unknown,
): Promise<{ sources: NoteSourceMaterial[] }> {
  const q = z
    .object({ customer_id: uuid, project_id: uuid.optional(), person_id: uuid.optional() })
    .parse(input);
  activeCustomer(await customer(ctx, q.customer_id));
  const rows = (
    await ctx.tx.query<{ id: string }>(
      'SELECT id FROM customer_records WHERE workspace_id=$1 AND customer_id=$2 ORDER BY occurred_at DESC,id LIMIT 150',
      [ctx.workspaceId, q.customer_id],
    )
  ).rows;
  const sources: NoteSourceMaterial[] = [];
  for (const row of rows) {
    try {
      sources.push(await resolveNoteSource(ctx, q.customer_id, { record_id: row.id }, q));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (sources.length === 50) break;
  }
  return { sources };
}
