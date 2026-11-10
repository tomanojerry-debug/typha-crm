import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as chats from '../server/chats.js';
import * as notes from '../server/notes.js';
import { createPerson } from '../server/people.js';
import { prepareNoteDraft, saveAgentAnswerAsNoteDraft } from '../server/note-agent.js';
import type { AgentModelInput, AgentModelOptions } from '../server/agent-model.js';
import type { SaveNoteDraft } from '../shared/notes.js';
import type { AskSource } from '../shared/ask.js';

let db: Database;
let workspace: string, actor: string, editor: string, viewer: string, denied: string;
let customer: string, otherCustomer: string, project: string, otherProject: string, person: string;
let sourceRecord: string;
const run = <T>(fn: (ctx: Context) => Promise<T>, who = actor) => scoped(db, who, workspace, fn);
const input = (patch = {}) => ({
  request_id: randomUUID(),
  customer_id: customer,
  project_id: project,
  person_ids: [],
  source_record_ids: [sourceRecord],
  ...patch,
});
const model = (generate?: (value: AgentModelInput) => Promise<unknown>): AgentModelOptions => ({
  transport: {
    generate:
      generate ||
      (async (value) => ({
        answer: '合成来源整理：交期仍待核实，需要继续确认。',
        source_ids: value.snapshot.sources.map((source) => source.id),
      })),
  },
});
async function manualRecord(body = '合成客户提出希望交期提前，我方说明仍待工厂核实。') {
  return String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customer_records', {
          customer_id: customer,
          project_id: project,
          created_by: actor,
          source_kind: 'manual',
          kind: 'inference',
          body,
        }),
      )
    ).id,
  );
}
const draftInput = (patch: Partial<SaveNoteDraft> = {}): SaveNoteDraft => ({
  request_id: randomUUID(),
  version: 0,
  note_id: null,
  base_revision: 0,
  customer_id: customer,
  project_id: project,
  person_ids: [],
  title: '手写跟进',
  blocks: [
    { id: 'manual', type: 'paragraph', origin: 'original', text: '员工新增手写内容', sources: [] },
  ],
  ...patch,
});
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const created = await createWorkspace(db, {
    name: '笔记Agent合成验收',
    email: 'note-agent-owner@example.invalid',
    displayName: '合成管理员',
    password: 'note-agent-fixture-password',
  });
  workspace = created.workspaceId;
  actor = created.actorId;
  customer = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', {
          name: '甲公司（合成）',
          type: 'group',
          source: 'other',
        }),
      )
    ).id,
  );
  otherCustomer = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', {
          name: '乙公司（合成）',
          type: 'group',
          source: 'other',
        }),
      )
    ).id,
  );
  project = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '甲项目',
          type: 'custom',
          stage: 'new',
        }),
      )
    ).id,
  );
  otherProject = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '甲另一项目',
          type: 'custom',
          stage: 'new',
        }),
      )
    ).id,
  );
  person = (await run((ctx) => createPerson(ctx, { customer_id: customer, name: '合成联系人' })))
    .id;
  for (const name of ['editor', 'viewer', 'denied']) {
    const id = randomUUID();
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `note-agent-${name}@example.invalid`,
      name,
      'unused',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      workspace,
      id,
    ]);
    if (name === 'editor') editor = id;
    if (name === 'viewer') viewer = id;
    if (name === 'denied') denied = id;
  }
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor'),($1,$2,$4,'viewer')",
      [workspace, customer, editor, viewer],
    ),
  );
  sourceRecord = await manualRecord();
}, 30000);
afterAll(async () => db?.close());

