import type { DemoFixture } from './types';

export const demoAccounts = [
  {
    key: 'boss',
    title: '老板',
    name: '林然',
    email: 'lin@typha-demo.invalid',
    summary: '查看全量客户和团队授权',
  },
  {
    key: 'export',
    title: '外贸业务员',
    name: '许舟',
    email: 'export@typha-demo.invalid',
    summary: '跟进获授权的海外客户',
  },
  {
    key: 'domestic',
    title: '国内业务员',
    name: '顾桐',
    email: 'domestic@typha-demo.invalid',
    summary: '跟进获授权的国内客户',
  },
  {
    key: 'designer',
    title: '设计师',
    name: '程禾',
    email: 'design@typha-demo.invalid',
    summary: '处理交接任务与提交尺码表',
  },
] as const;
export type DemoAccount = (typeof demoAccounts)[number]['key'];
type SalesAccount = 'export' | 'domestic';
type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const items = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);

const accountIds = {
  export: '13a092ca-30ab-435b-b356-2b2a920e9074',
  domestic: '952951ce-b623-4cd3-b3ef-c045c827931b',
  designer: '52c86b73-1afc-4d4a-b60b-7b88caf6b9d3',
};

const assignedCustomers = {
  export: ['25136b14-9116-4f65-805c-a99e6ffb2b76', 'fef605eb-13a6-4d93-b611-b659099b2210'],
  domestic: [
    '8410e8c9-09bf-44ad-9b1f-0fd7b8ee7c00',
    '813d1832-2aaa-4895-a913-834c703106d5',
    'c6d9a85e-47c6-4ea1-ba38-8e291c4a943f',
    '861585b6-49a1-41bc-b4fb-c2c9a3892ac9',
  ],
};

export function actorId(fixture: DemoFixture, account: DemoAccount) {
  return account === 'boss' ? fixture.actorId : accountIds[account];
}

export function demoMembers(fixture: DemoFixture) {
  return demoAccounts.map((account) => ({
    actor_id: actorId(fixture, account.key),
    display_name: account.name,
    email: account.email,
    role: account.key === 'boss' ? ('admin' as const) : ('member' as const),
    active: true,
    workspace_mode: account.key === 'designer' ? ('tasks' as const) : ('crm' as const),
  }));
}

export function demoSession(fixture: DemoFixture, account: DemoAccount) {
  const member = demoMembers(fixture).find((row) => row.actor_id === actorId(fixture, account))!;
  return {
    actor: { id: member.actor_id, display_name: member.display_name, email: member.email },
    workspaces: [
      {
        id: fixture.workspaceId,
        name: 'Typha 示例工作空间',
        role: member.role,
        workspace_mode: member.workspace_mode,
      },
    ],
    auth_mode: 'password',
  };
}

export function customerGrants(fixture: DemoFixture, id: string) {
  return (['export', 'domestic'] as const)
    .filter((account) => assignedCustomers[account].includes(id))
    .map((account) => ({ actor_id: actorId(fixture, account), access: 'editor' }));
}

const sharedSnapshots = new Set([
  '/activity-schemas',
  '/activity-types',
  '/agent/capabilities',
  '/attributes',
  '/custom-objects',
  '/entity-schema',
  '/lists',
  '/mail/accounts',
  '/note-templates',
  '/reports/activity-analysis/catalog',
  '/views',
]);

