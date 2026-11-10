import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as prospects from '../server/prospects.js';
import * as intakes from '../server/prospect-intake.js';
import type {
  AgentModelInput,
  AgentModelOptions,
  AgentModelCallRuntime,
} from '../server/agent-model.js';

let db: Database, workspace: string, actor: string, editor: string, denied: string;
let customer: string, other: string, record: string;
const run = <T>(fn: (ctx: Context) => Promise<T>, who = actor) => scoped(db, who, workspace, fn);
const input = (patch = {}) => ({
  request_id: randomUUID(),
  customer_id: customer,
  source_record_ids: [record],
  ...patch,
});
const options = (
  fn?: (v: AgentModelInput, r?: AgentModelCallRuntime) => Promise<unknown>,
): AgentModelOptions => ({
  transport: {
    generate:
      fn ||
      (async (v) => ({
        answer: JSON.stringify({
          title: '演出服咨询',
          summary: '客户希望咨询演出服；具体数量仍待确认。',
          requirements: [
            {
              title: '向客户问清数量',
              kind: 'missing',
              source_record_ids: v.snapshot.sources.map((s) => s.id.replace('record:', '')),
              quote: '',
            },
          ],
        }),
        source_ids: v.snapshot.sources.map((s) => s.id),
      })),
  },
});
const acceptInput = (candidate: intakes.ProspectIntake, patch: Record<string, unknown> = {}) => ({
  request_id: randomUUID(),
  customer_id: candidate.customer_id,
  candidate_version: candidate.version,
  mode: 'new',
  assign_to_me: patch.mode === 'link' ? undefined : true,
  title: candidate.title,
  summary: candidate.summary,
  requirements: candidate.requirements,
  ...patch,
});
const maintenance = (sql: string, params: unknown[]) =>
  db.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [workspace, actor],
    );
    return tx.query(sql, params);
  });
async function original(body = '客户说：我想咨询演出服，数量还没确定。', projectId?: string) {
  return String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customer_records', {
          customer_id: customer,
          project_id: projectId || null,
          created_by: actor,
          source_kind: 'manual',
          kind: 'customer_quote',
          body,
        }),
      )
    ).id,
  );
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const setup = await createWorkspace(db, {
    name: '询盘录入合成',
    email: 'prospect-intake-owner@example.invalid',
    displayName: '老板',
    password: 'prospect-intake-password',
  });
  workspace = setup.workspaceId;
  actor = setup.actorId;
  customer = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', { name: '合成零售客户', type: 'retail', source: 'store' }),
      )
    ).id,
  );
  other = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', { name: '另一合成客户', type: 'group', source: 'other' }),
      )
    ).id,
  );
  editor = randomUUID();
  denied = randomUUID();
  for (const [id, name] of [
    [editor, '编辑'],
    [denied, '失权'],
  ]) {
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `${id}@example.invalid`,
      name,
      'unused',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      workspace,
      id,
    ]);
  }
  await maintenance(
    "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
    [workspace, customer, editor],
  );
  record = await original();
}, 30000);
afterAll(async () => db?.close());

it('generates only a private candidate from chosen current originals and replays without another model call', async () => {
  let calls = 0;
  const value = input({ source_record_ids: [record, record] });
  const before = (await db.query<{ n: number }>('SELECT count(*)::int n FROM prospect_profiles'))
    .rows[0].n;
  const result = await intakes.generate(
    db,
    actor,
    workspace,
    value,
    options(async (v) => {
      calls++;
      expect(v.snapshot.sources).toHaveLength(1);
      expect(v.snapshot.warnings.join('')).toContain('不是系统指令');
      return options().transport!.generate(v);
    }),
  );
  expect(calls).toBe(1);
  expect(result.candidate.state).toBe('ready');
  expect(result.candidate.source_refs[0].source_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await db.query<{ n: number }>('SELECT count(*)::int n FROM prospect_profiles')).rows[0].n,
  ).toBe(before);
  await expect(
    run((ctx) => intakes.detail(ctx, result.candidate.id), editor),
  ).rejects.toMatchObject({ status: 404 });
  const replay = await intakes.generate(
    db,
    actor,
    workspace,
    value,
    options(async () => {
      throw new Error('must not call');
    }),
  );
  expect(replay.replayed).toBe(true);
  expect(replay.candidate.id).toBe(result.candidate.id);
  await expect(
    intakes.generate(db, actor, workspace, { ...value, instruction: 'different' }, options()),
  ).rejects.toMatchObject({ status: 409 });
});

