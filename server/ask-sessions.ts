import { createHash, randomUUID } from 'node:crypto';
import type { AskAnswer, AskScope, AskSource } from '../shared/ask.js';
import type { Chat, ChatOrigin } from '../shared/chat.js';
import { objectNames } from '../shared/connections.js';
import { agentHistoryMessageLimit, type AgentTurn } from './agent-model.js';
import { ApiError, type Context } from './security.js';
import { context, evidence, scopeInput } from './ask.js';
import * as relationships from './relationships.js';

export type AskOrigin = ChatOrigin;
export type AskChat = Chat & { origin: AskOrigin };
export type AskClaim = {
  chat_id: string;
  request_id: string;
  token: string;
  digest: string;
  origin: AskOrigin;
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const sameAskScope = (a: AskScope, b: AskScope) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Always revalidate captured source scope under the current actor's RLS. */
export async function validateAskSession(
  ctx: Context,
  id: string,
  expectedScope?: AskScope,
): Promise<AskChat> {
  const chat = (
    await ctx.tx.query<AskChat>(
      `SELECT c.id,c.title,c.customer_id,r.name AS customer_name,c.updated_at,c.origin
     FROM agent_chats c LEFT JOIN customers r ON r.workspace_id=c.workspace_id AND r.id=c.customer_id
     WHERE c.workspace_id=$1 AND c.id=$2`,
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!chat) throw new ApiError(404, '对话不存在或无权访问');
  if (chat.origin?.kind !== 'ask') throw new ApiError(409, '此对话不是页面问答，请新建对话');
  const scope = scopeInput.parse(chat.origin.scope);
  if (expectedScope && !sameAskScope(scope, expectedScope))
    throw new ApiError(409, '此对话已绑定其他页面范围，请新建对话');
  if (chat.customer_id !== (scope.kind === 'entity' ? scope.customer_id : null))
    throw new ApiError(409, '对话来源与客户范围不一致');
  await context(ctx, { scope });
  return chat;
}
export async function askBasisReadable(ctx: Context, scope: AskScope, sources: AskSource[]) {
  for (const source of sources) {
    if (scope.kind === 'entity' && source.customer_id !== scope.customer_id) return false;
    try {
      if (source.kind === 'entity') {
        if (!source.object) return false;
        const row = await relationships.record(ctx, source.object, source.id, source.customer_id);
        if (row.archived_at) return false;
      } else {
        if (scope.kind !== 'entity') return false;
        await evidence(ctx, { scope, kind: source.kind, id: source.id });
      }
    } catch (error) {
      if (error instanceof ApiError && [403, 404, 409].includes(error.status)) return false;
      throw error;
    }
  }
  return true;
}
export async function loadAskHistory(ctx: Context, id: string): Promise<AgentTurn[]> {
  const chat = await validateAskSession(ctx, id);
  const rows = (
    await ctx.tx.query<{
      role: 'user' | 'assistant';
      body: string;
      request_id: string;
      model_basis: AskSource[];
    }>(
      `SELECT role,body,request_id,model_basis FROM chat_messages
      WHERE workspace_id=$1 AND chat_id=$2 ORDER BY position DESC LIMIT $3`,
      [ctx.workspaceId, id, agentHistoryMessageLimit],
    )
  ).rows.reverse();
  const readable = new Map<string, boolean>();
  for (const row of rows)
    if (!readable.has(row.request_id))
      readable.set(row.request_id, await askBasisReadable(ctx, chat.origin.scope, row.model_basis));
  return rows
    .filter((r) => readable.get(r.request_id))
    .map((r) => ({ role: r.role, content: r.body }));
}
export async function prepareAskSession(
  ctx: Context,
  input: {
    chat_id: string;
    request_id: string;
    scope: AskScope;
    question: string;
    action?: string;
  },
): Promise<{ replay: AskAnswer } | { claim: AskClaim; history: AgentTurn[] }> {
  const available = (
    await ctx.tx.query<{ available: boolean }>(
      'SELECT crm_ask_chat_available($1,$2) AS available',
      [ctx.workspaceId, input.chat_id],
    )
  ).rows[0]?.available;
  if (!available) throw new ApiError(404, '对话不存在或无权访问');
  const exists = (
    await ctx.tx.query('SELECT id FROM agent_chats WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      input.chat_id,
    ])
  ).rows.length;
  const chat = exists ? await validateAskSession(ctx, input.chat_id, input.scope) : null;
  const info = await context(ctx, { scope: input.scope });
  const origin: AskOrigin = chat?.origin || {
    kind: 'ask',
    scope: input.scope,
    label:
      input.scope.kind === 'records'
        ? { customers: '公司列表页', people: '联系人列表页', projects: '项目列表页' }[
            input.scope.object
          ]
        : input.scope.kind === 'page'
          ? `${info.label}页`
          : input.scope.kind === 'entity'
            ? `${objectNames[input.scope.object]}详情页${info.label.slice(objectNames[input.scope.object].length)}`
            : info.label.replace(/^清单/u, '清单页'),
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical([input.scope, input.question, input.action || null])))
    .digest('hex');
  const replay = async () => {
    const prior = (
      await ctx.tx.query<{
        ask_response: AskAnswer;
        ask_request_digest: string;
        model_basis: AskSource[];
      }>(
        `SELECT ask_response,ask_request_digest,model_basis FROM chat_messages
       WHERE workspace_id=$1 AND chat_id=$2 AND request_id=$3 AND role='assistant'`,
        [ctx.workspaceId, input.chat_id, input.request_id],
      )
    ).rows[0];
    if (!prior) return undefined;
    if (prior.ask_request_digest !== digest) throw new ApiError(409, '此请求编号已用于其他消息');
    if (!(await askBasisReadable(ctx, input.scope, prior.model_basis)))
      throw new ApiError(409, '这条回答的依据已不可访问，请重新提问');
    return prior.ask_response;
  };
  const previous = chat ? await replay() : undefined;
  if (previous) return { replay: previous };
  const token = randomUUID();
  const claimed = await ctx.tx
    .query(
      `INSERT INTO ask_session_claims(workspace_id,chat_id,actor_id,request_id,token,scope)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,chat_id) DO UPDATE
     SET request_id=EXCLUDED.request_id,token=EXCLUDED.token,expires_at=now()+interval '15 minutes'
     WHERE ask_session_claims.actor_id=$3 AND ask_session_claims.scope=EXCLUDED.scope AND ask_session_claims.expires_at<now()
     RETURNING token`,
      [
        ctx.workspaceId,
        input.chat_id,
        ctx.actorId,
        input.request_id,
        token,
        JSON.stringify(input.scope),
      ],
    )
    .catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === '42501')
        throw new ApiError(404, '对话不存在或无权访问');
      throw error;
    });
  if (!claimed.rows.length) throw new ApiError(409, '此对话正在生成回答，请稍后重试');
  // A completing request may have released its lease while this INSERT waited.
  // Re-read after acquiring the lease so retries replay and new turns see the
  // newly committed history rather than generating from an earlier snapshot.
  const nowAvailable = (
    await ctx.tx.query<{ available: boolean }>(
      'SELECT crm_ask_chat_available($1,$2) AS available',
      [ctx.workspaceId, input.chat_id],
    )
  ).rows[0]?.available;
  if (!nowAvailable) throw new ApiError(404, '对话不存在或无权访问');
  const nowExists = (
    await ctx.tx.query('SELECT id FROM agent_chats WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      input.chat_id,
    ])
  ).rows.length;
  const current = nowExists ? await validateAskSession(ctx, input.chat_id, input.scope) : null;
  const completed = current ? await replay() : undefined;
  const claim = {
    chat_id: input.chat_id,
    request_id: input.request_id,
    token,
    digest,
    origin: current?.origin || origin,
  };
  if (completed) {
    await releaseAskSession(ctx, claim);
    return { replay: completed };
  }
  return { claim, history: current ? await loadAskHistory(ctx, input.chat_id) : [] };
}
export async function releaseAskSession(ctx: Context, claim: AskClaim) {
  await ctx.tx.query(
    'DELETE FROM ask_session_claims WHERE workspace_id=$1 AND chat_id=$2 AND token=$3',
    [ctx.workspaceId, claim.chat_id, claim.token],
  );
}
/** Persist an authorized empty sidebar session before starting model work. */
export async function ensureAskSession(
  ctx: Context,
  input: {
    chat_id: string;
    request_id: string;
    scope: AskScope;
    question: string;
    action?: string;
  },
) {
  const prepared = await prepareAskSession(ctx, input);
  if ('claim' in prepared) {
    const { claim } = prepared;
    await ctx.tx.query(
      `INSERT INTO agent_chats(workspace_id,actor_id,id,title,customer_id,origin)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        ctx.workspaceId,
        ctx.actorId,
        input.chat_id,
        input.question.slice(0, 80),
        input.scope.kind === 'entity' ? input.scope.customer_id : null,
        JSON.stringify(claim.origin),
      ],
    );
    await releaseAskSession(ctx, claim);
  }
  return validateAskSession(ctx, input.chat_id, input.scope);
}
export async function saveAskAnswer(
  ctx: Context,
  claim: AskClaim,
  question: string,
  result: AskAnswer,
  basis: AskSource[],
  contextDigest?: string,
  onUserSaved?: (id: string) => Promise<Partial<AskAnswer>>,
) {
  const active = (
    await ctx.tx.query(
      'SELECT token FROM ask_session_claims WHERE workspace_id=$1 AND chat_id=$2 AND token=$3 FOR UPDATE',
      [ctx.workspaceId, claim.chat_id, claim.token],
    )
  ).rows.length;
  if (!active) throw new ApiError(409, '此回答的生成状态已失效，请重新提问');
  await context(ctx, { scope: claim.origin.scope });
  await ctx.tx.query(
    `INSERT INTO agent_chats(workspace_id,actor_id,id,title,customer_id,origin)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [
      ctx.workspaceId,
      ctx.actorId,
      claim.chat_id,
      question.slice(0, 80),
      claim.origin.scope.kind === 'entity' ? claim.origin.scope.customer_id : null,
      JSON.stringify(claim.origin),
    ],
  );
  await validateAskSession(ctx, claim.chat_id, claim.origin.scope);
  const scope = claim.origin.scope;
  const saved = { ...result, chat_id: claim.chat_id };
  let userMessageId = '';
  for (const role of ['user', 'assistant'] as const) {
    const id = randomUUID();
    if (role === 'user') userMessageId = id;
    const inserted = await ctx.tx.query(
      `INSERT INTO chat_messages(workspace_id,chat_id,id,request_id,role,body,material,action,model,sources,model_basis,model_context_digest,model_customer_id,model_person_id,model_project_id,ask_request_digest,ask_response)
       VALUES($1,$2,$3,$4,$5,$6,NULL,'message',$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING id`,
      [
        ctx.workspaceId,
        claim.chat_id,
        id,
        claim.request_id,
        role,
        role === 'user' ? question : saved.body,
        role === 'assistant' && result.mode === 'model' ? result.model || null : null,
        JSON.stringify(role === 'assistant' ? result.sources : []),
        JSON.stringify(basis),
        contextDigest || null,
        scope.kind === 'entity' ? scope.customer_id : null,
        scope.kind === 'entity' && scope.object === 'people' ? scope.record_id : null,
        scope.kind === 'entity' && scope.object === 'projects' ? scope.record_id : null,
        claim.digest,
        role === 'assistant' ? JSON.stringify(saved) : null,
      ],
    );
    if (!inserted.rows.length) throw new ApiError(409, '此请求已处理，请刷新对话后重试');
    if (role === 'user' && onUserSaved) {
      Object.assign(saved, await onUserSaved(id));
      const change = saved.preference;
      if (change && ['saved', 'removed', 'unchanged'].includes(change.status))
        saved.body += `\n\n${change.instruction}`;
    }
  }
  await ctx.tx.query('UPDATE agent_chats SET updated_at=now() WHERE workspace_id=$1 AND id=$2', [
    ctx.workspaceId,
    claim.chat_id,
  ]);
  await releaseAskSession(ctx, claim);
  return { answer: JSON.parse(JSON.stringify(saved)) as AskAnswer, userMessageId };
}
