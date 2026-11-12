import { listConfigSchema } from './list-validation.js';
import { filterGroup, validateFilters } from './filters.js';
import { z } from 'zod';
import {
  customerColumns,
  projectColumns,
  customerSorts,
  projectSorts,
  personColumns,
  personSorts,
} from '../shared/views.js';

const name = z.string().trim().min(1, '名称不能为空').max(120);
const text = z.string().trim().max(200);
export const uuid = z.uuid();
const email = z.union([z.email().max(254), z.literal('')]);
const customerFields = {
  name,
  type: z.enum(['distributor', 'group', 'retail']),
  source: z.enum(['email', 'taobao', 'douyin', 'store', 'referral', 'other']),
  region: text,
  contact_name: text,
  email,
  phone: z.string().trim().max(60),
  status: z.enum(['potential', 'active', 'paused']),
  owner_id: uuid.nullable(),
};
export const customerCreate = z.strictObject({
  ...customerFields,
  region: text.default(''),
  contact_name: text.default(''),
  email: email.default(''),
  phone: customerFields.phone.default(''),
  status: customerFields.status.default('potential'),
  owner_id: uuid.nullable().default(null),
});
export const customerUpdate = z
  .strictObject({
    ...z.object(customerFields).partial().shape,
    archived: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .refine((data) => Object.keys(data).length > 1, '请提供需要修改的字段');
const date = z.iso.date().nullable();
const projectFields = {
  name,
  type: z.enum(['inquiry', 'sample', 'custom', 'purchase']),
  stage: z.enum(['new', 'in_progress', 'waiting_customer', 'completed', 'cancelled']),
  description: z.string().trim().max(5000),
  due_date: date,
  owner_id: uuid.nullable(),
};
export const projectCreate = z.strictObject({
  ...projectFields,
  stage: projectFields.stage.default('new'),
  description: projectFields.description.default(''),
  due_date: date.default(null),
  owner_id: uuid.nullable().default(null),
});
export const projectUpdate = z
  .strictObject({
    ...z.object(projectFields).partial().shape,
    archived: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .refine((data) => Object.keys(data).length > 1, '请提供需要修改的字段');
export const recordCreate = z.strictObject({
  project_id: uuid.nullable().default(null),
  kind: z.enum(['customer_quote', 'inference', 'company_confirmed']),
  body: z.string().trim().min(1).max(10000),
});
export const customerQuery = z.strictObject({
  list_id: uuid.optional(),
  filters: z.string().max(12000).optional(),
  q: z.string().trim().max(100).default(''),
  type: customerFields.type.optional(),
  status: customerFields.status.optional(),
  source: customerFields.source.optional(),
  owner: z.union([uuid, z.enum(['me', 'unassigned'])]).optional(),
  region: text.optional(),
  sort: z.enum(Object.keys(customerSorts)).default('updated_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  editable: z.enum(['true', 'false']).default('false'),
  archived: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
export const projectQuery = z.strictObject({
  list_id: uuid.optional(),
  filters: z.string().max(12000).optional(),
  q: customerQuery.shape.q,
  type: projectFields.type.optional(),
  stage: projectFields.stage.optional(),
  owner: customerQuery.shape.owner,
  sort: z.enum(Object.keys(projectSorts)).default('updated_at'),
  direction: customerQuery.shape.direction,
  archived: customerQuery.shape.archived,
  page: customerQuery.shape.page,
});
const viewConfig = z.strictObject({
  query: z.string().trim().max(100),
  type: z.string().max(40),
  status: z.string().max(40),
  source: z.string().max(40),
  owner: z.union([uuid, z.enum(['', 'me', 'unassigned'])]),
  region: text,
  archived: z.boolean(),
  sort: z.string().max(40),
  direction: z.enum(['asc', 'desc']),
  layout: z.enum(['list', 'board']),
  filters: filterGroup.optional(),
  list_config: listConfigSchema.optional(),
  columns: z.array(z.string().max(50)).min(1).max(20),
});
export const viewInput = z
  .strictObject({
    object: z.enum(['customers', 'projects', 'people']),
    list_id: uuid.nullable().optional(),
    name: z.string().trim().min(1).max(80),
    config: viewConfig,
  })
  .superRefine((value, ctx) => {
    const c = value.config;
    if (c.filters) {
      try {
        validateFilters(c.filters, value.object);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['config', 'filters'], message: '筛选条件不受支持' });
      }
    }
    const customer = value.object === 'customers';
    const columns = customer
      ? customerColumns
      : value.object === 'people'
        ? personColumns
        : projectColumns;
    const sorts = customer ? customerSorts : value.object === 'people' ? personSorts : projectSorts;
    const allowed = (field: string, valid: boolean) => {
      if (!valid)
        ctx.addIssue({ code: 'custom', path: ['config', field], message: '视图配置不受支持' });
    };
    allowed(
      'columns',
      c.columns[0] === 'name' &&
        new Set(c.columns).size === c.columns.length &&
        c.columns.every(
          (k) =>
            Object.hasOwn(columns, k) ||
            (customer && !value.list_id && /^attr:[0-9a-f-]{36}$/.test(k)),
        ),
    );
    allowed('sort', Object.hasOwn(sorts, c.sort));
    allowed(
      'type',
      !c.type ||
        (value.object !== 'people' &&
          (customer ? customerFields.type : projectFields.type).safeParse(c.type).success),
    );
    allowed(
      'status',
      !c.status ||
        (value.object !== 'people' &&
          (customer ? customerFields.status : projectFields.stage).safeParse(c.status).success),
    );
    allowed('source', !c.source || (customer && customerFields.source.safeParse(c.source).success));
    allowed('region', customer || !c.region);
    allowed('list_config', !c.list_config || Boolean(value.list_id));
  });
export const viewUpdate = z.strictObject({
  ...viewInput.shape,
  version: z.number().int().positive(),
});
export const loginInput = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(256),
});
export const memberCreate = z.strictObject({
  email: loginInput.shape.email,
  display_name: name,
  password: z.string().min(12, '密码至少 12 位').max(256),
  workspace_mode: z.enum(['crm', 'tasks']).default('crm'),
});

const personFields = {
  name: z.string().trim().min(1).max(200),
  job_title: text,
  email,
  phone: z.string().trim().max(60),
  description: z.string().trim().max(5000),
};
export const personCreate = z.strictObject({
  ...personFields,
  customer_id: uuid,
  job_title: text.default(''),
  email: email.default(''),
  phone: personFields.phone.default(''),
  description: personFields.description.default(''),
});
export const personUpdate = z
  .strictObject({
    ...z.object(personFields).partial().shape,
    customer_name: name.optional(),
    customer_version: z.number().int().positive().optional(),
    archived: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .refine(
    (v) => (v.customer_name === undefined) === (v.customer_version === undefined),
    '修改公司名称时必须提供公司版本',
  )
  .refine((v) => Object.keys(v).length > 1, '请提供修改字段');
export const peopleQuery = z.strictObject({
  q: customerQuery.shape.q,
  list_id: uuid.optional(),
  customer_id: uuid.optional(),
  filters: customerQuery.shape.filters,
  sort: z.enum(Object.keys(personSorts)).default('updated_at'),
  direction: customerQuery.shape.direction,
  archived: customerQuery.shape.archived,
  page: customerQuery.shape.page,
  owner: customerQuery.shape.owner,
});