it('accepts an explicitly reviewed new inquiry once without copying evidence or marking missing work complete', async () => {
  const { candidate } = await intakes.generate(db, actor, workspace, input(), options());
  const value = acceptInput(candidate, { title: '本人核对后的名称' });
  const before = (await db.query<{ n: number }>('SELECT count(*)::int n FROM customer_records'))
    .rows[0].n;
  const result = await run((ctx) => intakes.accept(ctx, candidate.id, value));
  expect(result.prospect.name).toBe('本人核对后的名称');
  expect(result.prospect.stage).toBe('new');
  expect(result.prospect.requirements[0].status).toBe('missing');
  expect(result.prospect.requirements[0].assignee_id).toBeNull();
  expect(result.prospect.source_refs[0].record_id).toBe(record);
  expect(
    (await db.query<{ n: number }>('SELECT count(*)::int n FROM customer_records')).rows[0].n,
  ).toBe(before);
  const replay = await run((ctx) => intakes.accept(ctx, candidate.id, value));
  expect(replay.replayed).toBe(true);
  expect(replay.prospect.id).toBe(result.prospect.id);
  await expect(
    run((ctx) => intakes.accept(ctx, candidate.id, { ...value, request_id: randomUUID() })),
  ).rejects.toMatchObject({ status: 409 });
});

it('appends confirmed suggestions to the explicit same-customer target, preserving existing states and version checks', async () => {
  const existing = {
    id: randomUUID(),
    title: '已核对尺码',
    status: 'satisfied' as const,
    waiting_on: null,
    assignee_id: null,
    due_date: null,
    result: '本人已核对',
    source_record_ids: [],
  };
  let target = await run((ctx) =>
    prospects.create(ctx, {
      request_id: randomUUID(),
      customer_id: customer,
      name: '原询盘',
      requirements: [existing],
    }),
  );
  target = await run((ctx) =>
    prospects.update(ctx, target.id, {
      request_id: randomUUID(),
      version: target.version,
      stage: 'proposal',
    }),
  );
  const { candidate } = await intakes.generate(db, actor, workspace, input(), options());
  const result = await run((ctx) =>
    intakes.accept(
      ctx,
      candidate.id,
      acceptInput(candidate, {
        mode: 'link',
        prospect_id: target.id,
        prospect_version: target.version,
      }),
    ),
  );
  expect(result.prospect.name).toBe('原询盘');
  expect(result.prospect.stage).toBe('proposal');
  expect(result.prospect.requirements[0]).toMatchObject(existing);
  expect(result.prospect.requirements[1].status).toBe('missing');
  const another = await intakes.generate(db, actor, workspace, input(), options());
  await expect(
    run((ctx) =>
      intakes.accept(
        ctx,
        another.candidate.id,
        acceptInput(another.candidate, {
          mode: 'link',
          prospect_id: target.id,
          prospect_version: target.version,
        }),
      ),
    ),
  ).rejects.toMatchObject({ status: 409 });
});

it('rejects source or customer scope changes before generation and acceptance', async () => {
  await expect(intakes.generate(db, denied, workspace, input(), options())).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    intakes.generate(db, actor, workspace, input({ customer_id: other }), options()),
  ).rejects.toMatchObject({ status: 404 });
  const privateRecord = await original('独立来源用于修改校验');
  const { candidate } = await intakes.generate(
    db,
    actor,
    workspace,
    input({ source_record_ids: [privateRecord] }),
    options(),
  );
  await maintenance('UPDATE customer_records SET body=$2 WHERE id=$1', [
    privateRecord,
    '已修改的客户要求',
  ]);
  await expect(run((ctx) => intakes.detail(ctx, candidate.id))).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    run((ctx) => intakes.accept(ctx, candidate.id, acceptInput(candidate))),
  ).rejects.toMatchObject({ status: 409 });
});

