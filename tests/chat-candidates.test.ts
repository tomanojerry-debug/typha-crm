import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import type { AgentModelInput } from '../server/agent-model.js';
import type { ChatClassification, ChatRetrieval } from '../shared/chat-intent.js';
import type { AskSource } from '../shared/ask.js';
import { hydrateChatCandidates } from '../server/chat-retrieval.js';
import { scoped } from '../server/security.js';

const origin = 'http://localhost:3100',
  password = 'candidate-fixture-password';
let db: Database,
  admin: Agent,
  viewer: Agent,
  workspace: string,
  viewerId: string,
  adminId: string,
  a: string,
  b: string,
  firstPerson: string,
  deniedPerson: string,
  firstProject: string;
let calls: AgentModelInput[] = [];
let answerHook: ((input: AgentModelInput) => Promise<void>) | undefined;
const headers = () => ({ origin, 'x-workspace-id': workspace });
const cls = (extra: Partial<ChatClassification> = {}): ChatClassification => ({
  intent: '查询资料',
  action: 'search_candidates',
  entity_type: 'person',
  target: '沈',
  match_mode: 'surname',
  candidate_index: null,
  missing: [],
  reply: '搜索候选。',
  mail_action: null,
  ...extra,
});
let classify = (input: AgentModelInput): ChatClassification => classifyDefault(input);
function classifyDefault(input: AgentModelInput): ChatClassification {
  if (/第二|第2/.test(input.question))
    return cls({
      action: 'select_candidate',
      target: null,
      match_mode: null,
      candidate_index: 2,
      intent: input.snapshot.warnings.join('').includes('起草内容') ? '起草内容' : '查询资料',
    });
  if (/取消|先不查/.test(input.question))
    return cls({ intent: '一般对话', action: 'respond', target: null, match_mode: null });
  if (input.question === '继续拟稿')
    return cls({
      intent: '起草内容',
      action: 'select_candidate',
      target: null,
      match_mode: null,
      candidate_index: 2,
    });
  if (input.question === '沈候选乙')
    return cls({ action: 'lookup_entity', target: input.question, match_mode: 'name' });
  return cls({
    target: input.question.includes('魏') ? '魏' : input.question.includes('欧阳') ? '欧阳' : '沈',
    intent: input.question.includes('写') ? '起草内容' : '查询资料',
  });
}
async function createChat(agent = admin, customer_id: string | null = null) {
  return (
    await agent
      .post('/api/chats')
      .set(headers())
      .send({ id: randomUUID(), title: '合成候选验证', customer_id })
      .expect(201)
  ).body.id as string;
}
const send = (agent: Agent, id: string, body: string, extra: Record<string, unknown> = {}) =>
  agent
    .post(`/api/chats/${id}/messages`)
    .set(headers())
    .send({ request_id: randomUUID(), body, ...extra });
