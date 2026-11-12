import { describe, expect, it, vi } from 'vitest';
import { createDemoRuntime } from './runtime';
import fixtureData from './fixture.json';
import type { DemoFixture } from './types';
import type { ActivityDetail, CollaborationTask } from '../shared/business-activities';
import type { CustomerList } from '../shared/views';

const fixture = fixtureData as DemoFixture;
const sampleActivity = '/activities/421c32a3-a9fc-4527-b8bd-2fad99359a72';
const csv = {
  filename: 'A214.csv',
  content_type: 'text/csv',
  content_base64: btoa('size,chest_cm\nM,82\n'),
};

describe('public team experience', () => {
  it('starts signed out and invalidates an in-flight read when choosing another account', async () => {
    const runtime = createDemoRuntime(fixture);
    await expect(runtime.request('/session')).rejects.toMatchObject({ status: 401 });
    runtime.choose('boss');
    const read = runtime.request('/customers');
    runtime.choose('designer');
    await expect(read).rejects.toMatchObject({ status: 401 });
    expect(await runtime.request('/session')).toMatchObject({
      actor: { display_name: '程禾' },
      workspaces: [{ role: 'member', workspace_mode: 'tasks' }],
    });
    await runtime.request('/auth/logout', { method: 'POST' });
    await expect(runtime.request('/tasks')).rejects.toMatchObject({ status: 401 });
  });

  it('limits sales archives, original communications, reports and member administration by grant', async () => {
    const runtime = createDemoRuntime(fixture);
    runtime.choose('boss');
    const boss = await runtime.request<CustomerList>('/customers');
    expect(boss.total).toBe(6);
    const members = await runtime.request<{ display_name: string }[]>('/members');
    expect(members.map((member) => member.display_name)).toEqual(['林然', '许舟', '顾桐', '程禾']);
    const foreign = boss.items.find((row) => row.name === 'Northstar 舞蹈用品')!;
    const local = boss.items.find((row) => row.name === '松林艺术中心')!;
    expect(await runtime.request(`/customers/${foreign.id}/access`)).toHaveLength(1);

    runtime.choose('export');
    const exports = await runtime.request<CustomerList>('/customers?owner=me');
    expect(exports.items.map((row) => row.id)).toContain(foreign.id);
    expect(exports.total).toBe(2);
    await expect(runtime.request(`/customers/${local.id}`)).rejects.toMatchObject({ status: 404 });
    await expect(runtime.request(`/customers/${foreign.id}/access`)).rejects.toMatchObject({
      status: 403,
    });
    const mail = await runtime.request<{ items: { customer_id: string }[] }>('/mail/messages');
    expect(mail.items.length).toBeGreaterThan(0);
    expect(
      mail.items.every((row) => exports.items.some((customer) => customer.id === row.customer_id)),
    ).toBe(true);

    runtime.choose('domestic');
    const domestic = await runtime.request<CustomerList>('/customers?owner=me');
    expect(domestic.items.map((row) => row.id)).toContain(local.id);
    expect(domestic.total).toBe(4);
    await expect(runtime.request(sampleActivity)).rejects.toMatchObject({ status: 404 });
    const query = { source: 'companies', metric: 'count', groupBy: 'none' };
    expect(await runtime.request('/reports/query', { method: 'POST', body: query })).toMatchObject({
      value: 4,
    });
  });

  it('shares only the chart deliverable across the simulated handoff and clears it when reset', async () => {
    const runtime = createDemoRuntime(fixture);
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    try {
      runtime.choose('designer');
      for (const path of ['/members', '/customers', '/mail/messages', sampleActivity]) {
        await expect(runtime.request(path)).rejects.toMatchObject({ status: 404 });
      }
      const [task] = await runtime.request<CollaborationTask[]>('/tasks');
      expect(task).toMatchObject({
        title: '补齐 A214 样衣尺码表',
        attachment_required: true,
        status: 'open',
      });
      expect(task).not.toHaveProperty('customer_id');
      expect(task).not.toHaveProperty('activity_id');
      const path = `/tasks/${task.id}`;
      const started = await runtime.request<CollaborationTask>(path, {
        method: 'PATCH',
        body: { version: task.version, status: 'in_progress' },
      });
      const complete = { version: started.version, status: 'completed', result: '尺寸已核对' };
      await expect(
        runtime.request(path, { method: 'PATCH', body: complete }),
      ).rejects.toMatchObject({ status: 400 });
      const done = await runtime.request<CollaborationTask>(path, {
        method: 'PATCH',
        body: { ...complete, attachment: csv },
      });
      expect(done).toMatchObject({
        status: 'completed',
        result: '尺寸已核对',
        attachment: { filename: csv.filename },
      });
      expect(done.attachment).not.toHaveProperty('content_base64');

      runtime.choose('domestic');
      await expect(
        runtime.request(`/task-collaborations/${task.id}/attachment`),
      ).rejects.toMatchObject({ status: 403 });
      runtime.choose('export');
      const activity = await runtime.request<ActivityDetail>(sampleActivity);
      expect(activity.tasks).toContainEqual(
        expect.objectContaining({ id: task.id, status: 'completed' }),
      );
      await expect(
        runtime.request(`/task-collaborations/${task.id}/attachment`),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        runtime.request('/outgoing/test/send', { method: 'POST' }),
      ).rejects.toMatchObject({ status: 403 });
      runtime.choose('designer');
      expect(await runtime.request(`/task-collaborations/${task.id}/attachment`)).toMatchObject(
        csv,
      );
      expect(network).not.toHaveBeenCalled();

      runtime.reset();
      runtime.choose('designer');
      expect(await runtime.request('/tasks')).toEqual([task]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
