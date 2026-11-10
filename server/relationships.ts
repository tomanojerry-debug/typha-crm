import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, requireAdmin, type Context } from './security.js';
import * as service from './service.js';
import { person } from './people.js';
import type { ObjectKind, RelationDefinition, RelatedRecord } from '../shared/connections.js';
import type { AssociatedProject, AssociatedProjectsPage } from '../shared/connections.js';
export const objectKind = z.enum(['customers', 'people', 'projects']);
const definitionInput = z
  .object({
    source_object: objectKind,
    target_object: objectKind,
    source_label: z.string().trim().min(1).max(60),
    target_label: z.string().trim().min(1).max(60),
    cardinality: z.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']),
  })
  .strict();
export async function definitions(ctx: Context) {
  return (
    await ctx.tx.query<RelationDefinition>(
      'SELECT id,source_object,target_object,source_label,target_label,cardinality FROM relationship_definitions WHERE workspace_id=$1 ORDER BY source_label,id',
      [ctx.workspaceId],
    )
  ).rows;
}
export async function createDefinition(ctx: Context, input: unknown) {
  requireAdmin(ctx);
  const d = definitionInput.parse(input);
  const count = (await definitions(ctx)).length;
  if (count >= 40) throw new ApiError(400, '最多创建 40 种关系');
  const row = (
    await ctx.tx.query<RelationDefinition>(
      'INSERT INTO relationship_definitions(workspace_id,id,source_object,target_object,source_label,target_label,cardinality) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,source_object,target_object,source_label,target_label,cardinality',
      [
        ctx.workspaceId,
        randomUUID(),
        d.source_object,
        d.target_object,
        d.source_label,
        d.target_label,
        d.cardinality,
      ],
    )
  ).rows[0];
  return row;
}
export async function record(
  ctx: Context,
  object: ObjectKind,
  id: string,
  customerId?: string,
  write = false,
) {
  if (object === 'customers') {
    const c = await service.customer(ctx, id, write);
    if (customerId && customerId !== id) throw new ApiError(400, '关联记录必须属于同一客户');
    if (write) service.activeCustomer(c);
    return { id: c.id, customer_id: c.id, name: c.name, archived_at: c.archived_at };
  }
  const r =
    object === 'people'
      ? await person(ctx, id, customerId)
      : (
          await ctx.tx.query<{
            id: string;
            customer_id: string;
            name: string;
            archived_at: string | null;
          }>(
            'SELECT id,customer_id,name,archived_at FROM projects WHERE workspace_id=$1 AND id=$2',
            [ctx.workspaceId, id],
          )
        ).rows[0];
  if (!r || (customerId && r.customer_id !== customerId))
    throw new ApiError(404, '记录不存在或不属于当前客户');
  const c = await service.customer(ctx, r.customer_id, write);
  if (write) {
    service.activeCustomer(c);
    if (r.archived_at) throw new ApiError(409, '请先恢复归档记录');
  }
  return r;
}
export async function related(ctx: Context, object: ObjectKind, id: string) {
  const r = await record(ctx, object, id);
  const rows = (
    await ctx.tx.query<{
      id: string;
      definition_id: string;
      source_id: string;
      source_object: ObjectKind;
      target_id: string;
      target_object: ObjectKind;
    }>(
      `SELECT * FROM relationship_edges WHERE workspace_id=$1 AND customer_id=$2 AND ((source_object=$3 AND source_id=$4) OR (target_object=$3 AND target_id=$4)) ORDER BY created_at,id`,
      [ctx.workspaceId, r.customer_id, object, id],
    )
  ).rows;
  const items: RelatedRecord[] = [];
  for (const e of rows) {
    const source = e.source_object === object && e.source_id === id;
    const targetObject = source ? e.target_object : e.source_object;
    const target = await record(
      ctx,
      targetObject,
      source ? e.target_id : e.source_id,
      r.customer_id,
    );
    items.push({
      edge_id: e.id,
      definition_id: e.definition_id,
      side: source ? 'source' : 'target',
      object: targetObject,
      id: target.id,
      customer_id: r.customer_id,
      name: target.name,
      archived_at: target.archived_at,
    });
  }
  return { definitions: await definitions(ctx), items };
}
export async function associatedProjects(
  ctx: Context,
  objectInput: unknown,
  id: string,
  input: unknown,
): Promise<AssociatedProjectsPage> {
  const object = z.enum(['customers', 'people']).parse(objectInput);
  const { page } = z
    .strictObject({ page: z.coerce.number().int().min(1).max(100000).default(1) })
    .parse(input);
  const owner = await record(ctx, object, id);
  const params = [ctx.workspaceId, owner.customer_id, object === 'people' ? id : null];
  // Both directions and all relationship definitions count. A company does not
  // imply a person participates in all its projects. Mail needs explicit project ownership.
  // Reads run under the existing workspace/customer RLS transaction.
  const linked = `WITH linked AS (
    SELECT p.id,p.customer_id,p.name,p.stage,p.archived_at,p.updated_at,
      EXISTS(SELECT 1 FROM relationship_edges e
        WHERE e.workspace_id=p.workspace_id AND e.customer_id=p.customer_id
          AND ((e.source_object='people' AND e.source_id=$3::uuid AND e.target_object='projects' AND e.target_id=p.id)
            OR (e.target_object='people' AND e.target_id=$3::uuid AND e.source_object='projects' AND e.source_id=p.id))) AS via_relationship,
      EXISTS(SELECT 1 FROM mail_messages m JOIN mail_people mp
        ON mp.workspace_id=m.workspace_id AND mp.customer_id=m.customer_id AND mp.message_id=m.id
        WHERE m.workspace_id=p.workspace_id AND m.customer_id=p.customer_id AND m.project_id=p.id AND mp.person_id=$3::uuid) AS via_email
    FROM projects p WHERE p.workspace_id=$1 AND p.customer_id=$2
  )`;
  const where = '$3::uuid IS NULL OR via_relationship OR via_email';
  const total = (
    await ctx.tx.query<{ total: number }>(
      `${linked} SELECT count(*)::int AS total FROM linked WHERE ${where}`,
      params,
    )
  ).rows[0].total;
  const items = (
    await ctx.tx.query<AssociatedProject>(
      `${linked}
    SELECT id,customer_id,name,stage,archived_at,via_relationship,via_email FROM linked
    WHERE ${where} ORDER BY (archived_at IS NOT NULL),updated_at DESC,id LIMIT 5 OFFSET $4`,
      [...params, (page - 1) * 5],
    )
  ).rows;
  return { items, total, page, page_size: 5 };
}
export async function candidates(ctx: Context, customerId: string, input: unknown) {
  await service.customer(ctx, customerId);
  const q = z.object({ object: objectKind, q: z.string().max(100).default('') }).parse(input);
  const table = q.object;
  return (
    await ctx.tx.query<{ id: string; name: string }>(
      `SELECT id,name FROM ${table} WHERE workspace_id=$1 AND ${table === 'customers' ? 'id' : 'customer_id'}=$2 AND archived_at IS NULL AND position(lower($3) in lower(name))>0 ORDER BY name,id LIMIT 50`,
      [ctx.workspaceId, customerId, q.q],
    )
  ).rows;
}
export async function createEdge(ctx: Context, input: unknown) {
  const v = z
    .object({ definition_id: z.uuid(), source_id: z.uuid(), target_id: z.uuid() })
    .strict()
    .parse(input);
  const d = (await definitions(ctx)).find((x) => x.id === v.definition_id);
  if (!d) throw new ApiError(404, '关系不存在');
  const s = await record(ctx, d.source_object, v.source_id, undefined, true);
  await record(ctx, d.target_object, v.target_id, s.customer_id, true);
  if (d.source_object === d.target_object && v.source_id === v.target_id)
    throw new ApiError(400, '不能关联记录自身');
  const existing = (
    await ctx.tx.query(
      'SELECT id FROM relationship_edges WHERE workspace_id=$1 AND definition_id=$2 AND source_id=$3 AND target_id=$4',
      [ctx.workspaceId, d.id, v.source_id, v.target_id],
    )
  ).rows[0];
  if (existing) return existing;
  const id = randomUUID();
  await ctx.tx.query(
    'INSERT INTO relationship_edges(workspace_id,customer_id,id,definition_id,source_object,target_object,source_id,target_id,source_person_id,source_project_id,target_person_id,target_project_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      ctx.workspaceId,
      s.customer_id,
      id,
      d.id,
      d.source_object,
      d.target_object,
      v.source_id,
      v.target_id,
      d.source_object === 'people' ? v.source_id : null,
      d.source_object === 'projects' ? v.source_id : null,
      d.target_object === 'people' ? v.target_id : null,
      d.target_object === 'projects' ? v.target_id : null,
    ],
  );
  return { id };
}
export async function removeEdge(ctx: Context, id: string) {
  const e = (
    await ctx.tx.query<{ customer_id: string }>(
      'SELECT customer_id FROM relationship_edges WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!e) throw new ApiError(404, '关联不存在或无权访问');
  service.activeCustomer(await service.customer(ctx, e.customer_id, true));
  await ctx.tx.query('DELETE FROM relationship_edges WHERE workspace_id=$1 AND id=$2', [
    ctx.workspaceId,
    id,
  ]);
  return { ok: true };
}