export function demoFixtureForAccount(fixture: DemoFixture, account: SalesAccount): DemoFixture {
  const id = actorId(fixture, account);
  const permitted = (value: unknown) =>
    typeof value === 'string' && assignedCustomers[account].includes(value);
  const owns = (row: Row) => permitted(row.customer_id);
  const ownedRow = (row: Row): Row => ({
    ...row,
    ...(row.owner_id === fixture.actorId && { owner_id: id }),
    ...(row.assignee_id === fixture.actorId && { assignee_id: id }),
  });
  const filterRows = (value: unknown) => items(value).filter(owns).map(ownedRow);
  const scopedSnapshots: Record<string, unknown> = {};
  const snapshots = fixture.snapshots;
  const knownResource = (resource: string, id: string) =>
    resource === 'customers' ? permitted(id) : owns(object(snapshots[`/${resource}/${id}`]));
  for (const [key, value] of Object.entries(snapshots)) {
    const url = new URL(key, 'https://demo.invalid');
    const path = url.pathname;
    const customer = url.searchParams.get('customer_id');
    const resource = path.match(
      /^\/(customers|people|projects|activities|notes|mail\/messages)\/([^/]+)(?:\/|$)/,
    );
    const relation = path.match(/^\/relationships\/records\/(customers|people|projects)\/([^/]+)/);
    if (customer && !permitted(customer)) continue;
    if (
      (resource && knownResource(resource[1], resource[2])) ||
      (relation && knownResource(relation[1], relation[2]))
    ) {
      scopedSnapshots[key] = ownedRow(object(value));
      if (Array.isArray(value)) scopedSnapshots[key] = value;
      continue;
    }
    if (resource || relation) continue;
    if (path === '/customers') {
      const selected = items(object(value).items)
        .filter((row) => permitted(row.id))
        .map(ownedRow);
      scopedSnapshots[key] = { ...object(value), items: selected, total: selected.length };
    } else if (
      ['/people', '/projects', '/mail/messages', '/mail/notifications', '/activities'].includes(
        path,
      )
    ) {
      const selected = filterRows(object(value).items);
      scopedSnapshots[key] = {
        ...object(value),
        items: selected,
        total: selected.length,
        unread: selected.filter((row) => row.unread).length,
        pending: 0,
      };
    } else if (['/tasks', '/attributes/customer-values'].includes(path)) {
      scopedSnapshots[key] = filterRows(value);
    } else if (path === '/notes') {
      const selected = filterRows(object(value).notes);
      scopedSnapshots[key] = {
        ...object(value),
        notes: selected,
        drafts: [],
        total: selected.length,
        has_more: false,
      };
    } else if (path === '/documents') {
      scopedSnapshots[key] = { files: filterRows(object(value).files) };
    } else if (path === '/home/overview') {
      const selected = filterRows(object(value).items).filter((row) => row.kind === 'mail');
      scopedSnapshots[key] = {
        items: selected,
        total: selected.length,
        counts: {
          mail: selected.length,
          draft: 0,
          outgoing_issue: 0,
          document: 0,
          wechat: 0,
          workflow: 0,
        },
      };
    } else if (path === '/reports/catalog') {
      scopedSnapshots[key] = {
        ...object(value),
        customers: items(object(value).customers).filter((row) => permitted(row.id)),
      };
    } else if (
      path === '/reports/dashboards' ||
      path === '/chats' ||
      path === '/agent/preferences'
    ) {
      scopedSnapshots[key] = [];
    } else if (path === '/prospects' || path === '/prospects/tasks') {
      scopedSnapshots[key] = { items: [], total: 0, page: 1, page_size: 30 };
    } else if (path === '/relationships') {
      scopedSnapshots[key] = [];
    } else if (path === '/chats/page') {
      scopedSnapshots[key] = { items: [], next_cursor: null };
    } else if (
      sharedSnapshots.has(path) ||
      (customer && ['/activity-members', '/activity-sources'].includes(path))
    ) {
      scopedSnapshots[key] = value;
    }
  }
  const analysisRows = fixture.analysisAll.rows.filter((row) => permitted(row.customer_id));
  return {
    ...fixture,
    actorId: id,
    snapshots: scopedSnapshots,
    analysisAll: {
      ...fixture.analysisAll,
      rows: analysisRows,
      coverage: {
        ...fixture.analysisAll.coverage,
        scanned_count: new Set(analysisRows.flatMap((row) => row.merged_ids)).size,
        invalid_source_count: 0,
      },
    },
    analysisGolden: [],
  };
}