async function person(
  customer: string,
  name: string,
  description = 'SYNTHETIC_CONTACT_PRIVATE',
  fields: { email?: string; phone?: string; job_title?: string } = {},
) {
  return (
    await admin
      .post('/api/people')
      .set(headers())
      .send({ customer_id: customer, name, description, ...fields })
      .expect(201)
  ).body.id as string;
}
async function mutate(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [workspace, adminId],
    );
    return tx.query(sql, params);
  });
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: '候选合成工作空间',
    email: 'candidates@fixture.invalid',
    password,
    displayName: 'Admin',
  });
  workspace = seed.workspaceId;
  adminId = seed.actorId;
  const app = createApp(db, {
    origin,
    agent: {
      transport: {
        async generate(input) {
          calls.push(input);
          if (input.phase === 'classify') return classify(input);
          await answerHook?.(input);
          const result = input.snapshot.retrieval;
          return {
            answer:
              result?.status === 'candidates'
                ? `候选名单：${result.candidates.map((c, i) => `${i + 1}.${c.title}`).join('、')}，请选择。`
                : result?.status === 'unique'
                  ? `继续原任务：${input.snapshot.sources[0].body}`
                  : '请提供或核对搜索条件。',
            source_ids:
              result?.status === 'candidates'
                ? []
                : input.snapshot.sources.slice(0, 1).map((s) => s.id),
          };
        },
      },
    },
  });
  admin = request.agent(app);
  viewer = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'candidates@fixture.invalid', password })
    .expect(200);
  viewerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'candidate-viewer@fixture.invalid', display_name: 'Viewer', password })
      .expect(201)
  ).body.actor_id;
  await viewer
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'candidate-viewer@fixture.invalid', password })
    .expect(200);
  a = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({
        name: '候选A公司',
        type: 'group',
        source: 'other',
        region: '上海',
        email: 'company-a@fixture.invalid',
        phone: '021-12345678',
        contact_name: '公司主要联系人',
      })
      .expect(201)
  ).body.id;
  b = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({
        name: '候选B公司',
        type: 'group',
        source: 'other',
        email: 'company-b-private@fixture.invalid',
      })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${a}/access/${viewerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
  firstPerson = await person(a, '[联调] 沈候选甲', 'A_CONTACT_PRIVATE', {
    email: 'person-a@fixture.invalid',
    phone: '13800138000',
    job_title: '采购负责人',
  });
  deniedPerson = await person(b, '沈候选乙', 'B_CONTACT_PRIVATE', {
    email: 'person-b-private@fixture.invalid',
  });
  await person(a, '李沈中');
  await person(a, '欧阳示例');
  await admin
    .post(`/api/customers/${b}/records`)
    .set(headers())
    .send({ kind: 'company_confirmed', body: 'B_BUSINESS_PRIVATE' })
    .expect(201);
  firstProject = (
    await admin
      .post(`/api/customers/${a}/projects`)
      .set(headers())
      .send({
        name: '沈项目',
        type: 'sample',
        due_date: '2026-11-18',
        description: 'PROJECT_DESCRIPTION_PRIVATE',
      })
      .expect(201)
  ).body.id;
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  calls = [];
  answerHook = undefined;
  classify = classifyDefault;
  await mutate('UPDATE people SET archived_at=NULL WHERE workspace_id=$1', [workspace]);
  await mutate(
    'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
    [workspace, b, viewerId],
  );
});

