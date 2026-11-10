import { person } from './people.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Context } from './security.js';
import * as service from './service.js';
import type { RecordList } from '../shared/views.js';

export const listInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  object: z.enum(['customers', 'projects', 'people']),
});
export const listUpdate = z.strictObject({
  name: listInput.shape.name,
  version: z.number().int().positive(),
});
export const entriesInput = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        customer_id: z.uuid(),
        project_id: z.uuid().nullable().default(null),
        person_id: z.uuid().nullable().default(null),
      }),
    )
    .min(1)
    .max(100),
});
export async function getList(ctx: Context, id: string, object?: string) {
  const row = (
    await ctx.tx.query<RecordList>(
      'SELECT id, object, name, version FROM record_lists WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '清单不存在或无权访问');
  if (object && row.object !== object) throw new ApiError(400, '清单与记录类型不匹配');
  return row;
}
export async function allLists(ctx: Context) {
  return (
    await ctx.tx.query(
      'SELECT l.id, l.object, l.name, l.version, (SELECT count(*)::int FROM list_entries e WHERE e.workspace_id=l.workspace_id AND e.list_id=l.id) AS count FROM record_lists l WHERE l.workspace_id=$1 ORDER BY l.created_at,l.id',
      [ctx.workspaceId],
    )
  ).rows;
}
export async function createList(ctx: Context, input: unknown) {
  const { entries, ...value } = listInput
    .extend({ entries: entriesInput.shape.entries.optional() })
    .parse(input);
  const row = (
    await ctx.tx.query(
      'INSERT INTO record_lists(workspace_id,actor_id,id,object,name) VALUES($1,$2,$3,$4,$5) RETURNING id,object,name,version',
      [ctx.workspaceId, ctx.actorId, randomUUID(), value.object, value.name],
    )
  ).rows[0];
  if (entries?.length) await changeEntries(ctx, String(row.id), { entries });
  return row;
}
export async function renameList(ctx: Context, id: string, input: unknown) {
  const value = listUpdate.parse(input);
  await getList(ctx, id);
  const row = (
    await ctx.tx.query(
      'UPDATE record_lists SET name=$1 WHERE workspace_id=$2 AND id=$3 AND version=$4 RETURNING id,object,name,version',
      [value.name, ctx.workspaceId, id, value.version],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '清单已被修改，请刷新后重试');
  return row;
}
export async function changeEntries(ctx: Context, id: string, input: unknown, remove = false) {
  const list = await getList(ctx, id);
  const { entries } = entriesInput.parse(input);
  // Validate the whole batch in the surrounding transaction before adding/removing entries.
  for (const entry of entries) {
    await service.customer(ctx, entry.customer_id);
    if (list.object === 'people') {
      if (!entry.person_id || entry.project_id) throw new ApiError(400, '联系人清单需要联系人记录');
      await person(ctx, entry.person_id, entry.customer_id);
    } else if (entry.person_id) throw new ApiError(400, '此清单不能加入联系人');
    if (list.object === 'projects') {
      if (!entry.project_id) throw new ApiError(400, '项目清单需要项目记录');
      await service.project(ctx, entry.customer_id, entry.project_id);
    } else if (entry.project_id) throw new ApiError(400, '客户清单不能添加项目');
    if (remove)
      await ctx.tx.query(
        'DELETE FROM list_entries WHERE workspace_id=$1 AND list_id=$2 AND customer_id=$3 AND project_id IS NOT DISTINCT FROM $4::uuid AND person_id IS NOT DISTINCT FROM $5::uuid',
        [ctx.workspaceId, id, entry.customer_id, entry.project_id, entry.person_id],
      );
    else
      await ctx.tx.query(
        'INSERT INTO list_entries(workspace_id,actor_id,list_id,object,customer_id,project_id,person_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [
          ctx.workspaceId,
          ctx.actorId,
          id,
          list.object,
          entry.customer_id,
          entry.project_id,
          entry.person_id,
        ],
      );
  }
  return { ok: true };
}
