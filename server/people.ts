import { randomUUID } from 'node:crypto';
import { ApiError, type Context } from './security.js';
import * as service from './service.js';
import * as v from './validation.js';
import { filterSQL } from './filters.js';
import { getList } from './lists.js';
import type { Customer, Person } from '../shared/domain.js';
import { communicationJoin, communicationSelect, communicationSorts } from './communications.js';
const from = `people p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id ${communicationJoin('people')}`;
const select = `p.*, ${communicationSelect}, c.name AS customer_name, c.version AS customer_version, c.archived_at AS customer_archived_at, c.owner_id, crm_access(p.workspace_id,p.customer_id,true) AS can_edit`;
export async function person(ctx: Context, id: string, customerId?: string) {
  const p = (
    await ctx.tx.query<Person>(
      `SELECT ${select} FROM ${from} WHERE p.workspace_id=$1 AND p.id=$2`,
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!p || (customerId && p.customer_id !== customerId))
    throw new ApiError(404, '联系人不存在或不属于当前客户');
  return p;
}
export async function browsePeople(ctx: Context, input: unknown) {
  const q = v.peopleQuery.parse(input);
  const params: unknown[] = [ctx.workspaceId, q.q, q.archived === 'true'];
  let where = `p.workspace_id=$1 AND ($2='' OR position(lower($2) in lower(p.name || ' ' || p.email || ' ' || p.phone || ' ' || c.name))>0) AND (p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL)=$3`;
  if (q.customer_id) {
    await service.customer(ctx, q.customer_id);
    params.push(q.customer_id);
    where += ` AND p.customer_id=$${params.length}`;
  }
  if (q.owner === 'unassigned') where += ' AND c.owner_id IS NULL';
  else if (q.owner) {
    params.push(q.owner === 'me' ? ctx.actorId : q.owner);
    where += ` AND c.owner_id=$${params.length}`;
  }
  if (q.list_id) {
    await getList(ctx, q.list_id, 'people');
    params.push(q.list_id);
    where += ` AND EXISTS(SELECT 1 FROM list_entries e WHERE e.workspace_id=p.workspace_id AND e.customer_id=p.customer_id AND e.person_id=p.id AND e.list_id=$${params.length})`;
  }
  where += filterSQL(ctx, 'people', q.filters, params);
  const sort: Record<string, string> = {
    ...communicationSorts,
    name: 'p.name',
    customer_name: 'c.name',
    job_title: 'p.job_title',
    email: 'p.email',
    phone: 'p.phone',
    owner:
      '(SELECT m.display_name FROM workspace_people m WHERE m.workspace_id=c.workspace_id AND m.actor_id=c.owner_id)',
    updated_at: 'p.updated_at',
    created_at: 'p.created_at',
    id: 'p.id',
  };
  const items = (
    await ctx.tx.query(
      `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${sort[q.sort]} ${q.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST,p.id LIMIT 30 OFFSET $${params.length + 1}`,
      [...params, (q.page - 1) * 30],
    )
  ).rows;
  const total = (
    await ctx.tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${from} WHERE ${where}`,
      params,
    )
  ).rows[0].count;
  return { items, total, page: q.page, page_size: 30, groups: {} };
}
export async function createPerson(ctx: Context, input: unknown) {
  const value = v.personCreate.parse(input);
  service.activeCustomer(await service.customer(ctx, value.customer_id, true));
  const id = randomUUID();
  await ctx.tx.query(
    'INSERT INTO people(workspace_id,customer_id,id,name,job_title,email,phone,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      ctx.workspaceId,
      value.customer_id,
      id,
      value.name,
      value.job_title,
      value.email,
      value.phone,
      value.description,
    ],
  );
  return person(ctx, id);
}
export async function updatePerson(ctx: Context, id: string, input: unknown) {
  const value = v.personUpdate.parse(input),
    current = await person(ctx, id);
  const customer = await service.customer(ctx, current.customer_id, true);
  service.activeCustomer(customer);
  if (current.archived_at && (value.archived !== false || Object.keys(value).length !== 2))
    throw new ApiError(409, '请先恢复联系人再编辑');
  const { version, archived, customer_name, customer_version, ...data } = value;
  if (customer_version !== undefined && customer_version !== customer.version)
    throw new ApiError(409, '公司资料已被修改，请刷新后重试');
  const fields: Record<string, unknown> = { ...data };
  if (archived !== undefined) fields.archived_at = archived ? new Date().toISOString() : null;
  const values = Object.values(fields);
  // A company-only rename still checks and advances the contact version.
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 1}`);
  if (!sets.length) sets.push('name=name');
  values.push(ctx.workspaceId, id, version);
  const row = (
    await ctx.tx.query<Person>(
      `UPDATE people SET ${sets.join(',')} WHERE workspace_id=$${values.length - 2} AND id=$${values.length - 1} AND version=$${values.length} RETURNING *`,
      values,
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '联系人已被修改，请刷新后重试');
  if (row.is_primary || customer_name !== undefined)
    await service.update(ctx, 'customers', customer.id, {
      version: customer_version ?? customer.version,
      ...(customer_name !== undefined ? { name: customer_name } : {}),
      ...(row.is_primary
        ? {
            contact_name: row.archived_at ? '' : row.name,
            email: row.archived_at ? '' : row.email,
            phone: row.archived_at ? '' : row.phone,
          }
        : {}),
    });
  return person(ctx, id);
}
// Legacy customer forms and People maintain the same primary contact in one transaction.
export async function syncPrimary(ctx: Context, customer: Customer) {
  const existing = (
    await ctx.tx.query<Person>(
      'SELECT * FROM people WHERE workspace_id=$1 AND customer_id=$2 AND is_primary',
      [ctx.workspaceId, customer.id],
    )
  ).rows[0];
  if (existing) {
    await ctx.tx.query(
      'UPDATE people SET name=$1,email=$2,phone=$3,archived_at=$4 WHERE workspace_id=$5 AND id=$6',
      [
        customer.contact_name || existing.name,
        customer.email,
        customer.phone,
        customer.contact_name ? null : new Date().toISOString(),
        ctx.workspaceId,
        existing.id,
      ],
    );
  } else if (customer.contact_name) {
    await ctx.tx.query(
      'INSERT INTO people(workspace_id,customer_id,id,name,email,phone,is_primary) VALUES($1,$2,$3,$4,$5,$6,true)',
      [
        ctx.workspaceId,
        customer.id,
        randomUUID(),
        customer.contact_name,
        customer.email,
        customer.phone,
      ],
    );
  }
}