it('calls the configured model and creates only an actor-private derived draft, with canonical source deduplication', async () => {
  let calls = 0;
  const recordCount = (
    await db.query<{ count: number }>('SELECT count(*)::int AS count FROM customer_records')
  ).rows[0].count;
  const value = input({ source_record_ids: [sourceRecord, sourceRecord] });
  const result = await prepareNoteDraft(
    db,
    actor,
    workspace,
    value,
    model(async (value) => {
      calls++;
      expect(value.phase).toBe('answer');
      expect(value.snapshot.sources).toHaveLength(1);
      expect(value.task_instructions).toContain('未确认');
      return {
        answer: '合成客户交期仍待工厂核实。',
        source_ids: value.snapshot.sources.map((source) => source.id),
      };
    }),
  );
  expect(calls).toBe(1);
  expect(result.draft.customer_id).toBe(customer);
  expect(result.draft.project_id).toBe(project);
  expect(result.draft.blocks[0].origin).toBe('derived');
  expect(result.draft.blocks[0].sources).toHaveLength(1);
  expect(result.draft.blocks[0].sources[0]).toMatchObject({ record_id: sourceRecord });
  expect(result.draft.blocks[0].sources[0].source_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM customer_records'))
      .rows[0].count,
  ).toBe(recordCount);
  await expect(run((ctx) => notes.noteDraft(ctx, result.draft.id), editor)).rejects.toMatchObject({
    status: 404,
  });
  const replay = await prepareNoteDraft(
    db,
    actor,
    workspace,
    value,
    model(async () => {
      throw new Error('replay must not call model');
    }),
  );
  expect(replay.replayed).toBe(true);
  expect(replay.draft.id).toBe(result.draft.id);
  await expect(
    prepareNoteDraft(db, actor, workspace, { ...value, instruction: 'different input' }, model()),
  ).rejects.toMatchObject({ status: 409 });
});

it('rejects read-only, denied, foreign-customer, different-project and unrelated-person source scopes before model execution', async () => {
  const noCall = model(async () => {
    throw new Error('must not call model outside scope');
  });
  await expect(prepareNoteDraft(db, viewer, workspace, input(), noCall)).rejects.toMatchObject({
    status: 403,
  });
  await expect(prepareNoteDraft(db, denied, workspace, input(), noCall)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    prepareNoteDraft(
      db,
      actor,
      workspace,
      input({ customer_id: otherCustomer, project_id: null }),
      noCall,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    prepareNoteDraft(db, actor, workspace, input({ project_id: otherProject }), noCall),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    prepareNoteDraft(db, actor, workspace, input({ person_ids: [person] }), noCall),
  ).rejects.toMatchObject({ status: 404 });
});

it('does not accept client-supplied actors, answer bodies or undeclared source kinds', async () => {
  await expect(
    prepareNoteDraft(db, actor, workspace, input({ actor_id: editor }), model()),
  ).rejects.toThrow();
  await expect(
    saveAgentAnswerAsNoteDraft(
      db,
      actor,
      workspace,
      {
        request_id: randomUUID(),
        chat_id: randomUUID(),
        message_id: randomUUID(),
        body: 'fake answer',
      },
      model(),
    ),
  ).rejects.toThrow();
});

it('preserves the full existing private draft and appends model output without publishing it', async () => {
  const d = await run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), draftInput()));
  const result = await prepareNoteDraft(
    db,
    actor,
    workspace,
    input({ draft_id: d.id, draft_version: d.version }),
    model(),
  );
  expect(result.draft.id).toBe(d.id);
  expect(result.draft.version).toBe(d.version + 1);
  expect(result.draft.blocks).toHaveLength(2);
  expect(result.draft.blocks[0]).toEqual(d.blocks[0]);
  expect(result.draft.blocks[1].origin).toBe('derived');
  expect((await run((ctx) => notes.listNotes(ctx, { customer_id: customer }))).notes).toHaveLength(
    0,
  );
});