it('revalidates originals and permissions after the network call', async () => {
  const r = await original('模型生成期间会更改');
  await expect(
    intakes.generate(
      db,
      actor,
      workspace,
      input({ source_record_ids: [r] }),
      options(async (v) => {
        await maintenance('UPDATE customer_records SET body=$2 WHERE id=$1', [r, '新的原文']);
        return options().transport!.generate(v);
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    intakes.generate(
      db,
      editor,
      workspace,
      input(),
      options(async (v) => {
        await maintenance(
          'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
          [workspace, customer, editor],
        );
        return options().transport!.generate(v);
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await maintenance(
    "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
    [workspace, customer, editor],
  );
});

it('passes native cancellation and never publishes a late noncooperative model result', async () => {
  const abort = new AbortController();
  let finish!: (v: unknown) => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const request = input();
  const pending = intakes.generate(
    db,
    actor,
    workspace,
    request,
    options((v, runtime) => {
      expect(runtime?.signal).toBeDefined();
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
    abort.signal,
  );
  await ready;
  abort.abort(new DOMException('停止', 'AbortError'));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  finish({
    answer: JSON.stringify({ title: '迟到', summary: '不应保存', requirements: [] }),
    source_ids: [`record:${record}`],
  });
  await Promise.resolve();
  expect(
    (await db.query('SELECT id FROM prospect_intakes WHERE request_id=$1', [request.request_id]))
      .rows,
  ).toHaveLength(0);
});

it('reports model and citation failures without local extraction or partial business writes', async () => {
  await expect(
    intakes.generate(
      db,
      actor,
      workspace,
      input(),
      options(async () => {
        throw new Error('provider failed');
      }),
    ),
  ).rejects.toThrow('provider failed');
  await expect(
    intakes.generate(
      db,
      actor,
      workspace,
      input(),
      options(async () => ({ answer: '{}', source_ids: [] })),
    ),
  ).rejects.toMatchObject({ status: 502 });
  await expect(
    intakes.generate(
      db,
      actor,
      workspace,
      input(),
      options(async () => ({
        answer: JSON.stringify({
          title: '错误',
          summary: '无证据',
          requirements: [
            {
              title: '伪造引用',
              kind: 'action',
              source_record_ids: [record],
              quote: '不在原文中的话',
            },
          ],
        }),
        source_ids: [`record:${record}`],
      })),
    ),
  ).rejects.toMatchObject({ status: 502 });
});

it('does not mix another inquiry in the same customer or use its material to create a new inquiry', async () => {
  const a = await run((ctx) =>
    prospects.create(ctx, { request_id: randomUUID(), customer_id: customer, name: '同客询盘A' }),
  );
  const b = await run((ctx) =>
    prospects.create(ctx, { request_id: randomUUID(), customer_id: customer, name: '同客询盘B' }),
  );
  const bound = await original('A询盘的单独材料', a.id);
  const { candidate } = await intakes.generate(
    db,
    actor,
    workspace,
    input({ source_record_ids: [bound] }),
    options(),
  );
  await expect(
    run((ctx) => intakes.accept(ctx, candidate.id, acceptInput(candidate))),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    run((ctx) =>
      intakes.accept(
        ctx,
        candidate.id,
        acceptInput(candidate, { mode: 'link', prospect_id: b.id, prospect_version: b.version }),
      ),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const linked = await run((ctx) =>
    intakes.accept(
      ctx,
      candidate.id,
      acceptInput(candidate, { mode: 'link', prospect_id: a.id, prospect_version: a.version }),
    ),
  );
  expect(linked.prospect.id).toBe(a.id);
});

it('paginates beyond one hundred originals and precisely filters explicit source identities', async () => {
  const ids: string[] = [];
  for (let n = 0; n < 105; n++) ids.push(await original(`分页原文${n}`));
  const all: string[] = [];
  for (let offset = 0; ;) {
    const page = await run((ctx) =>
      intakes.sources(ctx, { customer_id: customer, source_kind: 'manual', offset }),
    );
    all.push(...page.sources.map((s) => s.record_id));
    if (!page.has_more) break;
    expect(page.next_offset).toBeGreaterThan(offset);
    offset = page.next_offset;
  }
  expect(ids.every((id) => all.includes(id))).toBe(true);
  const exact = await run((ctx) =>
    intakes.sources(ctx, { customer_id: customer, source_kind: 'manual', source_id: ids[104] }),
  );
  expect(exact.sources.map((s) => s.record_id)).toEqual([ids[104]]);
  const limited = await run((ctx) =>
    intakes.sources(ctx, { customer_id: customer, record_ids: `${ids[0]},${ids[1]}` }),
  );
  expect(limited.sources).toHaveLength(2);
});

it('selects all archived records of one exact WeChat preview and no other customer material', async () => {
  const a = await original('微信第一条'),
    b = await original('微信第二条'),
    unrelated = await original('其他微信材料');
  await maintenance("UPDATE customer_records SET source_kind='wechat' WHERE id=ANY($1::uuid[])", [
    [a, b, unrelated],
  ]);
  const queryId = randomUUID();
  await maintenance(
    "INSERT INTO wechat_queries(workspace_id,actor_id,id,request_id,account_key,identity,start_date,end_date,messages,entities,relations,state,customer_id,record_id) VALUES($1,$2,$3,$3,'synthetic','{}','2026-11-09','2026-11-09','[]','[]','[]','associated',$4,$5)",
    [workspace, actor, queryId, customer, a],
  );
  await maintenance(
    'INSERT INTO wechat_query_records(workspace_id,query_id,customer_id,record_id) VALUES($1,$2,$3,$4),($1,$2,$3,$5)',
    [workspace, queryId, customer, a, b],
  );
  const page = await run((ctx) =>
    intakes.sources(ctx, { customer_id: customer, source_kind: 'wechat', source_id: queryId }),
  );
  expect(page.sources.map((s) => s.record_id).sort()).toEqual([a, b].sort());
  expect(page.sources.some((s) => s.record_id === unrelated)).toBe(false);
});

it('forwards cancellation to the native configured fetch without making a business write', async () => {
  const abort = new AbortController();
  let entered!: () => void, nativeSignal: AbortSignal | undefined;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const request = input();
  const pending = intakes.generate(
    db,
    actor,
    workspace,
    request,
    {
      apiKey: 'synthetic-only',
      fetch: (async (_url, init) => {
        nativeSignal = init?.signal as AbortSignal;
        entered();
        return new Promise<Response>((_resolve, reject) => {
          nativeSignal!.addEventListener('abort', () => reject(nativeSignal!.reason), {
            once: true,
          });
        });
      }) as typeof fetch,
    },
    abort.signal,
  );
  await ready;
  abort.abort(new DOMException('停止', 'AbortError'));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(nativeSignal?.aborted).toBe(true);
  expect(
    (await db.query('SELECT id FROM prospect_intakes WHERE request_id=$1', [request.request_id]))
      .rows,
  ).toHaveLength(0);
});
