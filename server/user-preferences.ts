import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  userPreferenceOptions,
  type UserPreferenceSetting,
  type PreferenceChange,
  type UserPreference,
  type UserPreferenceKey,
} from '../shared/user-preferences.js';
import type { AskSource } from '../shared/ask.js';
import type { ChatOrigin } from '../shared/chat.js';
import { askBasisReadable, validateAskSession } from './ask-sessions.js';
import * as relationships from './relationships.js';
import { ApiError, type Context } from './security.js';

const contents = Object.fromEntries(
  Object.entries(userPreferenceOptions).map(([category, definition]) => [
    category,
    Object.fromEntries(definition.options.map(({ value, label }) => [value, label])),
  ]),
) as Record<UserPreferenceKey, Record<string, string>>;

interface Candidate {
  category: UserPreferenceKey;
  value: string;
}
export interface PreferencePlan {
  action: 'none' | 'save' | 'remove' | 'clarify';
  question: string;
  hasMaterial: boolean;
  preferences: UserPreference[];
  instruction: string;
  candidate?: Candidate;
  removeKey?: UserPreferenceKey | '*';
  previousAssistant?: string;
  fromPreviousAssistant?: boolean;
}
type PreferenceRow = Omit<UserPreference, 'content'>;
const selection = 'id,category,value,source_chat_id,source_message_id,created_at,updated_at';
const preference = (row: PreferenceRow): UserPreference => ({
  ...row,
  content: contents[row.category][row.value],
});
export async function listUserPreferences(ctx: Context): Promise<UserPreference[]> {
  return (
    await ctx.tx.query<PreferenceRow>(
      `SELECT ${selection} FROM user_preferences WHERE workspace_id=$1 AND actor_id=$2 ORDER BY category`,
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows.map(preference);
}

const settingsSelection = `${selection},md5(updated_at::text || ':' || value) AS version`;
type SettingRow = PreferenceRow & { version: string };

async function preferenceSource(
  ctx: Context,
  row: PreferenceRow,
): Promise<UserPreferenceSetting['source_chat']> {
  const source = (
    await ctx.tx.query<{
      id: string;
      title: string;
      customer_id: string | null;
      origin: ChatOrigin | null;
      model_customer_id: string | null;
      model_person_id: string | null;
      model_project_id: string | null;
      model_basis: AskSource[];
    }>(
      `SELECT c.id,c.title,c.customer_id,c.origin,
        a.model_customer_id,a.model_person_id,a.model_project_id,a.model_basis
       FROM agent_chats c JOIN chat_messages m ON m.workspace_id=c.workspace_id AND m.chat_id=c.id
       JOIN chat_messages a ON a.workspace_id=m.workspace_id AND a.chat_id=m.chat_id
         AND a.request_id=m.request_id AND a.role='assistant'
       WHERE c.workspace_id=$1 AND c.actor_id=$2 AND c.id=$3 AND m.id=$4
         AND m.role='user' AND m.material IS NULL`,
      [ctx.workspaceId, ctx.actorId, row.source_chat_id, row.source_message_id],
    )
  ).rows[0];
  if (!source) return null;
  const activeCustomer = async (id: string) =>
    !!(
      await ctx.tx.query(
        'SELECT id FROM customers WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL',
        [ctx.workspaceId, id],
      )
    ).rows.length;
  try {
    const customers = new Set(
      [source.customer_id, source.model_customer_id].filter((id): id is string => !!id),
    );
    if (source.origin) {
      // A visible chat row alone does not authorize an Ask's captured page scope.
      const chat = await validateAskSession(ctx, source.id);
      if (chat.origin.scope.kind === 'entity') {
        customers.add(chat.origin.scope.customer_id);
        const anchor = await relationships.record(
          ctx,
          chat.origin.scope.object,
          chat.origin.scope.record_id,
          chat.origin.scope.customer_id,
        );
        if (anchor.archived_at) return null;
      }
      if (!(await askBasisReadable(ctx, chat.origin.scope, source.model_basis))) return null;
    }
    for (const id of customers) if (!(await activeCustomer(id))) return null;
    for (const [object, id] of [
      ['people', source.model_person_id],
      ['projects', source.model_project_id],
    ] as const) {
      if (!id || !source.model_customer_id) continue;
      const anchor = await relationships.record(ctx, object, id, source.model_customer_id);
      if (anchor.archived_at) return null;
    }
    for (const basis of source.model_basis) {
      if (!(await activeCustomer(basis.customer_id))) return null;
      if (
        !source.origin &&
        !(await askBasisReadable(
          ctx,
          {
            kind: 'entity',
            object: source.model_project_id ? 'projects' : 'customers',
            customer_id: basis.customer_id,
            record_id: source.model_project_id || basis.customer_id,
          },
          [basis],
        ))
      )
        return null;
    }
    return { id: source.id, title: source.title };
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status)) return null;
    throw error;
  }
}

