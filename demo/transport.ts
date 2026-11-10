import { HttpError } from '../src/api';
import type {
  ActivityAnalysisBucket,
  ActivityAnalysisDimension,
  ActivityAnalysisInput,
  ActivityAnalysisResult,
  ActivityAnalysisRow,
} from '../shared/activity-analysis';
import {
  customerStatuses,
  customerTypes,
  projectStages,
  projectTypes,
  recordKinds,
  sources,
} from '../shared/domain';
import type { ReportQuery, ReportQueryResult } from '../shared/reports';
import type { FilterGroup } from '../shared/filters';
import { userPreferenceOptions, type UserPreferenceKey } from '../shared/user-preferences';
import { snapshotKey, type DemoFixture } from './types';

type Row = Record<string, unknown>;
export interface DemoRequestOptions {
  workspace?: string;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  keepalive?: boolean;
}
export const DEMO_UNAVAILABLE = '在线体验暂未开放此操作，可在本机使用完整功能';
const dimensions: ActivityAnalysisDimension[] = [
  'product',
  'issue',
  'version',
  'size',
  'color',
  'stage',
];
const copy = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => {
  const list = Array.isArray(value) ? value : object(value).items;
  return Array.isArray(list) ? list.map(object) : [];
};
const text = (value: unknown) => (value == null ? '' : String(value));
const unavailable = (): never => {
  throw new HttpError(DEMO_UNAVAILABLE, 403);
};
const invalid = (reason: string): never => {
  throw new HttpError(reason, 400);
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const day = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? dayFormat.format(new Date(value))
    : null;
const integer = (value: unknown, fallback: number, max: number, minimum = 1) => {
  if (value === undefined || value === null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > max) invalid('分页参数无效');
  return result;
};
function dateFilter(start: unknown, end: unknown) {
  for (const value of [start, end]) {
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value.startsWith('0000') ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    )
      invalid('日期无效');
  }
  if (typeof start === 'string' && typeof end === 'string' && start > end)
    invalid('开始日期不能晚于结束日期');
}
function collect(snapshots: Record<string, unknown>, kind: 'customers' | 'people' | 'projects') {
  const result = new Map<string, Row>();
  for (const [key, value] of Object.entries(snapshots)) {
    const pathname = new URL(key, 'https://demo.invalid').pathname;
    const list =
      pathname === `/${kind}` ||
      (kind === 'projects' && /^\/customers\/[^/]+\/projects$/.test(pathname));
    if (list)
      for (const item of rows(value))
        if (typeof item.id === 'string') result.set(item.id, copy(item));
    if (new RegExp(`^/${kind}/[^/]+$`).test(pathname) && typeof object(value).id === 'string')
      result.set(text(object(value).id), copy(object(value)));
  }
  return result;
}

