import { HttpError } from '../src/api';
import {
  collaborationAttachmentLimit,
  collaborationAttachmentTypes,
  type ActivityDetail,
  type ActivityTask,
  type CollaborationTask,
  type CollaborationTaskAttachment,
} from '../shared/business-activities';
import {
  actorId,
  customerGrants,
  demoFixtureForAccount,
  demoMembers,
  demoSession,
  type DemoAccount,
} from './accounts';
import { createDemoTransport, DEMO_UNAVAILABLE, type DemoRequestOptions } from './transport';
import type { DemoFixture } from './types';

const chartTaskId = 'e2aa2773-b3bd-4659-b112-2f37839e99c4';
const chartActivityId = '421c32a3-a9fc-4527-b8bd-2fad99359a72';
const csvContent = 'Size,Chest (cm),Waist (cm),Hip (cm)\nS,78,62,86\nM,82,66,90\nL,86,70,94\n';
export const demoChartFilename = 'A214-size-chart.csv';

const denied = () => new HttpError(DEMO_UNAVAILABLE, 403);
const missing = () => new HttpError('示例记录不存在', 404);

function fileMetadata(file: CollaborationTaskAttachment | null) {
  return (
    file && {
      filename: file.filename,
      content_type: file.content_type,
      size_bytes: file.size_bytes,
    }
  );
}

function readAttachment(value: unknown): CollaborationTaskAttachment {
  if (!value || typeof value !== 'object') throw new HttpError('请选择尺码表文件', 400);
  const { filename, content_type, content_base64 } = value as Record<string, unknown>;
  const extension =
    typeof filename === 'string'
      ? (/\.(csv|xlsx|pdf)$/i.exec(filename)?.[1].toLowerCase() as
          keyof typeof collaborationAttachmentTypes | undefined)
      : undefined;
  if (
    typeof filename !== 'string' ||
    filename.length > 180 ||
    /[\\/\x00-\x1f]/.test(filename) ||
    !extension ||
    content_type !== collaborationAttachmentTypes[extension] ||
    typeof content_base64 !== 'string' ||
    content_base64.length > Math.ceil(collaborationAttachmentLimit / 3) * 4
  ) {
    throw new HttpError('请选择不超过 1 MB 的 XLSX、CSV 或 PDF 文件', 400);
  }
  let size_bytes = 0;
  try {
    size_bytes = atob(content_base64).length;
  } catch {
    throw new HttpError('交付文件无效', 400);
  }
  if (!size_bytes || size_bytes > collaborationAttachmentLimit)
    throw new HttpError('请选择不超过 1 MB 的 XLSX、CSV 或 PDF 文件', 400);
  return {
    filename,
    content_type: collaborationAttachmentTypes[extension],
    content_base64,
    size_bytes,
  };
}