it.each(['看下沈的资料', '有哪些姓沈的', '你帮我看看有哪些姓沈的'])(
  'searches minimal surname candidates for %s and persists server order without relying on citations',
  async (question) => {
    const id = await createChat();
    const result = (await send(admin, id, question).expect(200)).body;
    const m = result.messages.at(-1);
    expect(m.retrieval).toMatchObject({
      status: 'candidates',
      query: '沈',
      total: 2,
      truncated: false,
    });
    expect(m.retrieval.candidates.map((c: { title: string }) => c.title)).toEqual([
      '[联调] 沈候选甲',
      '沈候选乙',
    ]);
    expect(m.retrieval.candidates.map((c: { company_name: string }) => c.company_name)).toEqual([
      '候选A公司',
      '候选B公司',
    ]);
    expect(m.sources).toEqual([]);
    expect(JSON.stringify(calls)).not.toMatch(
      /A_CONTACT_PRIVATE|B_CONTACT_PRIVATE|B_BUSINESS_PRIVATE|李沈中|沈项目/,
    );
    expect(calls.map((c) => c.phase)).toEqual(['classify', 'answer']);
    const reloaded = (
      await admin.get(`/api/chats/${id}`).set(headers()).expect(200)
    ).body.messages.at(-1);
    expect(reloaded.retrieval.candidates).toEqual(m.retrieval.candidates);
  },
);
it('adds only authorized basic fields to company, person and project candidate cards', async () => {
  const id = await createChat(viewer);
  classify = () => cls({ target: '候选', match_mode: 'name', entity_type: 'unknown' });
  const mixed = (await send(viewer, id, '找找候选').expect(200)).body.messages.at(-1);
  expect(mixed.retrieval.status).toBe('candidates');
  expect(mixed.retrieval.candidates).toHaveLength(2);
  const company = mixed.retrieval.candidates.find(
    (c: { object: string }) => c.object === 'customers',
  );
  const contact = mixed.retrieval.candidates.find((c: { object: string }) => c.object === 'people');
  expect(company).not.toHaveProperty('company_name');
  expect(company.directory_fields).toEqual([
    { label: '公司类型', value: '团体定制' },
    { label: '地区', value: '上海' },
    { label: '合作状态', value: '待建立合作' },
    { label: '公司邮箱', value: 'company-a@fixture.invalid' },
    { label: '公司电话', value: '021-12345678' },
    { label: '主要联系人', value: '公司主要联系人' },
  ]);
  expect(contact).toMatchObject({ company_name: '候选A公司', customer_id: a });
  expect(contact.directory_fields).toEqual([
    { label: '邮箱', value: 'person-a@fixture.invalid' },
    { label: '职位', value: '采购负责人' },
    { label: '电话', value: '13800138000' },
    { label: '公司类型', value: '团体定制' },
    { label: '地区', value: '上海' },
    { label: '合作状态', value: '待建立合作' },
  ]);
  expect(JSON.stringify(mixed.retrieval)).not.toContain('候选B公司');
  expect(JSON.stringify(mixed.retrieval)).not.toMatch(/company-b-private|person-b-private/);
  classify = () => cls({ target: '沈项目', match_mode: 'name', entity_type: 'project' });
  const project = (await send(viewer, id, '找找沈项目').expect(200)).body.messages.at(-1);
  expect(project.retrieval.candidates).toMatchObject([
    {
      object: 'projects',
      company_name: '候选A公司',
      customer_id: a,
      directory_fields: [
        { label: '项目类型', value: '样衣' },
        { label: '项目阶段', value: '新建' },
        { label: '目标日期', value: '2026-11-18' },
      ],
    },
  ]);
  expect(JSON.stringify(calls)).not.toMatch(
    /A_CONTACT_PRIVATE|B_CONTACT_PRIVATE|B_BUSINESS_PRIVATE|PROJECT_DESCRIPTION_PRIVATE/,
  );
  expect(Object.keys(contact).sort()).toEqual([
    'company_name',
    'customer_id',
    'description',
    'directory_fields',
    'id',
    'kind',
    'object',
    'title',
  ]);
});
it('hydrates current basic fields for historical candidates without rewriting saved answers or stored references', async () => {
  const id = await createChat(viewer);
  const first = (await send(viewer, id, '有哪些姓沈的').expect(200)).body.messages.at(-1);
  await mutate(
    `UPDATE chat_messages SET model_retrieval=jsonb_set(model_retrieval,'{candidates}',
      (SELECT jsonb_agg((item - 'company_name') || '{"directory_fields":[{"label":"邮箱","value":"STALE_PRIVATE_EMAIL"}]}') FROM jsonb_array_elements(model_retrieval->'candidates') item))
     WHERE workspace_id=$1 AND chat_id=$2 AND id=$3`,
    [workspace, id, first.id],
  );
  const stored = (
    await db.query<{ body: string; model_retrieval: ChatRetrieval }>(
      'SELECT body,model_retrieval FROM chat_messages WHERE id=$1',
      [first.id],
    )
  ).rows[0];
  expect(stored.model_retrieval.candidates[0]).not.toHaveProperty('company_name');
  await mutate(
    "UPDATE customers SET name=$1,type='distributor',region='深圳',status='active' WHERE workspace_id=$2 AND id=$3",
    ['候选A公司新名称', workspace, a],
  );
  await mutate(
    "UPDATE people SET email='person-a-new@fixture.invalid',job_title='新职位',phone='' WHERE workspace_id=$1 AND id=$2",
    [workspace, firstPerson],
  );
  try {
    const reloaded = (
      await viewer.get(`/api/chats/${id}`).set(headers()).expect(200)
    ).body.messages.at(-1);
    expect(reloaded.body).toBe(first.body);
    expect(reloaded.retrieval.candidates.map((c: { id: string }) => c.id)).toEqual(
      first.retrieval.candidates.map((c: { id: string }) => c.id),
    );
    expect(reloaded.retrieval.candidates[0].company_name).toBe('候选A公司新名称');
    expect(reloaded.retrieval.candidates[0].directory_fields).toEqual([
      { label: '邮箱', value: 'person-a-new@fixture.invalid' },
      { label: '职位', value: '新职位' },
      { label: '公司类型', value: '经销商' },
      { label: '地区', value: '深圳' },
      { label: '合作状态', value: '合作中' },
    ]);
    expect(JSON.stringify(reloaded.retrieval)).not.toContain('STALE_PRIVATE_EMAIL');
    expect(
      (await db.query('SELECT body,model_retrieval FROM chat_messages WHERE id=$1', [first.id]))
        .rows[0],
    ).toEqual(stored);
    expect(JSON.stringify(calls)).not.toMatch(
      /A_CONTACT_PRIVATE|B_CONTACT_PRIVATE|B_BUSINESS_PRIVATE/,
    );
  } finally {
    await mutate(
      "UPDATE customers SET name=$1,type='group',region='上海',status='potential' WHERE workspace_id=$2 AND id=$3",
      ['候选A公司', workspace, a],
    );
    await mutate(
      "UPDATE people SET email='person-a@fixture.invalid',job_title='采购负责人',phone='13800138000' WHERE workspace_id=$1 AND id=$2",
      [workspace, firstPerson],
    );
  }
});