export function createDemoTransport(fixture: DemoFixture) {
  const snapshots = copy(fixture.snapshots);
  const requests: { method: string; path: string; status: number }[] = [];
  let customers = collect(snapshots, 'customers');
  let people = collect(snapshots, 'people');
  let projects = collect(snapshots, 'projects');
  let tasks = new Map<string, Row>();
  let boards = new Map<string, Row>();
  let views = new Map<string, Row>();
  let preferences = new Map<string, Row>();
  let readMessages = new Set<string>();
  function reset() {
    customers = collect(snapshots, 'customers');
    people = collect(snapshots, 'people');
    projects = collect(snapshots, 'projects');
    tasks = new Map();
    boards = new Map();
    views = new Map();
    preferences = new Map(
      rows(snapshots['/agent/preferences']).map((value) => [text(value.id), copy(value)]),
    );
    readMessages = new Set();
    for (const [key, value] of Object.entries(snapshots)) {
      const pathname = new URL(key, 'https://demo.invalid').pathname;
      const target =
        pathname === '/tasks'
          ? tasks
          : pathname === '/reports/dashboards'
            ? boards
            : pathname === '/views'
              ? views
              : null;
      if (target)
        for (const item of rows(value))
          if (typeof item.id === 'string') target.set(item.id, copy(item));
    }
    requests.length = 0;
  }
  reset();
  const frozen = (path: string) => snapshots[snapshotKey(path)];
  const detail = (kind: 'customers' | 'people' | 'projects', id: string) => {
    const row = (kind === 'customers' ? customers : kind === 'people' ? people : projects).get(id);
    if (!row) throw new HttpError('示例记录不存在', 404);
    return row;
  };
  const customerName = (id: unknown) => text(customers.get(text(id))?.name);
  function activityRows() {
    const activities = new Map<string, Row>();
    for (const [key, value] of Object.entries(snapshots)) {
      const path = new URL(key, 'https://demo.invalid').pathname;
      if (path === '/activities')
        for (const item of rows(value)) activities.set(text(item.id), item);
      if (/^\/activities\/[^/]+$/.test(path) && object(value).id)
        activities.set(text(object(value).id), object(value));
    }
    return [...activities.values()];
  }
  function activityPage(query: URLSearchParams) {
    const customerId = query.get('customer_id') || '';
    detail('customers', customerId);
    for (const [parameter, kind] of [
      ['person_id', 'people'],
      ['project_id', 'projects'],
    ] as const) {
      const id = query.get(parameter);
      if (id && detail(kind, id).customer_id !== customerId)
        throw new HttpError('记录不属于当前示例客户', 404);
    }
    const limit = integer(query.get('limit'), 20, 50);
    let cursor: { created_at: string; id: string } | null = null;
    if (query.get('cursor')) {
      try {
        cursor = JSON.parse(atob(query.get('cursor')!.replaceAll('-', '+').replaceAll('_', '/')));
      } catch {
        invalid('分页位置无效');
      }
      if (
        !cursor ||
        typeof cursor.id !== 'string' ||
        !Number.isFinite(Date.parse(cursor.created_at))
      )
        invalid('分页位置无效');
    }
    const found = activityRows()
      .filter(
        (row) =>
          row.customer_id === customerId &&
          Boolean(row.archived) === (query.get('archived') === 'true') &&
          (!query.get('project_id') || row.project_id === query.get('project_id')) &&
          (!query.get('type_id') || row.type_id === query.get('type_id')) &&
          (!query.get('handler_id') || row.handler_id === query.get('handler_id')) &&
          (!query.get('person_id') ||
            (Array.isArray(row.linked_person_ids) &&
              row.linked_person_ids.includes(query.get('person_id')))) &&
          (!cursor ||
            Date.parse(text(row.created_at)) < Date.parse(cursor.created_at) ||
            (Date.parse(text(row.created_at)) === Date.parse(cursor.created_at) &&
              text(row.id) < cursor.id)),
      )
      .sort(
        (a, b) =>
          Date.parse(text(b.created_at)) - Date.parse(text(a.created_at)) ||
          text(b.id).localeCompare(text(a.id)),
      );
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page,
      next_cursor:
        found.length > limit && last
          ? btoa(
              JSON.stringify({
                created_at: new Date(text(last.created_at)).toISOString(),
                id: last.id,
              }),
            )
              .replaceAll('+', '-')
              .replaceAll('/', '_')
              .replace(/=+$/, '')
          : null,
    };
  }
  function scopedSources(customerId: string, query: URLSearchParams) {
    detail('customers', customerId);
    for (const [parameter, kind] of [
      ['person_id', 'people'],
      ['project_id', 'projects'],
    ] as const) {
      const id = query.get(parameter);
      if (id && detail(kind, id).customer_id !== customerId)
        throw new HttpError('资料不属于当前示例客户', 404);
    }
    const all = new Map<string, Row>();
    for (const [key, value] of Object.entries(snapshots)) {
      if (!key.startsWith(`/customers/${customerId}/records/`) || !key.endsWith('/evidence'))
        continue;
      for (const source of rows(object(value).sources)) {
        if (query.get('project_id') && source.project_id !== query.get('project_id')) continue;
        if (
          query.get('person_id') &&
          (!Array.isArray(source.person_ids) || !source.person_ids.includes(query.get('person_id')))
        )
          continue;
        all.set(text(source.id), source);
      }
    }
    return [...all.values()];
  }
  function mailRows() {
    const result = new Map<string, Row>();
    for (const [key, value] of Object.entries(snapshots)) {
      const path = new URL(key, 'https://demo.invalid').pathname;
      const found =
        path === '/mail/messages'
          ? rows(value)
          : /^\/mail\/messages\/[^/]+$/.test(path)
            ? [object(value)]
            : [];
      for (const row of found)
        if (row.id) result.set(text(row.id), { ...result.get(text(row.id)), ...row });
    }
    return [...result.values()].map(
      (row) =>
        ({
          ...row,
          customer_name: customerName(row.customer_id) || row.customer_name,
          unread: readMessages.has(text(row.id)) ? false : row.unread,
        }) as Row,
    );
  }
  function mailPage(query: URLSearchParams) {
    if (query.get('customer_id')) detail('customers', query.get('customer_id')!);
    const q = (query.get('q') || '').toLocaleLowerCase();
    const pending = query.get('pending') || 'false';
    if (!['true', 'false', 'all'].includes(pending)) invalid('邮件范围无效');
    const found = mailRows()
      .filter(
        (mail) =>
          (pending === 'all' || Boolean(mail.customer_id) === (pending === 'false')) &&
          (!query.get('customer_id') || mail.customer_id === query.get('customer_id')) &&
          (!query.get('project_id') || mail.project_id === query.get('project_id')) &&
          (!query.get('person_id') ||
            rows(mail.people).some((person) => person.id === query.get('person_id'))) &&
          [
            mail.subject,
            ...rows(mail.sender).flatMap((sender) => [sender.name, sender.address]),
            ...rows(mail.recipients).flatMap((recipient) => [recipient.name, recipient.address]),
          ]
            .map(text)
            .join(' ')
            .toLocaleLowerCase()
            .includes(q),
      )
      .sort(
        (a, b) =>
          Date.parse(text(b.occurred_at)) - Date.parse(text(a.occurred_at)) ||
          text(a.id).localeCompare(text(b.id)),
      );
    const page = integer(query.get('page'), 1, 100000);
    return {
      items: found.slice((page - 1) * 30, page * 30),
      total: found.length,
      page,
      last_inbound: found.find((row) => row.direction === 'inbound')?.occurred_at || null,
      last_outbound: found.find((row) => row.direction === 'outbound')?.occurred_at || null,
    };
  }
  function askEvidence(body: Row) {
    const scope = object(body.scope);
    if (
      scope.kind !== 'entity' ||
      !['customers', 'people', 'projects'].includes(text(scope.object))
    )
      invalid('请先打开具体示例实体');
    const customerId = text(scope.customer_id);
    detail('customers', customerId);
    if (scope.object === 'customers' && scope.record_id !== customerId)
      throw new HttpError('示例实体范围不匹配', 404);
    if (
      scope.object !== 'customers' &&
      detail(scope.object as 'people' | 'projects', text(scope.record_id)).customer_id !==
        customerId
    )
      throw new HttpError('示例实体不属于当前客户', 404);
    const format = (value: unknown) =>
      new Date(text(value)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    if (body.kind === 'record') {
      const evidence = object(frozen(`/customers/${customerId}/records/${text(body.id)}/evidence`));
      const record = object(evidence.record);
      const sourceList = rows(evidence.sources);
      if (
        !record.id ||
        record.customer_id !== customerId ||
        (scope.object === 'projects' && record.project_id !== scope.record_id) ||
        (scope.object === 'people' &&
          !sourceList.some(
            (source) =>
              Array.isArray(source.person_ids) && source.person_ids.includes(scope.record_id),
          ))
      )
        throw new HttpError('记录不存在或不属于当前示例实体', 404);
      const originals = sourceList
        .map(
          (source) =>
            `${text(source.speaker)} · ${format(source.occurred_at)}\n${text(source.body)}`,
        )
        .join('\n\n');
      const facts = rows(evidence.facts)
        .map(
          (fact) =>
            `${fact.invalid_at ? '历史候选，截至' + format(fact.invalid_at) : '当前候选'}：${text(fact.fact)}`,
        )
        .join('\n');
      return {
        title: recordKinds[record.kind as keyof typeof recordKinds] || '业务记录',
        body: `${format(record.occurred_at || record.created_at)}\n\n${text(record.body)}${originals ? '\n\n原始依据：\n' + originals : ''}${facts ? '\n\n以下信息由同一条记录提取，不是独立证据或新增公司确认：\n' + facts : ''}`,
      };
    }
    if (body.kind === 'mail') {
      const mail = object(frozen(`/mail/messages/${text(body.id)}`));
      if (
        !mail.id ||
        mail.customer_id !== customerId ||
        (scope.object === 'projects' && mail.project_id !== scope.record_id) ||
        (scope.object === 'people' &&
          !rows(mail.people).some((person) => person.id === scope.record_id))
      )
        throw new HttpError('邮件不存在或不属于当前示例实体', 404);
      return {
        title: text(mail.subject) || '（无主题）',
        body: `${format(mail.occurred_at)}\n发件人：${rows(mail.sender)
          .map((sender) => text(sender.address))
          .join(', ')}\n\n${text(mail.body || mail.preview)}`,
      };
    }
    return invalid('原文类型无效');
  }
  function entityRows(kind: 'customers' | 'people' | 'projects'): Row[] {
    return [
      ...(kind === 'customers' ? customers : kind === 'people' ? people : projects).values(),
    ].map((item) =>
      kind === 'customers'
        ? {
            ...item,
            project_count: [...projects.values()].filter(
              (p) => p.customer_id === item.id && !p.archived_at,
            ).length,
          }
        : {
            ...item,
            customer_name: customerName(item.customer_id),
            ...(kind === 'people'
              ? { owner_id: customers.get(text(item.customer_id))?.owner_id ?? null }
              : {}),
          },
    );
  }
  function valueFor(item: Row, field: string) {
    if (field === 'contact') return item.contact_name;
    if (field === 'owner') return item.owner_id;
    if (!(field in item)) invalid('此筛选字段不在示例资料中');
    return item[field];
  }
  function matchAdvanced(item: Row, group: FilterGroup) {
    if (
      !['all', 'any'].includes(group.match) ||
      !Array.isArray(group.rules) ||
      group.rules.length > 50
    )
      invalid('筛选条件无效');
    const values = group.rules.map((rule) => {
      const value = valueFor(item, rule.field);
      const current = text(value).toLocaleLowerCase();
      const expected = text(rule.value === 'me' ? fixture.actorId : rule.value).toLocaleLowerCase();
      const empty = value === undefined || value === null || value === '';
      switch (rule.operator) {
        case 'empty':
          return empty;
        case 'not_empty':
          return !empty;
        case 'is':
          return (
            current === expected ||
            (/^\d{4}-\d{2}-\d{2}$/.test(expected) && day(value) === expected)
          );
        case 'is_not':
          return current !== expected;
        case 'contains':
          return current.includes(expected);
        case 'not_contains':
          return !current.includes(expected);
        case 'before':
          return !empty && current < expected;
        case 'after':
          return !empty && current > expected;
        default:
          return invalid('此筛选方式暂不支持');
      }
    });
    return group.match === 'all' ? values.every(Boolean) : values.some(Boolean);
  }
  function list(kind: 'customers' | 'people' | 'projects', query: URLSearchParams) {
    if (query.get('list_id')) unavailable();
    const q = (query.get('q') || '').toLocaleLowerCase();
    const owner = query.get('owner') === 'me' ? fixture.actorId : query.get('owner');
    let advanced: FilterGroup | undefined;
    if (query.get('filters')) {
      try {
        advanced = JSON.parse(query.get('filters')!);
      } catch {
        invalid('筛选条件无效');
      }
    }
    const items = entityRows(kind).filter((item) => {
      const archived = Boolean(
        item.archived_at ||
        (kind !== 'customers' && customers.get(text(item.customer_id))?.archived_at),
      );
      const search =
        kind === 'customers'
          ? [item.name, item.contact_name, item.email]
          : kind === 'projects'
            ? [item.name, item.customer_name]
            : [item.name, item.email, item.job_title, item.customer_name];
      if (
        archived !== (query.get('archived') === 'true') ||
        !search.map(text).join(' ').toLocaleLowerCase().includes(q)
      )
        return false;
      if (query.get('customer_id') && item.customer_id !== query.get('customer_id')) return false;
      for (const field of ['type', 'status', 'stage', 'source'])
        if (query.get(field) && item[field] !== query.get(field)) return false;
      if (
        query.get('region') &&
        !text(item.region).toLocaleLowerCase().includes(query.get('region')!.toLocaleLowerCase())
      )
        return false;
      if (owner === 'unassigned' ? Boolean(item.owner_id) : owner && item.owner_id !== owner)
        return false;
      if (query.get('editable') === 'true' && item.can_edit !== true) return false;
      return !advanced || matchAdvanced(item, advanced);
    });
    const sort = query.get('sort') || 'updated_at';
    const direction = query.get('direction') === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const left = valueFor(a, sort),
        right = valueFor(b, sort);
      if (left == null && right != null) return 1;
      if (right == null && left != null) return -1;
      const comparison =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : text(left).localeCompare(text(right));
      return direction * comparison || text(a.id).localeCompare(text(b.id));
    });
    const groups: Record<string, number> = {};
    for (const item of items) {
      const key = text(
        kind === 'people' ? item.is_primary : kind === 'projects' ? item.stage : item.status,
      );
      groups[key] = (groups[key] || 0) + 1;
    }
    const page = integer(query.get('page'), 1, 100000);
    return {
      items: items.slice((page - 1) * 30, page * 30),
      total: items.length,
      page,
      page_size: 30,
      groups,
      ...(kind === 'customers'
        ? {
            summary: {
              customers: [...customers.values()].filter((c) => !c.archived_at).length,
              active_customers: [...customers.values()].filter(
                (c) => !c.archived_at && c.status === 'active',
              ).length,
              open_projects: [...projects.values()].filter(
                (p) =>
                  !p.archived_at &&
                  !customers.get(text(p.customer_id))?.archived_at &&
                  !['completed', 'cancelled'].includes(text(p.stage)),
              ).length,
            },
          }
        : {}),
    };
  }
  function validateAnalysis(input: ActivityAnalysisInput) {
    if (!input || canonical(input.config) !== canonical(fixture.analysisConfig))
      invalid('在线体验使用预设反馈字段映射，请恢复示例配置；本机版本可配置其他字段');
    for (const dimension of dimensions)
      if (
        input[dimension] !== undefined &&
        (!fixture.analysisConfig.fields[dimension] || typeof input[dimension] !== 'string')
      )
        invalid('反馈筛选维度无效');
    dateFilter(input.startDate, input.endDate);
    if (input.customerId && !customers.has(input.customerId))
      throw new HttpError('示例客户不存在', 404);
    if (input.customerType && !(input.customerType in customerTypes)) invalid('客户类型无效');
  }
  function analysis(raw: unknown): ActivityAnalysisResult {
    const input = raw as ActivityAnalysisInput;
    validateAnalysis(input);
    const offset = integer(input.offset, 0, 10000000, 0),
      limit = integer(input.limit, 20, 100);
    const scoped = fixture.analysisAll.rows.filter(
      (row) =>
        (!input.customerId || row.customer_id === input.customerId) &&
        (!input.customerType || customers.get(row.customer_id)?.type === input.customerType),
    );
    const matched = scoped
      .filter((row) => {
        const occurred = day(row.occurred_at);
        if (
          (input.startDate || input.endDate) &&
          (!occurred ||
            (input.startDate && occurred < input.startDate) ||
            (input.endDate && occurred > input.endDate))
        )
          return false;
        return dimensions.every(
          (dimension) =>
            input[dimension] === undefined ||
            (dimension === 'issue'
              ? row.issues.includes(input.issue!)
              : row[dimension] === input[dimension]),
        );
      })
      .sort(
        (a, b) =>
          (b.occurred_at ? Date.parse(b.occurred_at) : -Infinity) -
            (a.occurred_at ? Date.parse(a.occurred_at) : -Infinity) || a.id.localeCompare(b.id),
      );
    const valid = matched.filter((row) => !row.review_required);
    const originalIds = (data: ActivityAnalysisRow[]) => [
      ...new Set(data.flatMap((row) => row.merged_ids)),
    ];
    const sourceKeys = (data: ActivityAnalysisRow[]) =>
      new Set(originalIds(data).flatMap((id) => fixture.sourceKeysByActivity[id] || []));
    const groups = Object.fromEntries(
      dimensions.map((dimension) => {
        const buckets = new Map<string | null, { count: number; customers: Set<string> }>();
        if (fixture.analysisConfig.fields[dimension])
          for (const row of valid)
            for (const value of dimension === 'issue'
              ? row.issues.length
                ? row.issues
                : [null]
              : [row[dimension]]) {
              const bucket = buckets.get(value) || { count: 0, customers: new Set<string>() };
              bucket.count++;
              bucket.customers.add(row.customer_id);
              buckets.set(value, bucket);
            }
        return [
          dimension,
          [...buckets]
            .map(([key, bucket]): ActivityAnalysisBucket => ({
              key,
              label: key ?? '未填写',
              feedback_count: bucket.count,
              customer_count: bucket.customers.size,
            }))
            .sort(
              (a, b) =>
                b.feedback_count - a.feedback_count || (a.key || '').localeCompare(b.key || ''),
            ),
        ];
      }),
    ) as ActivityAnalysisResult['groups'];
    const originals = originalIds(scoped).map((id) => object(frozen(`/activities/${id}`)));
    const unknownDates = originals.filter((activity) => !activity.occurred_at).length;
    return {
      summary: {
        feedback_count: valid.length,
        customer_count: new Set(valid.map((r) => r.customer_id)).size,
        activity_count: originalIds(valid).length,
        source_count: sourceKeys(valid).size,
      },
      groups,
      coverage: {
        ...fixture.analysisAll.coverage,
        scanned_count:
          input.customerId || input.customerType
            ? originals.length
            : fixture.analysisAll.coverage.scanned_count,
        invalid_source_count:
          input.customerId || input.customerType
            ? 0
            : fixture.analysisAll.coverage.invalid_source_count,
        unknown_date_count: unknownDates,
        unknown_date_excluded_count:
          input.startDate || input.endDate
            ? scoped.filter((r) => !r.occurred_at).reduce((sum, r) => sum + r.merged_ids.length, 0)
            : 0,
        pending_review_count: matched.filter((r) => r.review_required).length,
        duplicate_activity_count: valid.reduce((sum, r) => sum + r.merged_ids.length - 1, 0),
        missing_values: Object.fromEntries(
          dimensions
            .filter((dimension) => fixture.analysisConfig.fields[dimension])
            .map((dimension) => [
              dimension,
              valid.filter((r) =>
                dimension === 'issue' ? !r.issues.length : r[dimension] === null,
              ).length,
            ]),
        ),
      },
      rows: matched.slice(offset, offset + limit).map((row) => ({
        ...row,
        customer_name: customerName(row.customer_id) || row.customer_name,
      })),
      total: matched.length,
      offset,
      limit,
    };
  }
  function updateVersion(current: Row, body: Row) {
    if (body.version !== current.version) throw new HttpError('示例记录已修改，请刷新后重试', 409);
  }
  function reportConfig(body: Row) {
    if (body.activity_analysis != null)
      validateAnalysis({ config: body.activity_analysis } as ActivityAnalysisInput);
    if (
      !Array.isArray(body.widgets) ||
      body.widgets.length > 24 ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.length > 80
    )
      invalid('看板名称或图表配置无效');
    return {
      name: text(body.name).trim(),
      description: text(body.description),
      widgets: copy(body.widgets),
      activity_analysis: body.activity_analysis ?? null,
    };
  }
  function genericReport(raw: unknown): ReportQueryResult {
    const input = object(raw) as unknown as ReportQuery;
    if (!['count', 'distinct_customers'].includes(input.metric))
      invalid('在线体验提供记录数与去重客户数，其他指标可在本机配置后使用');
    dateFilter(input.startDate, input.endDate);
    let data: Row[];
    if (input.source === 'companies')
      data = entityRows('customers').map((r) => ({
        ...r,
        customer_id: r.id,
        customer_name: r.name,
        project_id: null,
        person_id: null,
        date: r.created_at,
      }));
    else if (input.source === 'people')
      data = entityRows('people').map((r) => ({
        ...r,
        person_id: r.id,
        project_id: null,
        date: r.created_at,
      }));
    else if (input.source === 'projects')
      data = entityRows('projects').map((r) => ({
        ...r,
        project_id: r.id,
        person_id: null,
        date: r.created_at,
      }));
    else if (input.source === 'activities')
      data = Object.entries(snapshots)
        .filter(([k]) => /^\/activities\/[^/?]+$/.test(k))
        .map(([, v]) => object(v))
        .map((r) => ({
          ...r,
          name: r.title,
          type: r.type_name,
          handler: r.handler_id,
          date: r.occurred_at || r.created_at,
          customer_name: customerName(r.customer_id),
          person_id: null,
        }));
    else if (input.source === 'records')
      data = Object.entries(snapshots)
        .filter(([k]) => /^\/customers\/[^/]+\/records$/.test(k))
        .flatMap(([, v]) => rows(v))
        .map((r) => ({
          ...r,
          name: recordKinds[r.kind as keyof typeof recordKinds] || '业务记录',
          source: r.source_kind || 'manual',
          date: r.occurred_at || r.created_at,
          customer_name: customerName(r.customer_id),
          person_id: null,
        }));
    else return invalid('在线体验暂未提供这个报告数据源，可在本机使用完整功能');
    const mapped: Record<string, Record<string, string>> = {
      type: input.source === 'projects' ? projectTypes : customerTypes,
      status: customerStatuses,
      stage: projectStages,
      kind: recordKinds,
      source:
        input.source === 'records'
          ? {
              manual: '人工记录',
              email: '邮件',
              wechat: '微信',
              document: '文档',
              note: '内部笔记',
            }
          : sources,
      customer: Object.fromEntries([...customers.values()].map((r) => [text(r.id), text(r.name)])),
      customer_type: customerTypes,
      owner: Object.fromEntries(
        rows(frozen('/members')).map((r) => [text(r.actor_id), text(r.display_name)]),
      ),
      is_primary: { true: '是', false: '否' },
    };
    const all = data
      .filter(
        (r) =>
          !r.archived_at &&
          !customers.get(text(r.customer_id))?.archived_at &&
          (!input.customerId || r.customer_id === input.customerId) &&
          (!input.customerType ||
            customers.get(text(r.customer_id))?.type === input.customerType) &&
          (!input.startDate || (day(r.date) !== null && day(r.date)! >= input.startDate)) &&
          (!input.endDate || (day(r.date) !== null && day(r.date)! <= input.endDate)),
      )
      .map((r): Row & { key: string } => {
        const value =
          input.groupBy === 'none'
            ? '全部'
            : input.groupBy === 'month'
              ? day(r.date)?.slice(0, 7)
              : input.groupBy === 'customer'
                ? r.customer_id
                : input.groupBy === 'customer_type'
                  ? customers.get(text(r.customer_id))?.type
                  : input.groupBy === 'owner'
                    ? r.owner_id
                    : r[input.groupBy];
        if (value === undefined && input.groupBy !== 'month')
          invalid('在线体验暂不支持这个分组字段');
        return { ...r, key: JSON.stringify(value == null || value === '' ? null : text(value)) };
      });
    const filtered =
      input.bucketKey === undefined ? all : all.filter((r) => r.key === input.bucketKey);
    const metric = (items: Row[]) =>
      input.metric === 'count' ? items.length : new Set(items.map((r) => r.customer_id)).size;
    const byKey = new Map<string, Row[]>();
    for (const r of filtered) byKey.set(r.key, [...(byKey.get(r.key) || []), r]);
    const buckets = [...byKey]
      .map(([key, items]) => {
        const value = JSON.parse(key);
        return {
          key,
          label: value === null ? '未填写' : mapped[input.groupBy]?.[value] || String(value),
          value: metric(items),
          count: items.length,
          customerCount: new Set(items.map((r) => r.customer_id)).size,
        };
      })
      .sort((a, b) =>
        input.groupBy === 'month'
          ? a.key.localeCompare(b.key)
          : (b.value || 0) - (a.value || 0) || a.key.localeCompare(b.key),
      );
    const offset = integer(input.offset, 0, 10000000, 0),
      limit = integer(input.limit, 20, 100);
    const source = object(frozen('/reports/catalog'));
    const dateLabel =
      text(
        (Array.isArray(source.sources) ? source.sources : [])
          .map(object)
          .find((s) => s.id === input.source)?.dateLabel,
      ) || '创建时间';
    return {
      value: metric(filtered),
      valueCount: filtered.length,
      total: filtered.length,
      customerCount: new Set(filtered.map((r) => r.customer_id)).size,
      buckets,
      rows: filtered
        .sort(
          (a, b) =>
            Date.parse(text(b.date)) - Date.parse(text(a.date)) ||
            text(b.id).localeCompare(text(a.id)),
        )
        .slice(offset, offset + limit)
        .map((r) => ({
          id: text(r.id),
          name: text(r.name),
          customer_id: text(r.customer_id),
          customer_name: customerName(r.customer_id),
          project_id: r.project_id ? text(r.project_id) : null,
          person_id: r.person_id ? text(r.person_id) : null,
          date: text(r.date),
        })),
      offset,
      limit,
      hasMore: offset + limit < filtered.length,
      dateLabel,
      generatedAt: new Date().toISOString(),
    };
  }
  function handle(url: URL, method: string, rawBody: unknown): unknown {
    const path = url.pathname,
      body = object(rawBody);
    if (
      /^\/(?:auth|outgoing|mail\/exclusions|wechat)(?:\/|$)/.test(path) ||
      (path.startsWith('/mail/accounts') && method !== 'GET') ||
      /\/(?:sync|generate|run|runs|send|schedule|confirm|cancel)(?:\/|$)/.test(path)
    )
      unavailable();
    if (method === 'GET' && path === '/agent/capabilities')
      return {
        ...object(frozen(path)),
        model: false,
        background_runs: false,
        can_manage: false,
        home_workflows: true,
        prospect_intake: false,
        web_research: false,
      };
    if (method === 'GET' && path === '/agent/preferences') return [...preferences.values()];
    const preference = path.match(/^\/agent\/preferences\/([^/]+)$/);
    if (preference && ['PATCH', 'DELETE'].includes(method)) {
      const current = preferences.get(preference[1]);
      if (!current) throw new HttpError('示例个人偏好不存在', 404);
      if (method === 'DELETE') {
        if (Object.keys(body).length) invalid('删除偏好不接受其他参数');
        preferences.delete(preference[1]);
        return { removed: true };
      }
      if (
        Object.keys(body).some((key) => !['value', 'expected_version'].includes(key)) ||
        typeof body.expected_version !== 'string' ||
        !/^[a-f\d]{32}$/.test(body.expected_version)
      )
        invalid('偏好版本无效，请重新加载');
      if (body.expected_version !== current.version)
        throw new HttpError('这条示例偏好已更新或删除，请重新加载', 409);
      const option = userPreferenceOptions[current.category as UserPreferenceKey]?.options.find(
        (option) => option.value === body.value,
      );
      if (!option) return invalid('请选择这类偏好支持的选项');
      const updated = {
        ...current,
        value: option.value,
        content: option.label,
        updated_at: new Date().toISOString(),
        version: crypto.randomUUID().replaceAll('-', ''),
      };
      preferences.set(preference[1], updated);
      return updated;
    }
    if (method === 'GET' && ['/customers', '/people', '/projects'].includes(path))
      return list(path.slice(1) as 'customers' | 'people' | 'projects', url.searchParams);
    if (method === 'GET' && path === '/activities') return activityPage(url.searchParams);
    if (method === 'POST' && path === '/ask/source') return askEvidence(body);
    const scopedStatus = path.match(
      /^\/customers\/([^/]+)\/(activity-status|knowledge(?:\/graph)?)$/,
    );
    if (
      method === 'GET' &&
      scopedStatus &&
      (url.searchParams.has('project_id') || url.searchParams.has('person_id'))
    ) {
      const material = scopedSources(scopedStatus[1], url.searchParams);
      const exact = frozen(snapshotKey(path + url.search));
      if (exact !== undefined) return exact;
      const captured = object(frozen(path));
      if (!Object.keys(captured).length) unavailable();
      if (scopedStatus[2] === 'activity-status') {
        if (rows(object(captured.graph).facts).length) unavailable();
        const originalCount = new Set(material.map((source) => source.record_id)).size;
        return {
          ...captured,
          originals: {
            ...object(captured.originals),
            record_count: originalCount,
            source_count: material.length,
          },
          vector: {
            ...object(captured.vector),
            record_count: originalCount,
            source_count: material.length,
          },
        };
      }
      if (rows(captured.facts).length || rows(captured.nodes).length || rows(captured.edges).length)
        unavailable();
      return captured;
    }
    if (method === 'GET' && path === '/mail/messages') return mailPage(url.searchParams);
    const readMail = path.match(/^\/mail\/messages\/([^/]+)\/read$/);
    if (method === 'POST' && readMail) {
      if (!mailRows().some((mail) => mail.id === readMail[1]))
        throw new HttpError('示例邮件不存在', 404);
      readMessages.add(readMail[1]);
      return { ok: true };
    }
    if (method === 'GET' && path === '/mail/tracking/summary')
      return { ...object(frozen(path)), unread: mailRows().filter((mail) => mail.unread).length };
    if (method === 'GET' && ['/prospects', '/prospects/tasks'].includes(path)) {
      const captured = object(frozen(path));
      if (!Array.isArray(captured.items) || captured.items.length) unavailable();
      return {
        ...captured,
        page: integer(url.searchParams.get('page'), 1, 100000),
        page_size: integer(
          url.searchParams.get('page_size'),
          Number(captured.page_size) || 30,
          100,
        ),
      };
    }
    const entity = path.match(/^\/(customers|people|projects)\/([^/]+)$/);
    if (entity && method === 'GET')
      return detail(entity[1] as 'customers' | 'people' | 'projects', entity[2]);
    if (entity && method === 'PATCH' && entity[1] === 'customers') {
      const current = detail('customers', entity[2]);
      updateVersion(current, body);
      const fields = [
        'name',
        'type',
        'source',
        'region',
        'contact_name',
        'email',
        'phone',
        'status',
        'owner_id',
      ];
      if (Object.keys(body).some((key) => key !== 'version' && !fields.includes(key)))
        invalid('在线体验只允许编辑已有客户基础字段');
      if (
        body.name !== undefined &&
        (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120)
      )
        invalid('客户名称无效');
      if (body.type !== undefined && !Object.hasOwn(customerTypes, text(body.type)))
        invalid('客户类型无效');
      if (body.status !== undefined && !Object.hasOwn(customerStatuses, text(body.status)))
        invalid('合作状态无效');
      if (body.source !== undefined && !Object.hasOwn(sources, text(body.source)))
        invalid('来源无效');
      if (
        body.owner_id !== undefined &&
        body.owner_id !== null &&
        body.owner_id !== fixture.actorId
      )
        invalid('请选择演示负责人');
      const next = {
        ...current,
        ...body,
        version: Number(current.version) + 1,
        updated_at: new Date().toISOString(),
      };
      customers.set(entity[2], next);
      return next;
    }
    const nestedProjects = path.match(/^\/customers\/([^/]+)\/projects$/);
    if (nestedProjects && method === 'GET')
      return entityRows('projects').filter((r) => r.customer_id === nestedProjects[1]);
    if (path === '/tasks' && method === 'GET')
      return [...tasks.values()].filter(
        (task) =>
          (!task.assignee_id || task.assignee_id === fixture.actorId) &&
          (!url.searchParams.get('status') || task.status === url.searchParams.get('status')),
      );
    const task = path.match(/^\/tasks\/([^/]+)$/);
    if (task && method === 'PATCH') {
      const current = tasks.get(task[1]);
      if (!current) throw new HttpError('示例待办不存在', 404);
      updateVersion(current, body);
      if (current.assignee_id !== fixture.actorId)
        throw new HttpError('只有被指派人可以处理示例待办', 403);
      if (current.status === 'completed') throw new HttpError('此示例待办已完成', 409);
      if (!['in_progress', 'completed'].includes(text(body.status))) invalid('待办状态无效');
      if (body.status === 'completed' && (typeof body.result !== 'string' || !body.result.trim()))
        invalid('完成待办请填写处理结果');
      const next = {
        ...current,
        status: body.status,
        result: body.status === 'completed' ? text(body.result).trim() : current.result,
        version: Number(current.version) + 1,
        updated_at: new Date().toISOString(),
      };
      tasks.set(task[1], next);
      return next;
    }
    if (path === '/attributes/customer-values' && method === 'POST') {
      if (!Array.isArray(body.customer_ids)) invalid('请选择示例客户');
      return rows(frozen(path)).filter((value) =>
        (body.customer_ids as unknown[]).includes(value.customer_id),
      );
    }
    if (path === '/reports/activity-analysis/query' && method === 'POST') return analysis(rawBody);
    if (path === '/reports/query' && method === 'POST') return genericReport(rawBody);
    if (path === '/reports/catalog' && method === 'GET')
      return {
        ...object(frozen(path)),
        customers: [...customers.values()]
          .filter((c) => !c.archived_at)
          .map((c) => ({ id: c.id, name: c.name })),
      };
    if (path === '/reports/dashboards' && method === 'GET') return [...boards.values()];
    if (path === '/reports/dashboards' && method === 'POST') {
      const data = reportConfig(body);
      const id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const board = { ...data, id, version: 1, created_at: timestamp, updated_at: timestamp };
      boards.set(id, board);
      return board;
    }
    const board = path.match(/^\/reports\/dashboards\/([^/]+)$/);
    if (board) {
      const current = boards.get(board[1]);
      if (!current) throw new HttpError('示例看板不存在', 404);
      if (method === 'GET') return current;
      if (method === 'PATCH') {
        updateVersion(current, body);
        const next = {
          ...current,
          ...reportConfig({ ...current, ...body }),
          version: Number(current.version) + 1,
          updated_at: new Date().toISOString(),
        };
        boards.set(board[1], next);
        return next;
      }
      if (method === 'DELETE') {
        updateVersion(current, body);
        boards.delete(board[1]);
        return { ok: true };
      }
    }
    if (path === '/views' && method === 'GET') return [...views.values()];
    if (path === '/views' && method === 'POST') {
      const id = crypto.randomUUID();
      const value = { ...body, id, version: 1 };
      views.set(id, value);
      return value;
    }
    const view = path.match(/^\/views\/([^/]+)$/);
    if (view) {
      const current = views.get(view[1]);
      if (!current) throw new HttpError('示例视图不存在', 404);
      if (method === 'PATCH') {
        updateVersion(current, body);
        const next = { ...current, ...body, id: view[1], version: Number(current.version) + 1 };
        views.set(view[1], next);
        return next;
      }
      if (method === 'DELETE') {
        updateVersion(current, body);
        views.delete(view[1]);
        return { ok: true };
      }
    }
    const activity = path.match(/^\/activities\/([^/]+)$/);
    if (activity && method === 'GET') {
      const result = object(frozen(path));
      if (!result.id) throw new HttpError('示例活动不存在', 404);
      return {
        ...result,
        can_edit: false,
        tasks: rows(result.tasks).map((task) => tasks.get(text(task.id)) || task),
      };
    }
    if (method === 'GET' && path === '/chats/page') {
      const pages = Object.entries(snapshots)
        .filter(([key]) => new URL(key, 'https://demo.invalid').pathname === path)
        .flatMap(([, value]) => rows(value));
      const unique = [...new Map(pages.map((chat) => [text(chat.id), chat])).values()];
      const q = (url.searchParams.get('q') || '').toLocaleLowerCase();
      return {
        items: url.searchParams.get('cursor')
          ? []
          : unique.filter((chat) => text(chat.title).toLocaleLowerCase().includes(q)),
        next_cursor: null,
      };
    }
    if (method === 'GET') {
      const exact = frozen(snapshotKey(path + url.search));
      if (exact !== undefined) return exact;
    }
    return unavailable();
  }
  async function request<T>(path: string, options: DemoRequestOptions = {}): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    if (options.signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (options.workspace && options.workspace !== fixture.workspaceId)
      throw new HttpError('此演示空间不可访问', 403);
    const url = new URL(path, 'https://demo.invalid');
    if (url.origin !== 'https://demo.invalid') return unavailable();
    await Promise.resolve();
    if (options.signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    try {
      const result = copy(handle(url, method, options.body));
      requests.push({ method, path: snapshotKey(path), status: 200 });
      if (requests.length > 500) requests.shift();
      return result as T;
    } catch (error) {
      requests.push({
        method,
        path: snapshotKey(path),
        status: error instanceof HttpError ? error.status : 500,
      });
      if (requests.length > 500) requests.shift();
      throw error;
    }
  }
  return { request, reset, requests };
}