export function createDemoRuntime(fixture: DemoFixture) {
  const transports = {
    boss: createDemoTransport(fixture),
    export: createDemoTransport(demoFixtureForAccount(fixture, 'export')),
    domestic: createDemoTransport(demoFixtureForAccount(fixture, 'domestic')),
  };
  const members = demoMembers(fixture);
  const activity = fixture.snapshots[`/activities/${chartActivityId}`] as
    ActivityDetail | undefined;
  let account: DemoAccount | null = null;
  let sessionVersion = 0;
  const freshTask = (): CollaborationTask => ({
    id: chartTaskId,
    task_only: true,
    title: '补齐 A214 样衣尺码表',
    collaboration_brief:
      '请核对 A214 新版样衣 S／M／L 的胸围、腰围和臀围。表格统一用厘米，完成后附上确认版，交给业务员复核。',
    attachment_required: true,
    attachment: null,
    status: 'open',
    result: null,
    due_date: null,
    version: 1,
    created_at: '2026-11-11T02:00:00.000Z',
    updated_at: '2026-11-11T02:00:00.000Z',
  });
  let task = freshTask();
  let attachment: CollaborationTaskAttachment | null = null;

  function choose(next: DemoAccount | null) {
    account = next;
    sessionVersion++;
  }
  function reset() {
    for (const transport of Object.values(transports)) transport.reset();
    task = freshTask();
    attachment = null;
    choose(null);
  }
  function designerRequest(path: string, url: URL, method: string, body: unknown) {
    if (path === '/tasks' && method === 'GET') {
      const status = url.searchParams.get('status');
      return !status || status === task.status ? [task] : [];
    }
    if (path === `/task-collaborations/${task.id}/attachment` && method === 'GET' && attachment)
      return attachment;
    if (path !== `/tasks/${task.id}` || method !== 'PATCH') throw missing();
    const update = (body || {}) as {
      version?: unknown;
      status?: unknown;
      result?: unknown;
      attachment?: unknown;
    };
    if (update.version !== task.version || task.status === 'completed')
      throw new HttpError('这项交接已更新，请刷新待办', 409);
    if (update.status !== 'in_progress' && update.status !== 'completed')
      throw new HttpError('待办状态无效', 400);
    if (update.status === 'in_progress' && task.status !== 'open')
      throw new HttpError('这项交接已经开始处理', 409);
    let result = task.result;
    if (update.status === 'completed') {
      result = typeof update.result === 'string' ? update.result.trim() : '';
      if (!result || result.length > 4000) throw new HttpError('请填写处理结果', 400);
      attachment = readAttachment(update.attachment);
    }
    task = {
      ...task,
      status: update.status,
      result,
      attachment: fileMetadata(attachment),
      version: task.version + 1,
      updated_at: new Date().toISOString(),
    };
    return task;
  }
  async function request<T>(path: string, options: DemoRequestOptions = {}): Promise<T> {
    const version = sessionVersion;
    await Promise.resolve();
    if (options.signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (!account || version !== sessionVersion) throw new HttpError('请选择体验账号', 401);
    if (options.workspace && options.workspace !== fixture.workspaceId) throw denied();
    const active = account;
    const url = new URL(path, 'https://demo.invalid');
    if (url.origin !== 'https://demo.invalid') throw denied();
    const route = url.pathname;
    const method = (options.method || 'GET').toUpperCase();
    if (route === '/session' && method === 'GET') return demoSession(fixture, active) as T;
    if (route === '/auth/logout' && method === 'POST') {
      choose(null);
      return { ok: true } as T;
    }
    if (active === 'designer')
      return structuredClone(designerRequest(route, url, method, options.body)) as T;
    if (route === '/members' && method === 'GET')
      return structuredClone(
        active === 'boss'
          ? members
          : members.filter((member) => member.actor_id === actorId(fixture, active)),
      ) as T;
    const access = route.match(/^\/customers\/([^/]+)\/access$/);
    if (access && method === 'GET') {
      if (active !== 'boss') throw denied();
      await transports.boss.request(`/customers/${access[1]}`, options);
      return customerGrants(fixture, access[1]) as T;
    }
    if (route === '/mail-sender-capability' && method === 'GET') return { can_send: false } as T;
    if (/^\/mail-accounts\/[^/]+\/senders$/.test(route) && method === 'GET' && active === 'boss')
      return [] as T;
    if (
      route === `/activities/${chartActivityId}` &&
      method === 'GET' &&
      activity &&
      active !== 'domestic'
    ) {
      const result = await transports[active].request<ActivityDetail>(path, options);
      const collaboration: ActivityTask = {
        ...task,
        activity_id: activity.id,
        customer_id: activity.customer_id,
        project_id: activity.project_id,
        assignee_id: actorId(fixture, 'designer'),
        assignee_display_name: members.find(
          (member) => member.actor_id === actorId(fixture, 'designer'),
        )?.display_name,
        created_by: actorId(fixture, 'export'),
        result_record_id: null,
      };
      return { ...result, tasks: [...result.tasks, collaboration] } as T;
    }
    return transports[active].request<T>(path, options);
  }
  return { choose, reset, request };
}

export function sampleChartHref() {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csvContent)}`;
}
