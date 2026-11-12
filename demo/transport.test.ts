import { afterEach, describe, expect, it, vi } from 'vitest';
import fixtureData from './fixture.json';
import type { DemoFixture } from './types';
import { snapshotKey } from './types';
import { createDemoTransport, DEMO_UNAVAILABLE } from './transport';
import { api, demoRuntime, isDemoRuntime, streamApi, watchApi } from './api';
import type { ActivityAnalysisResult } from '../shared/activity-analysis';
import type { ActivityTask } from '../shared/business-activities';
import type { Customer } from '../shared/domain';
import type { CustomerList } from '../shared/views';
import type { ReportDashboard, ReportQueryResult } from '../shared/reports';
import type { KnowledgeGraphView } from '../shared/knowledge';
import { userPreferenceOptions, type UserPreferenceSetting } from '../shared/user-preferences';

const fixture = fixtureData as DemoFixture;
afterEach(() => vi.unstubAllGlobals());

describe('static product transport', () => {
  it('returns the real captured session and keeps mutable browser state separate from fixtures', async () => {
    const transport = createDemoTransport(fixture);
    const session = await transport.request('/session');
    expect(session).toEqual(fixture.snapshots['/session']);
    expect(isDemoRuntime()).toBe(true);
    expect(snapshotKey('/customers?q=A&page=1')).toBe('/customers?page=1&q=A');
    const first = await transport.request<CustomerList>('/customers?sort=name&direction=asc');
    expect(first.total).toBe(6);
    first.items[0].name = 'Caller mutation';
    expect(
      (await transport.request<CustomerList>('/customers?sort=name&direction=asc')).items[0].name,
    ).not.toBe('Caller mutation');
  });

  it('implements real customer, people and project search, filters and sorting', async () => {
    const transport = createDemoTransport(fixture);
    const all = await transport.request<CustomerList>('/customers?sort=name&direction=asc');
    const selected = all.items.find((item) => item.type === 'distributor')!;
    const search = await transport.request<CustomerList>(
      `/customers?q=${encodeURIComponent(selected.name)}`,
    );
    expect(search.items.map((item) => item.id)).toEqual([selected.id]);
    const filtered = await transport.request<CustomerList>(
      '/customers?type=distributor&owner=me&sort=name&direction=desc',
    );
    expect(
      filtered.items.every(
        (item) => item.type === 'distributor' && item.owner_id === fixture.actorId,
      ),
    ).toBe(true);
    expect(filtered.total).toBe(filtered.items.length);
    expect((await transport.request<CustomerList>('/customers?archived=true')).total).toBe(0);
    const advanced = encodeURIComponent(
      JSON.stringify({
        match: 'all',
        rules: [{ field: 'name', operator: 'contains', value: selected.name }],
      }),
    );
    expect(
      (await transport.request<CustomerList>(`/customers?filters=${advanced}`)).items.map(
        (item) => item.id,
      ),
    ).toEqual([selected.id]);
    expect(
      (await transport.request<{ total: number }>(`/people?customer_id=${selected.id}`)).total,
    ).toBe(1);
    expect(
      (await transport.request<{ total: number }>(`/projects?customer_id=${selected.id}`)).total,
    ).toBe(1);
    expect((await transport.request<CustomerList>('/customers?page=2')).items).toEqual([]);
  });

  it('updates allowed customer fields in memory with version checks and supports reset', async () => {
    const transport = createDemoTransport(fixture);
    const original = (await transport.request<CustomerList>('/customers')).items[0];
    const path = `/customers/${original.id}`;
    const updated = await transport.request<Customer>(path, {
      method: 'PATCH',
      body: { version: original.version, name: '本浏览器中的示例改名', region: '示例地区' },
    });
    expect(updated.version).toBe(original.version + 1);
    expect((await transport.request<Customer>(path)).name).toBe('本浏览器中的示例改名');
    await expect(
      transport.request(path, {
        method: 'PATCH',
        body: { version: original.version, name: 'stale' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transport.request(path, {
        method: 'PATCH',
        body: { version: updated.version, workspace_id: 'other' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await transport.request<Customer>(path)).name).toBe('本浏览器中的示例改名');
    transport.reset();
    expect((await transport.request<Customer>(path)).name).toBe(original.name);
  });

  it('requires an actual completion result and preserves task versions, filters and detail links', async () => {
    const transport = createDemoTransport(fixture);
    const tasks = await transport.request<ActivityTask[]>('/tasks?status=open');
    expect(tasks).toHaveLength(2);
    const task = tasks[0];
    const path = `/tasks/${task.id}`;
    await expect(
      transport.request(path, {
        method: 'PATCH',
        body: { version: task.version, status: 'completed', result: ' ' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await transport.request<ActivityTask[]>('/tasks?status=open')).some(
        (row) => row.id === task.id,
      ),
    ).toBe(true);
    const started = await transport.request<ActivityTask>(path, {
      method: 'PATCH',
      body: { version: task.version, status: 'in_progress' },
    });
    const done = await transport.request<ActivityTask>(path, {
      method: 'PATCH',
      body: { version: started.version, status: 'completed', result: '已核对示例客户原话。' },
    });
    expect(done.result).toBe('已核对示例客户原话。');
    expect(
      (await transport.request<ActivityTask[]>('/tasks?status=completed')).map((row) => row.id),
    ).toContain(task.id);
    expect(
      (await transport.request<ActivityTask[]>('/tasks?status=open')).map((row) => row.id),
    ).not.toContain(task.id);
    const detail = await transport.request<{ tasks: ActivityTask[] }>(
      `/activities/${task.activity_id}`,
    );
    expect(detail.tasks.find((row) => row.id === task.id)?.status).toBe('completed');
    await expect(
      transport.request(path, {
        method: 'PATCH',
        body: { version: started.version, status: 'completed', result: 'stale' },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('serves activity query variants with actual scope and cursor pagination', async () => {
    const transport = createDemoTransport(fixture);
    const customerId = fixture.analysisAll.rows[0].customer_id;
    type ActivityPage = {
      items: {
        id: string;
        customer_id: string;
        project_id: string | null;
        linked_person_ids: string[];
      }[];
      next_cursor: string | null;
    };
    const full = await transport.request<ActivityPage>(
      `/activities?customer_id=${customerId}&limit=50`,
    );
    const first = await transport.request<ActivityPage>(
      `/activities?limit=2&customer_id=${customerId}`,
    );
    expect(full.items.length).toBeGreaterThan(2);
    expect(first.items).toEqual(full.items.slice(0, 2));
    const second = await transport.request<ActivityPage>(
      `/activities?customer_id=${customerId}&limit=2&cursor=${first.next_cursor}`,
    );
    expect(second.items).toEqual(full.items.slice(2, 4));
    const selected = full.items[0];
    const scoped = await transport.request<ActivityPage>(
      `/activities?customer_id=${customerId}&project_id=${selected.project_id}&person_id=${selected.linked_person_ids[0]}&limit=20`,
    );
    expect(
      scoped.items.every(
        (row) =>
          row.customer_id === customerId &&
          row.project_id === selected.project_id &&
          row.linked_person_ids.includes(selected.linked_person_ids[0]),
      ),
    ).toBe(true);
  });

  it('opens real captured evidence for prepared summary sources and rejects mismatched entities', async () => {
    const transport = createDemoTransport(fixture);
    const selected = fixture.analysisAll.rows[0];
    const entry = Object.entries(fixture.snapshots).find(
      ([key]) =>
        key.startsWith(`/customers/${selected.customer_id}/records/`) && key.endsWith('/evidence'),
    )!;
    const captured = entry[1] as {
      record: { id: string; body: string };
      sources: { body: string }[];
    };
    const body = {
      scope: {
        kind: 'entity',
        object: 'customers',
        customer_id: selected.customer_id,
        record_id: selected.customer_id,
      },
      kind: 'record',
      id: captured.record.id,
    };
    const result = await transport.request<{ title: string; body: string }>('/ask/source', {
      method: 'POST',
      body,
    });
    expect(result.body).toContain(captured.record.body);
    expect(result.body).toContain(captured.sources[0].body);
    const other = fixture.analysisAll.rows.find((row) => row.customer_id !== selected.customer_id)!;
    await expect(
      transport.request('/ask/source', {
        method: 'POST',
        body: {
          ...body,
          scope: { ...body.scope, customer_id: other.customer_id, record_id: other.customer_id },
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await transport.request('/prospects/tasks?status=open&page_size=20&page=1'),
    ).toMatchObject({ items: [], total: 0, page: 1, page_size: 20 });
    expect(await transport.request('/mail/accounts')).toEqual(fixture.snapshots['/mail/accounts']);
  });

  it('serves only proven project/person status scopes and keeps unknown scopes closed', async () => {
    const transport = createDemoTransport(fixture);
    const row = fixture.analysisAll.rows[0];
    const activity = fixture.snapshots[`/activities/${row.id}`] as { linked_person_ids: string[] };
    const query = `project_id=${row.project_id}&person_id=${activity.linked_person_ids[0]}`;
    const status = await transport.request<{
      originals: { source_count: number };
      graph: { state: string };
      vector: { state: string };
    }>(`/customers/${row.customer_id}/activity-status?${query}`);
    expect(status.originals.source_count).toBeGreaterThan(0);
    const capturedStatus =
      fixture.snapshots[snapshotKey(`/customers/${row.customer_id}/activity-status?${query}`)] ||
      fixture.snapshots[`/customers/${row.customer_id}/activity-status`];
    expect(status.graph.state).toBe((capturedStatus as { graph: { state: string } }).graph.state);
    expect(status.vector.state).toBe(
      (capturedStatus as { vector: { state: string } }).vector.state,
    );
    const knowledgePath = `/customers/${row.customer_id}/knowledge`;
    expect(await transport.request(`${knowledgePath}?${query}`)).toEqual(
      fixture.snapshots[snapshotKey(`${knowledgePath}?${query}`)] ||
        fixture.snapshots[knowledgePath],
    );
    const other = fixture.analysisAll.rows.find((item) => item.customer_id !== row.customer_id)!;
    await expect(
      transport.request(
        `/customers/${row.customer_id}/activity-status?project_id=${other.project_id}`,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('uses prepared ready graph snapshots only for the exact verified customer scope', async () => {
    const prepared = structuredClone(fixture);
    const row = prepared.analysisAll.rows[0];
    const path = `/customers/${row.customer_id}/knowledge/graph`;
    const key = snapshotKey(`${path}?project_id=${row.project_id}`);
    const projection = {
      state: 'ready',
      facts: [{ id: 'prepared-fact', fact: '仅此示例项目的预设索引' }],
      nodes: [{ id: 'prepared-node' }],
      edges: [],
    };
    prepared.snapshots[key] = projection;
    const transport = createDemoTransport(prepared);
    expect(await transport.request(`${path}?project_id=${row.project_id}`)).toEqual(projection);
    const other = prepared.analysisAll.rows.find(
      (candidate) => candidate.customer_id !== row.customer_id,
    )!;
    await expect(transport.request(`${path}?project_id=${other.project_id}`)).rejects.toMatchObject(
      { status: 404 },
    );
    const activity = prepared.snapshots[`/activities/${row.id}`] as { linked_person_ids: string[] };
    const personId = activity.linked_person_ids[0];
    const missing = snapshotKey(`${path}?person_id=${personId}`);
    delete prepared.snapshots[missing];
    prepared.snapshots[path] = projection;
    await expect(
      createDemoTransport(prepared).request(`${path}?person_id=${personId}`),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('opens the prepared memory conversation for every real saved preference source', async () => {
    const transport = createDemoTransport(fixture);
    const preferences =
      await transport.request<
        { source_chat_id: string; source_message_id: string; content: string }[]
      >('/agent/preferences');
    expect(preferences).toHaveLength(2);
    for (const preference of preferences) {
      expect(preference.source_chat_id).toBe(fixture.memoryChatId);
      const conversation = await transport.request<{ messages: { id: string }[] }>(
        `/chats/${preference.source_chat_id}`,
      );
      expect(
        conversation.messages.some((message) => message.id === preference.source_message_id),
      ).toBe(true);
      expect(preference.content.length).toBeGreaterThan(0);
    }
  });

  it('edits and deletes only existing local preferences using their real enum and opaque version', async () => {
    const transport = createDemoTransport(fixture);
    const preferences = await transport.request<UserPreferenceSetting[]>('/agent/preferences');
    const original = preferences[0];
    const option = userPreferenceOptions[original.category].options.find(
      (option) => option.value !== original.value,
    )!;
    const path = `/agent/preferences/${original.id}`;
    await expect(
      transport.request(path, {
        method: 'PATCH',
        body: { value: 'arbitrary business fact', expected_version: original.version },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const updated = await transport.request<UserPreferenceSetting>(path, {
      method: 'PATCH',
      body: { value: option.value, expected_version: original.version },
    });
    expect(updated.content).toBe(option.label);
    expect(updated.version).toMatch(/^[a-f\d]{32}$/);
    expect(updated.version).not.toBe(original.version);
    expect(updated.source_chat_id).toBe(original.source_chat_id);
    expect(updated.source_message_id).toBe(original.source_message_id);
    await expect(
      transport.request(path, {
        method: 'PATCH',
        body: { value: original.value, expected_version: original.version },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await transport.request<UserPreferenceSetting[]>('/agent/preferences')).find(
        (preference) => preference.id === original.id,
      )?.value,
    ).toBe(option.value);
    expect(await transport.request(path, { method: 'DELETE', body: {} })).toEqual({
      removed: true,
    });
    expect(
      (await transport.request<UserPreferenceSetting[]>('/agent/preferences')).some(
        (preference) => preference.id === original.id,
      ),
    ).toBe(false);
    expect(await transport.request(`/chats/${original.source_chat_id}`)).toEqual(
      fixture.snapshots[`/chats/${original.source_chat_id}`],
    );
    transport.reset();
    expect(await transport.request('/agent/preferences')).toEqual(
      fixture.snapshots['/agent/preferences'],
    );
  });

  it('serves the prepared graph with valid node links and readable original record evidence', async () => {
    const transport = createDemoTransport(fixture);
    const customerId = fixture.knowledgeCustomerId;
    const graph = await transport.request<KnowledgeGraphView>(
      `/customers/${customerId}/knowledge/graph`,
    );
    expect(graph.state).toBe('ready');
    expect(graph.nodes.length).toBeGreaterThan(0);
    const nodes = new Set(graph.nodes.map((node) => node.key));
    expect(graph.edges.every((edge) => nodes.has(edge.source) && nodes.has(edge.target))).toBe(
      true,
    );
    expect(graph.facts.length).toBeGreaterThan(0);
    for (const fact of graph.facts) {
      for (const source of fact.sources) {
        const evidence = await transport.request<{
          record: { id: string; customer_id: string };
          sources: { id: string; body: string }[];
        }>(`/customers/${customerId}/records/${source.record_id}/evidence`);
        expect(evidence.record.customer_id).toBe(customerId);
        expect(
          evidence.sources.some(
            (original) => original.id === source.id && original.body.length > 0,
          ),
        ).toBe(true);
      }
    }
  });

  it('searches the actual synthetic mail and tracks only local read markers', async () => {
    const transport = createDemoTransport(fixture);
    const page = await transport.request<{
      items: { id: string; subject: string; customer_id: string }[];
      total: number;
    }>('/mail/messages?pending=all&page=1');
    expect(page.total).toBe(23);
    const mail = page.items[0];
    const search = await transport.request<{ items: { id: string }[] }>(
      `/mail/messages?customer_id=${mail.customer_id}&pending=false&q=${encodeURIComponent(mail.subject)}&page=1`,
    );
    expect(search.items.map((row) => row.id)).toContain(mail.id);
    const before = await transport.request<{ unread: number }>('/mail/tracking/summary');
    await transport.request(`/mail/messages/${mail.id}/read`, { method: 'POST', body: {} });
    expect((await transport.request<{ unread: number }>('/mail/tracking/summary')).unread).toBe(
      before.unread - 1,
    );
    expect((await transport.request<unknown[]>('/tasks')).length).toBe(3);
  });

  for (const [index, golden] of fixture.analysisGolden.entries()) {
    it(`matches real backend feedback query ${index + 1}, including summary, coverage, grouping and page`, async () => {
      const result = await createDemoTransport(fixture).request<ActivityAnalysisResult>(
        '/reports/activity-analysis/query',
        { method: 'POST', body: golden.input },
      );
      expect(result).toEqual(golden.result);
    });
  }

  it('rejects invalid feedback dates, pages and changed mappings rather than fabricating results', async () => {
    const transport = createDemoTransport(fixture);
    const query = (body: unknown) =>
      transport.request('/reports/activity-analysis/query', { method: 'POST', body });
    await expect(
      query({ config: fixture.analysisConfig, startDate: '2026-02-31' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      query({ config: fixture.analysisConfig, startDate: '2026-11-10', endDate: '2026-11-01' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(query({ config: fixture.analysisConfig, offset: -1 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      query({
        config: {
          ...fixture.analysisConfig,
          fields: {
            ...fixture.analysisConfig.fields,
            product: fixture.analysisConfig.fields.issue,
          },
        },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('copies and edits feedback dashboards without changing the captured original', async () => {
    const transport = createDemoTransport(fixture);
    const boards = await transport.request<ReportDashboard[]>('/reports/dashboards');
    const original = boards.find((board) => board.id === fixture.feedbackBoardId)!;
    const copy = await transport.request<ReportDashboard>('/reports/dashboards', {
      method: 'POST',
      body: {
        name: '示例副本',
        description: '仅浏览器内',
        widgets: [],
        activity_analysis: original.activity_analysis,
      },
    });
    expect(copy.id).not.toBe(original.id);
    expect(copy.activity_analysis).toEqual(fixture.analysisConfig);
    const updated = await transport.request<ReportDashboard>(`/reports/dashboards/${copy.id}`, {
      method: 'PATCH',
      body: { version: copy.version, name: '示例修改' },
    });
    expect(updated.activity_analysis).toEqual(fixture.analysisConfig);
    expect(
      (await transport.request<ReportDashboard[]>(`/reports/dashboards`)).find(
        (board) => board.id === original.id,
      )?.name,
    ).toBe(original.name);
  });

  it('supports ordinary count reports using the actual fixture records', async () => {
    const transport = createDemoTransport(fixture);
    const query = (source: string, groupBy: string) =>
      transport.request<ReportQueryResult>('/reports/query', {
        method: 'POST',
        body: { source, metric: 'count', groupBy },
      });
    expect((await query('companies', 'none')).value).toBe(6);
    expect((await query('projects', 'type')).total).toBe(6);
    expect((await query('activities', 'type')).value).toBe(23);
    await expect(
      transport.request('/reports/query', {
        method: 'POST',
        body: { source: 'companies', metric: 'average', metricField: 'invented', groupBy: 'none' },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fails closed for external URLs, unknown routes, identity changes and all online effects', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const transport = createDemoTransport(fixture);
    for (const [path, method] of [
      ['/auth/login', 'POST'],
      ['/mail/accounts', 'POST'],
      ['/mail/accounts/a/sync', 'POST'],
      ['/outgoing/a/send', 'POST'],
      ['/activities/generate', 'POST'],
      ['/chats/a/runs', 'POST'],
      ['/agent/preferences', 'PATCH'],
      ['/unmapped-resource', 'GET'],
      ['https://example.invalid/session', 'GET'],
    ]) {
      await expect(transport.request(path, { method })).rejects.toMatchObject({
        status: 403,
        message: DEMO_UNAVAILABLE,
      });
    }
    await expect(transport.request('/session', { workspace: 'other' })).rejects.toMatchObject({
      status: 403,
    });
    const capabilities = await transport.request<{ model: boolean; background_runs: boolean }>(
      '/agent/capabilities',
    );
    expect(capabilities.model).toBe(false);
    expect(capabilities.background_runs).toBe(false);
    await expect(
      streamApi('/anything', { workspace: fixture.workspaceId, body: {}, onText: vi.fn() }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      watchApi('/anything', {
        workspace: fixture.workspaceId,
        signal: new AbortController().signal,
        onEvent: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(api('/session')).rejects.toMatchObject({ status: 401 });
    demoRuntime.choose('boss');
    try {
      expect(await api('/session')).toMatchObject({
        actor: { id: fixture.actorId },
        workspaces: [{ id: fixture.workspaceId, role: 'admin' }],
      });
    } finally {
      demoRuntime.reset();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('respects abort signals before replying with data', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createDemoTransport(fixture).request('/customers', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
