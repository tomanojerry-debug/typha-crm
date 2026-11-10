import { expect, it } from 'vitest';
import { fillAttributeCells, type AttributeJob } from '../src/AttributeGenerate';
import { HttpError, type api } from '../src/api';
import type { AttributeRun, CompanyAttribute, CompanyAttributeValue } from '../shared/attributes';

const field: CompanyAttribute = {
  id: 'summary',
  name: '概括',
  kind: 'text',
  description: '',
  options: [],
  ai_enabled: true,
  guidance: '按已保存的指令',
  archived: false,
  version: 3,
};
const company = (id: string) => ({ id, name: id, can_edit: true, archived_at: null });
const value = (
  id: string,
  content: CompanyAttributeValue['value'] = '已生成',
): CompanyAttributeValue => ({
  customer_id: id,
  attribute_id: field.id,
  value: content,
  origin: 'ai',
  explanation: '',
  sources: [],
  generated_at: null,
  version: 1,
  updated_at: '',
});
const run = (id: string, content: AttributeRun['value'] = '已生成'): AttributeRun => ({
  id: `run-${id}`,
  customer_id: id,
  attribute_id: field.id,
  value: content,
  explanation: '',
  missing: [],
  sources: [],
  guidance: field.guidance,
  warnings: [],
  model: 'fixture',
  created_at: '',
  state: 'preview',
});
function setup(handler: (path: string, options: Parameters<typeof api>[1]) => Promise<unknown>) {
  const jobs: AttributeJob[] = [],
    saved: CompanyAttributeValue[] = [],
    calls: { path: string; options: Parameters<typeof api>[1] }[] = [];
  const controller = new AbortController();
  return {
    jobs,
    saved,
    calls,
    controller,
    options: {
      workspace: 'workspace-a',
      field,
      customers: [company('a'), company('b')],
      values: [] as CompanyAttributeValue[],
      signal: controller.signal,
      onJob: (job: AttributeJob) => jobs.push(job),
      onSaved: (v: CompanyAttributeValue) => saved.push(v),
      request: (async (path, options) => {
        calls.push({ path, options });
        return handler(path, options);
      }) as typeof api,
    },
  };
}
it('shows queue progress and immediately saves each generated value before generating the next company', async () => {
  const t = setup(async (path) =>
    path.endsWith('/apply') ? value(path.split('/')[2]) : run(path.split('/')[2]),
  );
  await fillAttributeCells(t.options);
  expect(t.calls.map((c) => c.path)).toEqual([
    '/customers/a/attribute-runs',
    '/customers/a/attribute-runs/run-a/apply',
    '/customers/b/attribute-runs',
    '/customers/b/attribute-runs/run-b/apply',
  ]);
  expect(t.calls[0].options).toMatchObject({
    workspace: 'workspace-a',
    body: {
      attribute_id: field.id,
      attribute_version: 3,
      use_saved_guidance: true,
      only_empty: true,
    },
  });
  expect(t.calls[1].options).toMatchObject({ body: {} });
  expect(t.saved.map((v) => v.customer_id)).toEqual(['a', 'b']);
  expect(t.jobs.filter((j) => j.customer.id === 'a').map((j) => j.status)).toEqual([
    'queued',
    'generating',
    'saving',
    'saved',
  ]);
});
it('preserves filled cells including zero, readonly and archived companies, and persists missing-information status', async () => {
  const t = setup(async (path) =>
    path.endsWith('/apply') ? value('empty', null) : run('empty', null),
  );
  await fillAttributeCells({
    ...t.options,
    customers: [
      company('zero'),
      company('filled'),
      { ...company('viewer'), can_edit: false },
      { ...company('archive'), archived_at: '2026-10-22' },
      company('empty'),
    ],
    values: [value('zero', 0), value('filled', '人工内容')],
  });
  expect(t.calls.map((c) => c.path)).toEqual([
    '/customers/empty/attribute-runs',
    '/customers/empty/attribute-runs/run-empty/apply',
  ]);
  expect(t.saved).toEqual([value('empty', null)]);
  expect(t.jobs.filter((j) => j.status === 'skipped')).toHaveLength(4);
  expect(t.jobs.at(-1)?.status).toBe('empty');
});
it('cancels before applying a model result and stops all remaining queued companies', async () => {
  const t = setup(async () => {
    t.controller.abort();
    return run('a');
  });
  await fillAttributeCells(t.options);
  expect(t.calls).toHaveLength(1);
  expect(t.saved).toEqual([]);
  expect(t.jobs.slice(-2).map((j) => j.status)).toEqual(['stopped', 'stopped']);
});
it('waits for a write already started when stopped, and leaves subsequent companies untouched', async () => {
  const t = setup(async (path) => {
    if (path.endsWith('/apply')) {
      t.controller.abort();
      return value('a');
    }
    return run('a');
  });
  await fillAttributeCells(t.options);
  expect(t.saved.map((v) => v.customer_id)).toEqual(['a']);
  expect(t.calls).toHaveLength(2);
  expect(t.jobs.at(-1)?.status).toBe('stopped');
});
it('keeps an intervening manual write on conflict and continues with the next independent company', async () => {
  const t = setup(async (path) => {
    if (path.includes('run-a/apply')) throw new HttpError('属性值已被修改', 409);
    return path.endsWith('/apply') ? value('b') : run(path.split('/')[2]);
  });
  await fillAttributeCells(t.options);
  expect(t.saved.map((v) => v.customer_id)).toEqual(['b']);
  expect(t.jobs.find((j) => j.status === 'error')?.message).toContain('已被修改');
});
it('stops without retrying when a write outcome is unknown or the model service fails', async () => {
  for (const applying of [true, false]) {
    const t = setup(async (path) => {
      if (!applying) throw new HttpError('服务暂不可用', 503);
      if (path.endsWith('/apply')) throw new TypeError('Network error');
      return run('a');
    });
    await fillAttributeCells(t.options);
    expect(t.calls).toHaveLength(applying ? 2 : 1);
    expect(t.saved).toEqual([]);
    expect(t.jobs.at(-1)?.status).toBe('stopped');
    if (applying) expect(t.jobs.find((j) => j.status === 'error')?.message).toContain('刷新核对');
  }
});