it('hydrates all directory objects in saved order and strips stale fields for inaccessible or wrong-parent references', async () => {
  const ref = (
    object: 'customers' | 'people' | 'projects',
    id: string,
    customer_id = a,
  ): AskSource => ({
    kind: 'entity',
    object,
    id,
    customer_id,
    title: '保留已存名称',
    description: '保留已存目录说明',
    company_name: 'STALE_COMPANY',
    directory_fields: [{ label: '邮箱', value: 'STALE_PRIVATE_EMAIL' }],
  });
  const refs = [
    ref('projects', firstProject),
    ref('customers', a),
    ref('people', firstPerson),
    ref('people', deniedPerson, b),
    ref('people', firstPerson, b),
  ];
  const result = await scoped(db, viewerId, workspace, (ctx) => hydrateChatCandidates(ctx, refs));
  expect(result.map(({ object, id, customer_id }) => ({ object, id, customer_id }))).toEqual(
    refs.map(({ object, id, customer_id }) => ({ object, id, customer_id })),
  );
  expect(result.map((r) => r.title)).toEqual(refs.map((r) => r.title));
  expect(result[0].directory_fields).toContainEqual({ label: '目标日期', value: '2026-11-18' });
  expect(result[1]).not.toHaveProperty('company_name');
  expect(result[1].directory_fields).toContainEqual({
    label: '公司邮箱',
    value: 'company-a@fixture.invalid',
  });
  expect(result[2].directory_fields).toContainEqual({
    label: '邮箱',
    value: 'person-a@fixture.invalid',
  });
  for (const inaccessible of result.slice(3)) {
    expect(inaccessible).not.toHaveProperty('company_name');
    expect(inaccessible).not.toHaveProperty('directory_fields');
  }
  expect(JSON.stringify(result)).not.toMatch(
    /STALE_PRIVATE_EMAIL|STALE_COMPANY|company-b-private|person-b-private|A_CONTACT_PRIVATE|B_CONTACT_PRIVATE|PROJECT_DESCRIPTION_PRIVATE/,
  );
});
it('keeps a unique directory result minimal until the candidate is chosen', async () => {
  const id = await createChat(viewer);
  const first = (await send(viewer, id, '有哪些姓沈的').expect(200)).body.messages.at(-1);
  expect(first.retrieval).toMatchObject({ status: 'candidates', total: 1 });
  expect(JSON.stringify(calls)).not.toContain('A_CONTACT_PRIVATE');
  classify = () =>
    cls({ action: 'select_candidate', target: null, match_mode: null, candidate_index: 1 });
  const next = (
    await send(viewer, id, '选择第1个候选', {
      candidate_selection: { message_id: first.id, index: 1 },
    }).expect(200)
  ).body.messages.at(-1);
  expect(next.retrieval.status).toBe('unique');
  expect(next.retrieval.candidates[0].directory_fields).toContainEqual({
    label: '邮箱',
    value: 'person-a@fixture.invalid',
  });
  expect(JSON.stringify(calls.at(-1))).toContain('A_CONTACT_PRIVATE');
  expect(JSON.stringify(calls.at(-1))).not.toContain('B_CONTACT_PRIVATE');
});
it('resolves 第二个 using saved order, resumes the original query, and deduplicates selection', async () => {
  const id = await createChat();
  await send(admin, id, '看下沈的资料').expect(200);
  const list = (await send(admin, id, '有哪些姓沈的').expect(200)).body.messages.at(-1);
  expect(list.retrieval.task.question).toBe('看下沈的资料');
  const request_id = randomUUID();
  const result = (await send(admin, id, '第二个', { request_id }).expect(200)).body.messages.at(-1);
  expect(result.retrieval.status).toBe('unique');
  expect(result.classification.target).toBe('沈候选乙');
  expect(JSON.stringify(calls.at(-1))).toContain('继续用户原任务：看下沈的资料');
  expect(JSON.stringify(calls.at(-1))).toContain('B_CONTACT_PRIVATE');
  expect(JSON.stringify(calls.at(-1))).not.toContain('A_CONTACT_PRIVATE');
  await send(admin, id, '第二个', { request_id }).expect(200);
  expect(calls).toHaveLength(6);
  expect((await db.query('SELECT count(*)::int n FROM outgoing_mail')).rows[0].n).toBe(0);
});
it('continues drafting after selecting a candidate and supports a complete-name followup', async () => {
  const id = await createChat();
  await send(admin, id, '给沈写微信跟进话术').expect(200);
  await send(admin, id, '有哪些姓沈的').expect(200);
  const next = (await send(admin, id, '继续拟稿').expect(200)).body.messages.at(-1);
  expect(next.classification.intent).toBe('起草内容');
  expect(next.retrieval.status).toBe('unique');
  expect(JSON.stringify(calls.at(-1))).toContain('给沈写微信跟进话术');
  const other = await createChat();
  await send(admin, other, '看下沈的资料').expect(200);
  await send(admin, other, '沈候选乙').expect(200);
  expect(calls.at(-1)!.snapshot.retrieval?.status).toBe('unique');
});
it('restricts bound chats and member access and supports compound surnames and no-match status', async () => {
  const bound = await createChat(admin, a);
  expect(
    (await send(admin, bound, '有哪些姓沈的').expect(200)).body.messages.at(-1).retrieval.total,
  ).toBe(1);
  expect(JSON.stringify(calls)).not.toContain('候选B公司');
  const id = await createChat();
  expect(
    (await send(admin, id, '有哪些姓欧阳的').expect(200)).body.messages.at(-1).retrieval,
  ).toMatchObject({ status: 'candidates', total: 1 });
  expect(
    (await send(admin, id, '有哪些姓魏的').expect(200)).body.messages.at(-1).retrieval,
  ).toMatchObject({ status: 'no_match', total: 0 });
});
it('does not guess from another chat, a stale button, an out-of-range index or a cancelled task', async () => {
  const id = await createChat();
  const list = (await send(admin, id, '有哪些姓沈的').expect(200)).body.messages.at(-1);
  const other = await createChat();
  const bad = (
    await send(admin, other, '第二个', {
      candidate_selection: { message_id: list.id, index: 2 },
    }).expect(200)
  ).body.messages.at(-1);
  expect(bad.retrieval.status).toBe('not_searched');
  expect(bad.sources).toEqual([]);
  await send(admin, id, '先不查了').expect(200);
  const after = (await send(admin, id, '第二个').expect(200)).body.messages.at(-1);
  expect(after.retrieval.status).toBe('not_searched');
  await send(admin, id, '第二个', {
    candidate_selection: { message_id: list.id, index: 11 },
  }).expect(400);
  expect(JSON.stringify(calls)).not.toMatch(/A_CONTACT_PRIVATE|B_CONTACT_PRIVATE/);
});
it('rejects an archived candidate without falling through to a similarly named contact', async () => {
  const id = await createChat();
  const list = (await send(admin, id, '有哪些姓沈的').expect(200)).body.messages.at(-1);
  await mutate('UPDATE people SET archived_at=now() WHERE workspace_id=$1 AND id=$2', [
    workspace,
    list.retrieval.candidates[1].id,
  ]);
  const result = (await send(admin, id, '第二个').expect(200)).body.messages.at(-1);
  expect(result.retrieval.status).toBe('not_searched');
  expect(JSON.stringify(calls.at(-1))).not.toMatch(/A_CONTACT_PRIVATE|B_CONTACT_PRIVATE/);
});
it('hides a revoked candidate list at the database boundary and cannot select from it', async () => {
  await admin
    .put(`/api/customers/${b}/access/${viewerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
  const id = await createChat(viewer);
  const list = (await send(viewer, id, '有哪些姓沈的').expect(200)).body.messages.at(-1);
  expect(list.retrieval.total).toBe(2);
  await admin
    .put(`/api/customers/${b}/access/${viewerId}`)
    .set(headers())
    .send({ access: null })
    .expect(200);
  const after = (await viewer.get(`/api/chats/${id}`).set(headers()).expect(200)).body;
  expect(after.messages.some((m: { id: string }) => m.id === list.id)).toBe(false);
  const result = (await send(viewer, id, '第二个').expect(200)).body.messages.at(-1);
  expect(result.retrieval.status).toBe('not_searched');
  expect(JSON.stringify(calls.at(-1))).not.toContain('B_CONTACT_PRIVATE');
});
it('rechecks the directory before saving a generated answer', async () => {
  const id = await createChat();
  answerHook = async () => {
    await mutate('UPDATE people SET name=$1 WHERE workspace_id=$2 AND name=$3', [
      '沈候选乙改名',
      workspace,
      '沈候选乙',
    ]);
  };
  await send(admin, id, '有哪些姓沈的').expect(409);
  expect((await admin.get(`/api/chats/${id}`).set(headers()).expect(200)).body.messages).toEqual(
    [],
  );
  await mutate('UPDATE people SET name=$1 WHERE workspace_id=$2 AND name=$3', [
    '沈候选乙',
    workspace,
    '沈候选乙改名',
  ]);
});

it('caps directory candidates and treats an unavailable displayed index as clarification', async () => {
  for (let i = 0; i < 12; i++) await person(a, `唐候选${i}`);
  classify = () => cls({ target: '唐' });
  const id = await createChat();
  const list = (await send(admin, id, '有哪些姓唐的').expect(200)).body.messages.at(-1);
  expect(list.retrieval).toMatchObject({ status: 'candidates', total: 12, truncated: true });
  expect(list.retrieval.candidates).toHaveLength(10);
  expect(calls.at(-1)!.snapshot.sources).toHaveLength(10);
  expect(JSON.stringify(calls.at(-1))).not.toContain('SYNTHETIC_CONTACT_PRIVATE');
  classify = () =>
    cls({ action: 'select_candidate', target: null, match_mode: null, candidate_index: 3 });
  const empty = await createChat();
  expect(
    (await send(admin, empty, '第三个').expect(200)).body.messages.at(-1).retrieval.status,
  ).toBe('not_searched');
});
it('cannot use a button for a replaced candidate list or recover its target after cancellation', async () => {
  const id = await createChat();
  const old = (await send(admin, id, '看下沈的资料').expect(200)).body.messages.at(-1);
  await send(admin, id, '有哪些姓沈的').expect(200);
  const expired = (
    await send(admin, id, '选择第2个候选', {
      candidate_selection: { message_id: old.id, index: 2 },
    }).expect(200)
  ).body.messages.at(-1);
  expect(expired.retrieval.status).toBe('not_searched');
  await send(admin, id, '先不查了').expect(200);
  await send(admin, id, '第二个').expect(200);
  const classifier = calls.at(-2)!;
  expect(classifier.snapshot.warnings.some((w) => w.startsWith('最近讨论目标'))).toBe(false);
  expect(classifier.snapshot.warnings.some((w) => w.startsWith('当前候选目录'))).toBe(false);
});
it('does not expose a unique profile for a one-character person lookup and does not let an identity gap block candidate search', async () => {
  classify = () => cls({ action: 'lookup_entity', match_mode: 'name' });
  const id = await createChat(viewer);
  const result = (await send(viewer, id, '看下沈的资料').expect(200)).body.messages.at(-1);
  expect(result.retrieval.status).toBe('candidates');
  expect(JSON.stringify(calls)).not.toContain('A_CONTACT_PRIVATE');
  classify = () => cls({ missing: ['完整姓名或其他可区分信息'] });
  const next = (await send(viewer, id, '有哪些姓沈的').expect(200)).body.messages.at(-1);
  expect(next.retrieval.status).toBe('candidates');
  expect(next.classification.missing).toEqual(['选择当前候选']);
});
