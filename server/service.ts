import { randomUUID } from 'node:crypto';
import type { Customer, Project, WorkspaceMode } from '../shared/domain.js';
import { ApiError, requireAdmin, type Context } from './security.js';
import { communicationJoin, communicationSelect } from './communications.js';

export async function customer(ctx: Context, id: string, write = false) {
  const row = (
    await ctx.tx.query<Customer>(
      `SELECT c.*, ${communicationSelect}, crm_access(c.workspace_id, c.id, true) AS can_edit FROM customers c ${communicationJoin('customers')} WHERE c.workspace_id = $1 AND c.id = $2`,
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '客户不存在或无权访问');
  if (write && !row.can_edit) throw new ApiError(403, '当前客户为只读权限');
  return row;
}
export function activeCustomer(row: Customer) {
  if (row.archived_at) throw new ApiError(409, '客户已归档，请先恢复客户');
}
export async function project(ctx: Context, customerId: string, projectId: string) {
  const row = (
    await ctx.tx.query<Project>(
      "SELECT *, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM projects WHERE workspace_id = $1 AND customer_id = $2 AND id = $3",
      [ctx.workspaceId, customerId, projectId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '项目不存在或不属于当前客户');
  return row;
}
export async function validateOwner(ctx: Context, owner: unknown, customerId?: string) {
  if (owner === undefined || owner === null) return;
  const member = (
    await ctx.tx.query<{ role: string; workspace_mode: WorkspaceMode }>(
      `SELECT p.role, COALESCE(to_jsonb(p)->>'workspace_mode', 'crm') AS workspace_mode
       FROM workspace_people p WHERE p.workspace_id = $1 AND p.actor_id = $2 AND p.active`,
      [ctx.workspaceId, owner],
    )
  ).rows[0];
  if (!member) throw new ApiError(400, '负责人必须是当前工作空间的有效成员');
  if (member.workspace_mode === 'tasks')
    throw new ApiError(400, '仅处理协作待办的成员不能设为客户或项目负责人');
  // Assignment doesn't grant access. Only admins manage access; users cannot
  // turn an assignee field into an implicit permission change.
  if (!customerId && member.role !== 'admin')
    throw new ApiError(400, '请先创建客户并授权，再指定普通成员为负责人');
}
export async function insert(
  ctx: Context,
  table: 'customers' | 'projects' | 'customer_records',
  data: Record<string, unknown>,
) {
  const row = { ...data, workspace_id: ctx.workspaceId, id: randomUUID() };
  const columns = Object.keys(row);
  const result = await ctx.tx.query(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    Object.values(row),
  );
  return result.rows[0];
}
export async function update(
  ctx: Context,
  table: 'customers' | 'projects',
  id: string,
  data: Record<string, unknown> & { version: number },
  customerId?: string,
) {
  const { version, archived, ...fields } = data;
  if (archived !== undefined) {
    if (table === 'customers') requireAdmin(ctx);
    fields.archived_at = archived ? new Date().toISOString() : null;
  }
  const values = Object.values(fields);
  const sets = Object.keys(fields).map((key, i) => `${key} = $${i + 1}`);
  const offset = values.length;
  values.push(ctx.workspaceId, id, version);
  let where = `workspace_id = $${offset + 1} AND id = $${offset + 2} AND version = $${offset + 3}`;
  if (customerId) {
    values.push(customerId);
    where += ` AND customer_id = $${values.length}`;
  }
  const row = (
    await ctx.tx.query(`UPDATE ${table} SET ${sets.join(',')} WHERE ${where} RETURNING *`, values)
  ).rows[0];
  if (!row) throw new ApiError(409, '记录已被修改，请刷新后重试');
  return row;
}
