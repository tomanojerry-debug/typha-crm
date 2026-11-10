import { filterSQL } from './filters.js';
import { getList } from './lists.js';
import type { Context } from './security.js';
import * as v from './validation.js';
import { communicationJoin, communicationSelect, communicationSorts } from './communications.js';

const customerSort: Record<string, string> = {
  ...communicationSorts,
  updated_at: 'c.updated_at',
  created_at: 'c.created_at',
  name: 'c.name',
  region: 'c.region',
  type: 'c.type',
  status: 'c.status',
  contact: 'c.contact_name',
  email: 'c.email',
  phone: 'c.phone',
  source: 'c.source',
  owner:
    '(SELECT m.display_name FROM workspace_people m WHERE m.workspace_id=c.workspace_id AND m.actor_id=c.owner_id)',
  project_count:
    '(SELECT count(*) FROM projects p WHERE p.workspace_id=c.workspace_id AND p.customer_id=c.id AND p.archived_at IS NULL)',
};
const projectSort: Record<string, string> = {
  updated_at: 'p.updated_at',
  created_at: 'p.created_at',
  name: 'p.name',
  due_date: 'p.due_date',
  type: 'p.type',
  stage: 'p.stage',
  customer_name: 'c.name',
  owner:
    '(SELECT m.display_name FROM workspace_people m WHERE m.workspace_id=p.workspace_id AND m.actor_id=p.owner_id)',
};
function ownerValue(ctx: Context, value?: string) {
  return value === 'me' ? ctx.actorId : value || '';
}

export async function customers(ctx: Context, input: unknown) {
  const q = v.customerQuery.parse(input);
  const owner = ownerValue(ctx, q.owner);
  const params: unknown[] = [
    ctx.workspaceId,
    q.q,
    q.type ?? null,
    q.status ?? null,
    q.archived === 'true',
    q.source ?? null,
    owner === 'unassigned' ? '' : owner,
    owner === 'unassigned',
    q.region ?? '',
    q.editable === 'true',
  ];
  let where = `c.workspace_id = $1
    AND ($2 = '' OR position(lower($2) in lower(c.name || ' ' || c.contact_name || ' ' || c.email)) > 0)
    AND ($3::text IS NULL OR c.type = $3) AND ($4::text IS NULL OR c.status = $4)
    AND (c.archived_at IS NOT NULL) = $5 AND ($6::text IS NULL OR c.source = $6)
    AND ($7 = '' OR c.owner_id = nullif($7, '')::uuid) AND (NOT $8 OR c.owner_id IS NULL)
    AND ($9 = '' OR position(lower($9) in lower(c.region)) > 0)
    AND (NOT $10 OR (c.archived_at IS NULL AND crm_access(c.workspace_id, c.id, true)))`;
  if (q.list_id) {
    await getList(ctx, q.list_id, 'customers');
    params.push(q.list_id);
    where += ` AND EXISTS (SELECT 1 FROM list_entries e WHERE e.workspace_id=c.workspace_id AND e.customer_id=c.id AND e.list_id=$${params.length} AND e.project_id IS NULL)`;
  }
  where += filterSQL(ctx, 'customers', q.filters, params);
  const direction = q.direction === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await ctx.tx.query(
    `SELECT c.*, ${communicationSelect}, crm_access(c.workspace_id, c.id, true) AS can_edit,
    (SELECT count(*)::int FROM projects p WHERE p.workspace_id = c.workspace_id AND p.customer_id = c.id AND p.archived_at IS NULL) AS project_count
    FROM customers c ${communicationJoin('customers')} WHERE ${where} ORDER BY ${customerSort[q.sort]} ${direction} NULLS LAST, c.id LIMIT 30 OFFSET $${params.length + 1}`,
    [...params, (q.page - 1) * 30],
  );
  const groups = (
    await ctx.tx.query<{ status: string; count: number }>(
      `SELECT c.status, count(*)::int AS count FROM customers c ${communicationJoin('customers')} WHERE ${where} GROUP BY c.status`,
      params,
    )
  ).rows;
  const counts = (
    await ctx.tx.query(
      `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS customers,
    count(*) FILTER (WHERE archived_at IS NULL AND status = 'active')::int AS active_customers FROM customers WHERE workspace_id = $1`,
      [ctx.workspaceId],
    )
  ).rows[0];
  const projects = (
    await ctx.tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM projects p JOIN customers c ON c.workspace_id = p.workspace_id AND c.id = p.customer_id
    WHERE p.workspace_id = $1 AND p.archived_at IS NULL AND c.archived_at IS NULL AND p.stage NOT IN ('completed', 'cancelled')`,
      [ctx.workspaceId],
    )
  ).rows[0].count;
  return {
    items: rows,
    total: groups.reduce((n, g) => n + g.count, 0),
    page: q.page,
    page_size: 30,
    groups: Object.fromEntries(groups.map((g) => [g.status, g.count])),
    summary: { ...counts, open_projects: projects },
  };
}

export async function projects(ctx: Context, input: unknown) {
  const q = v.projectQuery.parse(input);
  const owner = ownerValue(ctx, q.owner);
  const params: unknown[] = [
    ctx.workspaceId,
    q.q,
    q.type ?? null,
    q.stage ?? null,
    q.archived === 'true',
    owner === 'unassigned' ? '' : owner,
    owner === 'unassigned',
  ];
  const from =
    'projects p JOIN customers c ON c.workspace_id = p.workspace_id AND c.id = p.customer_id';
  let where = `p.workspace_id = $1
    AND ($2 = '' OR position(lower($2) in lower(p.name || ' ' || c.name)) > 0)
    AND ($3::text IS NULL OR p.type = $3) AND ($4::text IS NULL OR p.stage = $4)
    AND (p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL) = $5
    AND ($6 = '' OR p.owner_id = nullif($6, '')::uuid) AND (NOT $7 OR p.owner_id IS NULL)`;
  if (q.list_id) {
    await getList(ctx, q.list_id, 'projects');
    params.push(q.list_id);
    where += ` AND EXISTS (SELECT 1 FROM list_entries e WHERE e.workspace_id=p.workspace_id AND e.project_id=p.id AND e.customer_id=p.customer_id AND e.list_id=$${params.length})`;
  }
  where += filterSQL(ctx, 'projects', q.filters, params);
  const direction = q.direction === 'asc' ? 'ASC' : 'DESC';
  const items = (
    await ctx.tx.query(
      `SELECT p.*, to_char(p.due_date, 'YYYY-MM-DD') AS due_date, c.name AS customer_name, c.archived_at AS customer_archived_at,
    (crm_access(p.workspace_id, p.customer_id, true) AND c.archived_at IS NULL AND p.archived_at IS NULL) AS can_edit
    FROM ${from} WHERE ${where} ORDER BY ${projectSort[q.sort]} ${direction} NULLS LAST, p.id LIMIT 30 OFFSET $${params.length + 1}`,
      [...params, (q.page - 1) * 30],
    )
  ).rows;
  const groups = (
    await ctx.tx.query<{ stage: string; count: number }>(
      `SELECT p.stage, count(*)::int AS count FROM ${from} WHERE ${where} GROUP BY p.stage`,
      params,
    )
  ).rows;
  return {
    items,
    total: groups.reduce((n, g) => n + g.count, 0),
    groups: Object.fromEntries(groups.map((g) => [g.stage, g.count])),
    page: q.page,
    page_size: 30,
  };
}