it('fails visibly on missing model configuration and malformed or unsupported model citations', async () => {
  await expect(prepareNoteDraft(db, actor, workspace, input(), {})).rejects.toMatchObject({
    status: 503,
  });
  for (const output of [
    { answer: '没有来源', source_ids: [] },
    { answer: '非法来源', source_ids: ['record:outside'] },
    { answer: '<think>internal</think>', source_ids: [] },
  ]) {
    const value = input();
    await expect(
      prepareNoteDraft(
        db,
        actor,
        workspace,
        value,
        model(async () => output),
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(
      (await db.query('SELECT id FROM note_drafts WHERE id=$1', [value.request_id])).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query('SELECT request_id FROM note_agent_requests WHERE request_id=$1', [
          value.request_id,
        ])
      ).rows,
    ).toHaveLength(0);
  }
});

it('invalidates a running generation if the canonical original changes, without saving stale content', async () => {
  const record = await manualRecord('变更前：交期仍待核实。');
  const value = input({ source_record_ids: [record] });
  await expect(
    prepareNoteDraft(
      db,
      actor,
      workspace,
      value,
      model(async (request) => {
        await db.transaction(async (tx) => {
          await tx.query(
            "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
            [workspace, actor],
          );
          await tx.query('UPDATE customer_records SET body=$2 WHERE id=$1', [
            record,
            '变更后：客户取消了原交期要求。',
          ]);
        });
        return {
          answer: '旧结果不可保存',
          source_ids: request.snapshot.sources.map((source) => source.id),
        };
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.query('SELECT id FROM note_drafts WHERE id=$1', [value.request_id])).rows,
  ).toHaveLength(0);
});

it('invalidates a running generation after customer access is revoked', async () => {
  const value = input();
  try {
    await expect(
      prepareNoteDraft(
        db,
        editor,
        workspace,
        value,
        model(async (request) => {
          await run((ctx) =>
            ctx.tx.query(
              'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
              [workspace, customer, editor],
            ),
          );
          return {
            answer: '失权后不能保存',
            source_ids: request.snapshot.sources.map((source) => source.id),
          };
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await db.query('SELECT id FROM note_drafts WHERE id=$1', [value.request_id])).rows,
    ).toHaveLength(0);
  } finally {
    await run((ctx) =>
      ctx.tx.query(
        "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor') ON CONFLICT DO NOTHING",
        [workspace, customer, editor],
      ),
    );
  }
});

it('retains a newer human draft when generation finishes after concurrent editing', async () => {
  const d = await run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), draftInput()));
  await expect(
    prepareNoteDraft(
      db,
      actor,
      workspace,
      input({ draft_id: d.id, draft_version: d.version }),
      model(async (request) => {
        await run((ctx) =>
          notes.saveNoteDraft(
            ctx,
            d.id,
            draftInput({
              version: d.version,
              blocks: [{ ...d.blocks[0], text: '新的人工修改必须保留' }],
            }),
          ),
        );
        return {
          answer: '迟到模型结果',
          source_ids: request.snapshot.sources.map((source) => source.id),
        };
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await run((ctx) => notes.noteDraft(ctx, d.id))).blocks[0].text).toBe(
    '新的人工修改必须保留',
  );
});

it('serializes the same request and replays a completed result without duplicate model calls or blocks', async () => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const value = input();
  const first = prepareNoteDraft(
    db,
    actor,
    workspace,
    value,
    model(async (request) => {
      entered();
      await gate;
      return {
        answer: '唯一模型结果',
        source_ids: request.snapshot.sources.map((source) => source.id),
      };
    }),
  );
  await started;
  await expect(prepareNoteDraft(db, actor, workspace, value, model())).rejects.toMatchObject({
    status: 409,
  });
  release();
  const result = await first;
  const again = await prepareNoteDraft(
    db,
    actor,
    workspace,
    value,
    model(async () => {
      throw new Error('duplicate generate');
    }),
  );
  expect(again.draft.id).toBe(result.draft.id);
  expect(again.draft.blocks).toHaveLength(1);
});

it('does not let a late worker overwrite another request lease', async () => {
  const value = input();
  const replacement = randomUUID();
  await expect(
    prepareNoteDraft(
      db,
      actor,
      workspace,
      value,
      model(async (request) => {
        await db.query('UPDATE note_agent_requests SET claim_token=$2 WHERE request_id=$1', [
          value.request_id,
          replacement,
        ]);
        return {
          answer: '迟到结果',
          source_ids: request.snapshot.sources.map((source) => source.id),
        };
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const rows = (
    await db.query<{ claim_token: string; state: string }>(
      'SELECT claim_token,state FROM note_agent_requests WHERE request_id=$1',
      [value.request_id],
    )
  ).rows;
  expect(rows).toEqual([{ claim_token: replacement, state: 'running' }]);
  expect(
    (await db.query('SELECT id FROM note_drafts WHERE id=$1', [value.request_id])).rows,
  ).toHaveLength(0);
});

it('reorganizes a persisted answer using only currently authorized originals and keeps the server entity scope', async () => {
  const id = randomUUID(),
    messageRequest = randomUUID();
  await run((ctx) =>
    chats.createChat(ctx, { id, title: '项目问答（合成）', customer_id: customer }),
  );
  const source: AskSource = {
    kind: 'record',
    id: sourceRecord,
    customer_id: customer,
    project_id: project,
    title: '原始依据',
    description: '合成',
  };
  const messageId = await run((ctx) =>
    chats.append(
      ctx,
      id,
      messageRequest,
      'assistant',
      'OLD_ANSWER_PRIVATE_SENTINEL不得当作新证据',
      null,
      'message',
      {
        model: 'MiniMax-M3.1-Flash',
        sources: [source],
        basis: [source],
        digest: 'fixture-original-digest',
        scope: { kind: 'entity', object: 'projects', customer_id: customer, record_id: project },
      },
    ),
  );
  const value = { request_id: randomUUID(), chat_id: id, message_id: messageId };
  const result = await saveAgentAnswerAsNoteDraft(
    db,
    actor,
    workspace,
    value,
    model(async (request) => {
      expect(JSON.stringify(request)).not.toContain('OLD_ANSWER_PRIVATE_SENTINEL');
      expect(request.snapshot.sources[0].body).toContain('仍待工厂核实');
      return {
        answer: '按当前原文重整，交期仍待核实。',
        source_ids: request.snapshot.sources.map((source) => source.id),
      };
    }),
  );
  expect(result.regenerated).toBe(true);
  expect(result.draft.project_id).toBe(project);
  expect(result.draft.blocks[0].origin).toBe('derived');
  await expect(
    saveAgentAnswerAsNoteDraft(
      db,
      editor,
      workspace,
      { ...value, request_id: randomUUID() },
      model(),
    ),
  ).rejects.toMatchObject({ status: 404 });
  const viaRequest = await saveAgentAnswerAsNoteDraft(
    db,
    actor,
    workspace,
    { request_id: randomUUID(), chat_id: id, message_request_id: messageRequest },
    model(),
  );
  expect(viaRequest.draft.project_id).toBe(project);
});

it('does not claim the model draft is saved if the resulting content exceeds the existing note budget', async () => {
  const d = await run((ctx) =>
    notes.saveNoteDraft(
      ctx,
      randomUUID(),
      draftInput({
        blocks: [
          {
            id: 'long',
            type: 'paragraph',
            origin: 'original',
            text: '长'.repeat(9990),
            sources: [],
          },
        ],
      }),
    ),
  );
  await expect(
    prepareNoteDraft(
      db,
      actor,
      workspace,
      input({ draft_id: d.id, draft_version: d.version }),
      model(),
    ),
  ).rejects.toMatchObject({ status: 413 });
  const unchanged = await run((ctx) => notes.noteDraft(ctx, d.id));
  expect(unchanged.version).toBe(d.version);
  expect(unchanged.blocks).toHaveLength(1);
});

it('keeps every linked contact when organizing a multi-person note and rejects sources missing any one contact', async () => {
  const second = (
    await run((ctx) => createPerson(ctx, { customer_id: customer, name: '合成第二联系人' }))
  ).id;
  const third = (
    await run((ctx) => createPerson(ctx, { customer_id: customer, name: '合成未关联联系人' }))
  ).id;
  const d = await run((ctx) =>
    notes.saveNoteDraft(ctx, randomUUID(), draftInput({ person_ids: [person, second] })),
  );
  const published = await run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d.id,
      draft_version: d.version,
      base_revision: 0,
    }),
  );
  const result = await prepareNoteDraft(
    db,
    actor,
    workspace,
    input({ person_ids: [person, second], source_record_ids: [published.record_id] }),
    model(),
  );
  expect(result.draft.person_ids).toEqual([person, second]);
  await expect(
    prepareNoteDraft(
      db,
      actor,
      workspace,
      input({ person_ids: [person, third], source_record_ids: [published.record_id] }),
      model(async () => {
        throw new Error('scope rejection must precede model');
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
});