async function setting(ctx: Context, row: SettingRow): Promise<UserPreferenceSetting> {
  const { version, ...stored } = row;
  return { ...preference(stored), version, source_chat: await preferenceSource(ctx, stored) };
}

export async function listUserPreferenceSettings(ctx: Context): Promise<UserPreferenceSetting[]> {
  const rows = (
    await ctx.tx.query<SettingRow>(
      `SELECT ${settingsSelection} FROM user_preferences
       WHERE workspace_id=$1 AND actor_id=$2 ORDER BY category`,
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows;
  const result: UserPreferenceSetting[] = [];
  for (const row of rows) result.push(await setting(ctx, row));
  return result;
}

const editSchema = z.strictObject({
  value: z.string().min(1).max(80),
  expected_version: z.string().regex(/^[a-f\d]{32}$/u),
});
export async function editUserPreference(
  ctx: Context,
  id: string,
  input: unknown,
): Promise<UserPreferenceSetting> {
  const preferenceId = z.uuid().parse(id);
  const value = editSchema.parse(input);
  const existing = (
    await ctx.tx.query<SettingRow>(
      `SELECT ${settingsSelection} FROM user_preferences WHERE workspace_id=$1 AND actor_id=$2 AND id=$3`,
      [ctx.workspaceId, ctx.actorId, preferenceId],
    )
  ).rows[0];
  if (!existing) throw new ApiError(404, '个人偏好不存在或无权访问');
  if (
    !userPreferenceOptions[existing.category].options.some((option) => option.value === value.value)
  )
    throw new ApiError(400, '请选择这类偏好支持的选项');
  const updated = (
    await ctx.tx.query<SettingRow>(
      `UPDATE user_preferences SET value=$4
       WHERE workspace_id=$1 AND actor_id=$2 AND id=$3
         AND md5(updated_at::text || ':' || value)=$5 RETURNING ${settingsSelection}`,
      [ctx.workspaceId, ctx.actorId, preferenceId, value.value, value.expected_version],
    )
  ).rows[0];
  if (!updated) throw new ApiError(409, '这条偏好已更新或删除，请重新加载后再修改');
  return setting(ctx, updated);
}

// Match complete, narrow presentation requests. Never retain arbitrary user text,
// names, addresses, prices, factual answers, permissions, or tool instructions.
function parseCandidate(input: string): Candidate | undefined {
  const text = input
    .normalize('NFKC')
    .replace(/[\s，、,。.!！:：；;]/gu, '')
    .replace(/^(?:请)?(?:以后|今后|默认)/u, '')
    .replace(/^(?:都)?(?:请)?/u, '');
  if (
    /^(?:我(?:喜欢|希望|偏好)|回答请|请|回复请)?(?:回答|回复)?(?:要|都|用|使用|保持)?(?:简短|简洁|精简)(?:直接)?(?:一些|一点|回答|回复|就好|的回答)?$/u.test(
      text,
    ) ||
    /^(?:回答|回复)(?:简短|简洁|精简)(?:直接)?(?:一点|一些)?$/u.test(text)
  )
    return { category: 'response_length', value: 'concise' };
  if (
    /^(?:我(?:喜欢|希望|偏好)|请)?(?:回答|回复)?(?:要|都|用|使用)?(?:详细|详尽)(?:一些|一点|回答|回复|的回答)?$/u.test(
      text,
    )
  )
    return { category: 'response_length', value: 'detailed' };
  if (
    /^(?:(?:查|查询|列出)?联系人(?:时|结果)?(?:都|优先)?(?:用|使用)?表格(?:展示|显示|回答|列出)?|(?:用|使用)?表格(?:展示|显示|列出)联系人)$/u.test(
      text,
    )
  )
    return { category: 'contact_format', value: 'table' };
  if (
    /^(?:我(?:喜欢|希望|偏好)|请)?(?:回答|回复|查询结果|查资料)?(?:都|优先)?(?:用|使用)?表格(?:回答|回复|展示|显示|列出查询结果)?$/u.test(
      text,
    )
  )
    return { category: 'response_format', value: 'table' };
  if (
    /^(?:我(?:喜欢|希望|偏好)|请)?(?:回答|回复|查询结果)?(?:都|优先)?(?:用|使用)?(?:列表|条目)(?:回答|回复|展示|显示)?$/u.test(
      text,
    )
  )
    return { category: 'response_format', value: 'list' };
  if (
    /^(?:我(?:喜欢|希望|偏好)|请)?(?:回答|回复)?(?:都|优先)?(?:用|使用)?(?:自然段|段落)(?:回答|回复|展示)?$/u.test(
      text,
    )
  )
    return { category: 'response_format', value: 'paragraph' };
  for (const [language, value] of [
    ['中文', 'zh'],
    ['英文', 'en'],
  ] as const) {
    if (
      new RegExp(
        `^(?:我(?:喜欢|希望|偏好)|请)?(?:回答|回复)?(?:都)?(?:用|使用)?${language}(?:回答|回复)?$`,
        'u',
      ).test(text)
    )
      return { category: 'response_language', value };
  }
  if (
    /^(?:查|查询)?联系人(?:时|结果)?(?:都|优先)?(?:用|使用)?姓名公司邮箱(?:三列)?(?:的)?表格(?:展示|显示|回答|列出)?$/u.test(
      text,
    )
  )
    return { category: 'contact_columns', value: 'name_company_email' };
  const mail = text.match(
    /^(?:帮我)?(?:写|拟|撰写)?(英文|中文)?邮件(?:草稿)?(?:时)?(?:文风|语气)?(?:都|要|用|使用|保持)?(?:写得)?(简短直接|简洁直接|正式|亲切)(?:一些|一点|的文风|文风)?$/u,
  );
  if (mail) {
    const tone = ['简短直接', '简洁直接'].includes(mail[2])
      ? 'concise_direct'
      : mail[2] === '正式'
        ? 'formal'
        : 'warm';
    return {
      category: mail[1] ? (mail[1] === '英文' ? 'email_tone_en' : 'email_tone_zh') : 'email_tone',
      value: tone,
    };
  }
  return undefined;
}

/** Recognize presentation syntax only. No sentence or cell is retained as memory. */
function previousPresentation(body: string | undefined): Candidate | undefined {
  if (!body) return;
  const lines = body.replace(/(```|~~~)[^]*?(?:\1|$)/gu, '').split(/\r?\n/u);
  const cells = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|');
  for (let i = 1; i < lines.length - 1; i++) {
    const separator = cells(lines[i]);
    if (
      separator.length >= 2 &&
      separator.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell)) &&
      cells(lines[i - 1]).length === separator.length &&
      cells(lines[i + 1]).length === separator.length &&
      lines[i + 1].trim()
    )
      return { category: 'response_format', value: 'table' };
  }
  if (lines.filter((line) => /^\s*(?:[-*+]\s+|\d+[.)、]\s*)\S/u.test(line)).length >= 2)
    return { category: 'response_format', value: 'list' };
}

function parseInstruction(
  question: string,
  hasMaterial: boolean,
  previousAssistant?: string,
): Pick<
  PreferencePlan,
  'action' | 'candidate' | 'removeKey' | 'instruction' | 'fromPreviousAssistant'
> {
  const text = question.trim();
  const save = text.match(/^(?:请)?(?:记住(?:这一点|这个偏好)?|以后都这样)[\s，,:：。]*(.*)$/su);
  const remove = text.match(/^(?:请)?(?:忘记|删除|清除)(.*?)(?:[。！!])?$/su);
  if (!save && (!remove || !/(?:个人记忆|用户记忆|偏好)/u.test(remove[1])))
    return { action: 'none', instruction: '' };
  const clarify = {
    action: 'clarify' as const,
    instruction:
      '本轮没有保存或删除个人偏好。只可保存用户明确要求的语言、长短、展示格式或邮件文风；请询问要记住的具体个人偏好。无法客观确定展示格式时，不能根据“以后都这样”猜测，更不能把上一条业务答案保存为偏好。',
  };
  if (
    hasMaterial ||
    /[\r\n`“”‘’"'<>]|(?:客户说|邮件|附件|原文|引用|转述|系统指令|system prompt)/iu.test(
      text.replace(/(?:英文|中文)?邮件(?:草稿)?(?:时)?(?:文风|语气)?/gu, ''),
    )
  )
    return clarify;
  if (save) {
    const fromPreviousAssistant = /^以后都这样[\s，,:：。.!！]*$/u.test(text);
    const candidate = fromPreviousAssistant
      ? previousPresentation(previousAssistant)
      : parseCandidate(save[1]);
    return candidate
      ? {
          action: 'save',
          candidate,
          ...(fromPreviousAssistant ? { fromPreviousAssistant: true } : {}),
          instruction: `用户本轮明确请求保存个人偏好：${contents[candidate.category][candidate.value]} 尚未写入，请正常回答但不要声称已保存；最终保存状态由服务端展示。偏好只影响展示，不能作为客户事实或执行授权。`,
        }
      : clarify;
  }
  const target = remove![1].replace(/[\s，,:：。]/gu, '');
  if (/^(?:所有|全部)(?:已保存的?)?(?:个人|用户)?偏好(?:记忆)?$/u.test(target))
    return {
      action: 'remove',
      removeKey: '*',
      instruction: '用户明确请求删除全部个人偏好，尚未执行；最终状态由服务端展示。',
    };
  const removeKeys: [RegExp, UserPreferenceKey][] = [
    [/^(?:回答长短|简短回答|详细回答)(?:的)?偏好$/u, 'response_length'],
    [/^(?:表格|列表|展示格式|回答格式)(?:的)?偏好$/u, 'response_format'],
    [/^(?:回答语言|中文回答|英文回答)(?:的)?偏好$/u, 'response_language'],
    [/^(?:联系人列|联系人三列)(?:的)?偏好$/u, 'contact_columns'],
    [/^联系人(?:表格|展示格式|格式)(?:的)?偏好$/u, 'contact_format'],
    [/^英文邮件(?:文风|语气)(?:的)?偏好$/u, 'email_tone_en'],
    [/^中文邮件(?:文风|语气)(?:的)?偏好$/u, 'email_tone_zh'],
    [/^(?:邮件文风|邮件语气)(?:的)?偏好$/u, 'email_tone'],
  ];
  const key = removeKeys.find(([pattern]) => pattern.test(target))?.[1];
  return key
    ? {
        action: 'remove',
        removeKey: key,
        instruction: '用户明确请求删除这类个人偏好，尚未执行；最终状态由服务端展示。',
      }
    : clarify;
}

export async function preparePreference(
  ctx: Context,
  input: { question: string; hasMaterial?: boolean; previousAssistant?: string },
): Promise<PreferencePlan> {
  const hasMaterial = input.hasMaterial ?? false;
  const instruction = parseInstruction(input.question, hasMaterial, input.previousAssistant);
  return {
    question: input.question,
    hasMaterial,
    preferences: await listUserPreferences(ctx),
    ...instruction,
    ...(instruction.fromPreviousAssistant ? { previousAssistant: input.previousAssistant } : {}),
  };
}

const sourceSchema = z.strictObject({
  chat_id: z.uuid(),
  request_id: z.uuid(),
  message_id: z.uuid().optional(),
});
export async function applyPreference(
  ctx: Context,
  plan: PreferencePlan,
  source: { chat_id: string; request_id: string; message_id?: string },
): Promise<PreferenceChange> {
  const parsed = parseInstruction(plan.question, plan.hasMaterial, plan.previousAssistant);
  if (parsed.action === 'none' || parsed.action === 'clarify')
    return { status: parsed.action, instruction: parsed.instruction };
  // Treat the plan as a request, never as an authorization token or persisted value.
  if (
    parsed.action !== plan.action ||
    JSON.stringify(parsed.candidate) !== JSON.stringify(plan.candidate) ||
    parsed.removeKey !== plan.removeKey ||
    parsed.fromPreviousAssistant !== plan.fromPreviousAssistant
  )
    throw new ApiError(409, '个人偏好请求已变更，请重新发送');
  const value = sourceSchema.parse(source);
  const message = (
    await ctx.tx.query<{ id: string; body: string; material: unknown; position: number }>(
      `SELECT m.id,m.body,m.material,m.position FROM chat_messages m JOIN agent_chats c ON c.workspace_id=m.workspace_id AND c.id=m.chat_id
      WHERE m.workspace_id=$1 AND c.actor_id=$2 AND m.chat_id=$3 AND m.request_id=$4 AND m.role='user' AND ($5::uuid IS NULL OR m.id=$5)`,
      [ctx.workspaceId, ctx.actorId, value.chat_id, value.request_id, value.message_id ?? null],
    )
  ).rows[0];
  if (!message || message.body !== plan.question || message.material !== null)
    throw new ApiError(409, '个人偏好必须来源于本轮直接输入的用户消息');
  if (parsed.fromPreviousAssistant) {
    // RLS revalidates the prior answer's customer/source permissions. Read the
    // nearest assistant in this chat, never one supplied by another session.
    const previous = (
      await ctx.tx.query<{ body: string }>(
        `SELECT body FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2
        AND role='assistant' AND position<$3 ORDER BY position DESC LIMIT 1`,
        [ctx.workspaceId, value.chat_id, message.position],
      )
    ).rows[0];
    if (!previous || previous.body !== plan.previousAssistant)
      throw new ApiError(409, '无法核对本会话上一条回复的展示格式，请明确要记住的个人偏好');
  }
  const hash = createHash('sha256').update(plan.question).digest('hex');
  const category = parsed.candidate?.category ?? parsed.removeKey!;
  const inserted = (
    await ctx.tx.query<{ request_id: string }>(
      `INSERT INTO user_preference_requests(workspace_id,actor_id,request_id,source_chat_id,source_message_id,input_hash,action,category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,actor_id,request_id) DO NOTHING RETURNING request_id`,
      [
        ctx.workspaceId,
        ctx.actorId,
        value.request_id,
        value.chat_id,
        message.id,
        hash,
        parsed.action,
        category,
      ],
    )
  ).rows[0];
  if (!inserted) {
    const existing = (
      await ctx.tx.query<{ source_chat_id: string; input_hash: string }>(
        'SELECT source_chat_id,input_hash FROM user_preference_requests WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
        [ctx.workspaceId, ctx.actorId, value.request_id],
      )
    ).rows[0];
    if (!existing || existing.source_chat_id !== value.chat_id || existing.input_hash !== hash)
      throw new ApiError(409, '该请求已用于另一条个人偏好指令');
    return {
      status: 'previously_applied',
      instruction: '这条个人偏好请求此前已处理，本次没有重复写入。请以当前个人偏好列表为准。',
    };
  }
  if (parsed.action === 'remove') {
    const rows = (
      await ctx.tx.query<{ id: string }>(
        `DELETE FROM user_preferences WHERE workspace_id=$1 AND actor_id=$2
          AND ($3='*' OR category=$3 OR ($3='email_tone' AND category IN ('email_tone_en','email_tone_zh'))) RETURNING id`,
        [ctx.workspaceId, ctx.actorId, category],
      )
    ).rows;
    return {
      status: rows.length ? 'removed' : 'unchanged',
      removed: rows.length,
      instruction: rows.length ? '已删除指定的个人偏好。' : '没有找到该个人偏好，无需删除。',
    };
  }
  const candidate = parsed.candidate!;
  const row = (
    await ctx.tx.query<PreferenceRow>(
      `INSERT INTO user_preferences(workspace_id,actor_id,id,category,value,source_chat_id,source_message_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,actor_id,category) DO UPDATE SET value=EXCLUDED.value,source_chat_id=EXCLUDED.source_chat_id,source_message_id=EXCLUDED.source_message_id RETURNING ${selection}`,
      [
        ctx.workspaceId,
        ctx.actorId,
        randomUUID(),
        candidate.category,
        candidate.value,
        value.chat_id,
        message.id,
      ],
    )
  ).rows[0];
  return {
    status: 'saved',
    preference: preference(row),
    instruction: `已记住个人偏好：${contents[candidate.category][candidate.value]}`,
  };
}

export async function removeUserPreference(
  ctx: Context,
  id: string,
): Promise<{ removed: boolean }> {
  const value = z.uuid().parse(id);
  const rows = (
    await ctx.tx.query<{ id: string }>(
      'DELETE FROM user_preferences WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 RETURNING id',
      [ctx.workspaceId, ctx.actorId, value],
    )
  ).rows;
  if (!rows.length) throw new ApiError(404, '个人偏好不存在或无权访问');
  return { removed: true };
}
