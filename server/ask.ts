import { bindAgentEntry, askEntryScope } from './agent-entries.js';
import { planAgentContext, assertAgentContextCurrent } from './agent-context-plan.js';
import { entitySchema } from './entity-schema.js';
import { z } from 'zod';
import { knowledgeAgentSources, recordEvidence } from './knowledge.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prepareAskSession, releaseAskSession, saveAskAnswer } from './ask-sessions.js';
import { budgetAgentSources } from './agent-source-budget.js';
import {
  prepareKnowledgeSearch,
  executeKnowledgeSearch,
  validateKnowledgeSearch,
  type KnowledgeSearchPlan,
} from './knowledge-search.js';
import type { Database } from './db.js';
import type { AgentSnapshot, AgentSource } from '../shared/agent.js';
import { scoped } from './security.js';
import { assertRunAvailable } from './agent-run-store.js';
import {
  agentStatus,
  agentModel,
  prepareAgent,
  parseAgentResult,
  snapshotDigest,
  resumeTurns,
  type AgentStream,
  continueTurns,
  type AgentModelOptions,
} from './agent-model.js';
import type { AskScope, AskAction, AskContext, AskAnswer, AskSource } from '../shared/ask.js';
import {
  customerTypes,
  customerStatuses,
  projectTypes,
  projectStages,
  recordKinds,
  sources,
  type CustomerRecord,
} from '../shared/domain.js';
import { objectNames } from '../shared/connections.js';
import { ApiError, type Context } from './security.js';
import * as service from './service.js';
import * as people from './people.js';
import * as browse from './browse.js';
import * as relationships from './relationships.js';
import { prospectStateContext } from './prospect-context.js';
import * as workflow from './list-workflow.js';
import { getList } from './lists.js';
import * as mail from './mail.js';
import { listConfigSchema } from './list-validation.js';
import { uuid } from './validation.js';
import { preparePreference, applyPreference } from './user-preferences.js';
import { activityPersonRecordMatch } from './activity-context.js';
import { notePersonRecordMatch } from './note-sources.js';
import {
  prepareNoteRetrieval,
  executeNoteRetrieval,
  noteRetrievedSources,
  canonicalNoteEvidenceSources,
  mergeNoteSources,
  type NoteRetrievalPlan,
} from './note-retrieval.js';

const object = z.enum(['customers', 'people', 'projects']);
const selected = z
  .array(uuid)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length);
export const scopeInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entity'), object, customer_id: uuid, record_id: uuid }),
  z.strictObject({
    kind: z.literal('records'),
    object,
    query: z.string().max(12000),
    selected_ids: selected,
  }),
  z.strictObject({
    kind: z.literal('list'),
    list_id: uuid,
    config: listConfigSchema,
    query: z.string().trim().max(100),
    page: z.number().int().min(1).max(100000),
    selected_ids: selected,
  }),
  z.strictObject({
    kind: z.literal('page'),
    page: z.enum(['mail', 'wechat', 'relationships', 'chat']),
  }),
]);
const scopeRequest = z.strictObject({ scope: scopeInput });
const actionInput = z.enum(['overview', 'relationships', 'records', 'emails']);
export const questionRequest = z.strictObject({
  scope: scopeInput,
  action: actionInput.optional(),
  question: z.string().trim().min(1).max(2000),
});
const sourceRequest = z.strictObject({
  scope: scopeInput,
  kind: z.enum(['record', 'mail']),
  id: uuid,
});
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const answer = (body: string, sources: AskSource[] = []): AskAnswer => ({
  body,
  sources,
  generated_at: new Date().toISOString(),
  mode: 'local',
});

// Stateless, read-only tools. No model, history, private previews or write tools
// are passed through this boundary. Every request resolves its anchor under RLS.
async function entity(ctx: Context, scope: Extract<AskScope, { kind: 'entity' }>) {
  await relationships.record(ctx, scope.object, scope.record_id, scope.customer_id);
  const customer = await service.customer(ctx, scope.customer_id);
  const record =
    scope.object === 'customers'
      ? customer
      : scope.object === 'people'
        ? await people.person(ctx, scope.record_id, scope.customer_id)
        : await service.project(ctx, scope.customer_id, scope.record_id);
  return { customer, record };
}

// Only basic directory fields may cross a collection scope. In particular,
// never spread whole rows here: they can contain notes, custom values or evidence.
function directoryFields(
  row: Record<string, unknown>,
  type: 'customers' | 'people' | 'projects',
  list = false,
) {
  const fields: Record<string, string> = {
    [type === 'people' ? '姓名' : type === 'customers' ? '公司名称' : '项目名称']: String(row.name),
  };
  const add = (key: string, label: string) => {
    const value = row[key];
    if (typeof value === 'string') fields[label] = value.trim() ? value : '未填写';
  };
  if (type === 'customers') {
    add('contact_name', '主要联系人');
    add('email', '公司邮箱');
    add('phone', '公司电话');
  } else {
    add('customer_name', '所属公司');
    if (type === 'people') {
      add('email', '联系人邮箱');
      add('phone', '联系人电话');
      add('job_title', '职位');
    } else if (list) {
      // Project list rows expose c.email, not an email belonging to the project.
      add('email', '所属公司邮箱');
    }
  }
  return fields;
}

async function collection(ctx: Context, scope: Extract<AskScope, { kind: 'records' | 'list' }>) {
  let items: { id: string; customer_id: string; name: string; fields: Record<string, string> }[],
    total: number,
    label: string;
  let type: 'customers' | 'people' | 'projects';
  if (scope.kind === 'list') {
    const list = await getList(ctx, scope.list_id);
    const result = await workflow.browseEntries(ctx, scope.list_id, {
      config: scope.config,
      query: scope.query,
      page: scope.page,
    });
    type = list.object;
    items = result.items.map((r) => ({
      id: type === 'customers' ? r.customer_id : type === 'people' ? r.person_id! : r.project_id!,
      customer_id: r.customer_id,
      name: r.name,
      fields: directoryFields(r as unknown as Record<string, unknown>, type, true),
    }));
    total = result.total;
    label = `清单 · ${list.name}`;
  } else {
    const params = new URLSearchParams(scope.query);
    if (Array.from(params.keys()).some((key) => params.getAll(key).length > 1))
      throw new ApiError(400, '查询条件重复');
    const query = Object.fromEntries(params);
    const result =
      scope.object === 'customers'
        ? await browse.customers(ctx, query)
        : scope.object === 'people'
          ? await people.browsePeople(ctx, query)
          : await browse.projects(ctx, query);
    type = scope.object;
    items = result.items.map((r) => ({
      id: String(r.id),
      customer_id: String(type === 'customers' ? r.id : r.customer_id),
      name: String(r.name),
      fields: directoryFields(r, type),
    }));
    total = result.total;
    label = `${objectNames[type]} · 当前筛选`;
  }
  if (scope.selected_ids.length) {
    items = items.filter((r) => scope.selected_ids.includes(r.id));
    if (items.length !== scope.selected_ids.length)
      throw new ApiError(409, '选中记录已不在当前可访问页面，请刷新后重新选择');
    total = items.length;
    label += ` · 已选 ${total} 条`;
  }
  return { items, total, label, type };
}

export async function context(ctx: Context, input: unknown): Promise<AskContext> {
  const { scope } = scopeRequest.parse(input);
  if (scope.kind === 'entity') {
    const { record } = await entity(ctx, scope);
    return {
      label: `${objectNames[scope.object]} · ${record.name}`,
      description: '围绕此实体的档案、记录、关联关系与已归属往来查询。',
      model: false,
      suggestions: [
        { action: 'overview', text: '查看档案信息' },
        {
          action: 'relationships',
          text: scope.object === 'people' ? '关联哪些公司和项目？' : '有哪些关联联系人和项目？',
        },
        { action: 'records', text: '查看相关业务记录' },
        { action: 'emails', text: '最近有哪些邮件往来？' },
      ],
    };
  }
  if (scope.kind !== 'page') {
    const result = await collection(ctx, scope);
    return {
      label: result.label,
      description: `当前范围共 ${result.total} 条；可查看记录并打开具体实体继续提问。`,
      model: false,
      suggestions: [{ action: 'overview', text: '查看当前范围的记录' }],
    };
  }
  const labels = { mail: '邮件', wechat: '微信会话', relationships: '对象关系', chat: '独立对话' };
  return {
    label: labels[scope.page],
    description: '可询问当前页面的使用方法；打开具体档案后，自动围绕该实体查询。',
    model: false,
    suggestions: [{ action: 'overview', text: '这个页面可以做什么？' }],
  };
}

function entitySource(scope: Extract<AskScope, { kind: 'entity' }>, name: string): AskSource {
  return {
    kind: 'entity',
    id: scope.record_id,
    object: scope.object,
    customer_id: scope.customer_id,
    title: name,
    description: `${objectNames[scope.object]}档案`,
  };
}

async function records(ctx: Context, scope: Extract<AskScope, { kind: 'entity' }>, id?: string) {
  // Records currently have no general person foreign key. Only confirmed,
  // saved WeChat associations establish a person link; RLS keeps previews private.
  return (
    await ctx.tx.query<CustomerRecord>(
      `SELECT r.* FROM customer_records r WHERE r.workspace_id=$1 AND r.customer_id=$2
      AND ($3::uuid IS NULL OR r.project_id=$3)
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM knowledge_wechat_evidence e
        WHERE e.workspace_id=r.workspace_id AND e.record_id=r.id AND e.person_id=$4)
        OR EXISTS(SELECT 1 FROM mail_people m WHERE m.workspace_id=r.workspace_id AND m.message_id=r.source_mail_id AND m.person_id=$4)
        OR EXISTS(SELECT 1 FROM wechat_queries w
        WHERE w.workspace_id=r.workspace_id AND w.customer_id=r.customer_id AND w.record_id=r.id
          AND w.person_id=$4 AND w.state='associated')
        OR ${activityPersonRecordMatch} OR ${notePersonRecordMatch})
      AND ($5::uuid IS NULL OR r.id=$5)
      ORDER BY r.created_at DESC,r.id LIMIT 20`,
      [
        ctx.workspaceId,
        scope.customer_id,
        scope.object === 'projects' ? scope.record_id : null,
        scope.object === 'people' ? scope.record_id : null,
        id || null,
      ],
    )
  ).rows;
}

export async function query(ctx: Context, input: unknown): Promise<AskAnswer> {
  const { scope, action: explicitAction, question } = questionRequest.parse(input);
  const info = await context(ctx, { scope });
  if (scope.kind === 'page') {
    const help = {
      mail: '这里可以查看已同步邮件、核对客户归属和回复；邮箱设置在页面顶部。打开公司、联系人或项目档案后，可以查询该实体的往来。',
      wechat:
        '请在微信会话页面指定联系人和日期，查询后选择信息并确认归属。打开 Ask Typha 不会读取微信历史；本机真实读取能力仍待联调。',
      relationships:
        '这里定义对象之间的双向关系。在档案中维护实际关联，Ask Typha 可在具体实体页面查询已建立的关系。',
      chat: '当前完整对话保持原有范围。打开具体公司、联系人或项目后，Ask Typha 会围绕该实体提供本地资料查询。',
    };
    return answer(
      `${help[scope.page]}\n\n模型尚未接入，当前提供页面指引；本次没有执行资料读取或业务动作。`,
    );
  }
  if (scope.kind !== 'entity') {
    const result = await collection(ctx, scope);
    return answer(
      `${result.label}：共 ${result.total} 条匹配记录。${result.total > result.items.length ? `以下列出当前页 ${result.items.length} 条，不能据此推断全量业务结论。` : ''}\n\n打开下方具体实体，可以继续查询它的档案、记录、关系和邮件。模型尚未接入，暂不分析跨客户业务内容。`,
      result.items.map((r) => ({
        kind: 'entity',
        id: r.id,
        object: result.type,
        customer_id: r.customer_id,
        title: r.name,
        description: `${objectNames[result.type]}档案`,
      })),
    );
  }
  // Inference is only a small local shortcut router. It never treats source text
  // as instructions and never claims free-form semantic understanding.
  if (/其他商家|几家|共性|相似意见|同款/.test(question))
    return answer(
      '跨商家共性统计尚未接入。当前会话只查询此实体，不从检索片段猜测商家数，也不会自动承诺修改样衣。',
    );
  if (/发送.*邮件|删除.*记录|修改.*档案|安排.*发送|读取微信/.test(question))
    return answer('模型尚未接入，当前仅提供本地只读查询。本次没有修改档案、读取微信或发送邮件。');
  const action: AskAction | undefined =
    explicitAction ||
    (/邮件|email/i.test(question)
      ? 'emails'
      : /关联|关系|联系人|哪些项目/.test(question)
        ? 'relationships'
        : /记录|反馈|聊了|沟通|进展|卡点|待办/.test(question)
          ? 'records'
          : /档案|概况|信息|邮箱|电话|地区|哪里|阶段|截止/.test(question)
            ? 'overview'
            : undefined);
  if (!action)
    return answer(
      '模型尚未接入，暂时无法理解这个自由提问。可以使用下方的档案、业务记录、关联关系或邮件查询；不会据此执行修改或发送。',
    );
  const { customer, record } = await entity(ctx, scope);
  if (action === 'overview') {
    const lines = [`${info.label}`, `所属公司：${customer.name}`];
    if (scope.object === 'customers')
      lines.push(
        `客户类型：${customerTypes[customer.type]}`,
        `合作状态：${customerStatuses[customer.status]}`,
        `地区：${customer.region || '未填写'}`,
        `来源：${sources[customer.source]}`,
        `主要联系人：${customer.contact_name || '未填写'}`,
        `邮箱：${customer.email || '未填写'}`,
        `电话：${customer.phone || '未填写'}`,
      );
    else if (scope.object === 'people') {
      const p = await people.person(ctx, scope.record_id, scope.customer_id);
      lines.push(
        `职位：${p.job_title || '未填写'}`,
        `邮箱：${p.email || '未填写'}`,
        `电话：${p.phone || '未填写'}`,
        `备注：${p.description || '未填写'}`,
      );
    } else {
      const p = await service.project(ctx, scope.customer_id, scope.record_id);
      lines.push(
        `类型：${projectTypes[p.type]}`,
        `阶段：${projectStages[p.stage]}`,
        `截止日期：${p.due_date || '未填写'}`,
        `说明：${p.description || '未填写'}`,
      );
    }
    return answer(`${lines.join('\n')}\n\n来自已有档案字段，未作模型推断。`, [
      entitySource(scope, record.name),
    ]);
  }
  if (action === 'relationships') {
    const result = await relationships.related(ctx, scope.object, scope.record_id);
    const refs: AskSource[] = result.items.map((r) => {
      const d = result.definitions.find((d) => d.id === r.definition_id);
      return {
        kind: 'entity',
        id: r.id,
        object: r.object,
        customer_id: r.customer_id,
        title: r.name,
        description: d ? (r.side === 'source' ? d.source_label : d.target_label) : '已建立关系',
      };
    });
    if (scope.object !== 'customers')
      refs.unshift({
        kind: 'entity',
        id: customer.id,
        object: 'customers',
        customer_id: customer.id,
        title: customer.name,
        description: '所属公司',
      });
    if (scope.object === 'customers') {
      const ps = await people.browsePeople(ctx, { customer_id: customer.id });
      refs.push(
        ...ps.items.map((p) => ({
          kind: 'entity' as const,
          id: String(p.id),
          object: 'people' as const,
          customer_id: customer.id,
          title: String(p.name),
          description: '公司联系人（最多列出 30 位）',
        })),
      );
    }
    if (scope.object !== 'projects') {
      const projects = await relationships.associatedProjects(ctx, scope.object, scope.record_id, {
        page: 1,
      });
      refs.push(
        ...projects.items.map((p) => ({
          kind: 'entity' as const,
          id: p.id,
          object: 'projects' as const,
          customer_id: p.customer_id,
          title: p.name,
          description: `相关项目 · ${projectStages[p.stage]}${p.via_email ? ' · 邮件明确关联' : ''}`,
        })),
      );
      const unique = refs.filter(
        (r, i) => refs.findIndex((s) => s.object === r.object && s.id === r.id) === i,
      );
      return answer(
        `相关项目共 ${projects.total} 个，最多列出最近 5 个。${scope.object === 'people' ? '仅统计明确关系或已指定项目的本人邮件，不代表参与公司全部项目。' : ''}\n\n以下为档案关系及所属记录，可打开查看。`,
        unique,
      );
    }
    return answer('以下为所属公司和已明确建立的关联。未建立关系不代表业务上没有联系。', refs);
  }
  if (action === 'records') {
    const rows = await records(ctx, scope);
    const refs: AskSource[] = rows.map((r) => ({
      kind: 'record',
      id: r.id,
      customer_id: scope.customer_id,
      title: `${recordKinds[r.kind]} · ${date(r.created_at)}`,
      description: r.body.slice(0, 160),
      ...(r.project_id ? { project_id: r.project_id } : {}),
    }));
    return answer(
      `${rows.length ? `列出最近 ${rows.length} 条相关业务记录（最多 20 条）。` : '当前范围没有可读取的相关业务记录。'}${scope.object === 'people' ? '\n联系人只列出有明确本人关联的邮件和已保存微信记录；普通公司记录暂未标记说话人，不归于此人。' : ''}\n\n分类沿用客户原话、内部推断、公司确认信息，不将记录自动归纳为进展或承诺。`,
      refs,
    );
  }
  const result = await mail.mailList(ctx, {
    customer_id: scope.customer_id,
    ...(scope.object === 'people' ? { person_id: scope.record_id } : {}),
    ...(scope.object === 'projects' ? { project_id: scope.record_id } : {}),
  });
  return answer(
    `当前实体共 ${result.total} 封已归属邮件，列出最近 ${Math.min(10, result.items.length)} 封。可展开原文核对沟通内容；尚未进行模型总结。`,
    result.items.slice(0, 10).map((m) => ({
      kind: 'mail',
      id: m.id,
      title: m.subject || '（无主题）',
      description: `${date(m.occurred_at)} · ${m.direction === 'inbound' ? '收到' : '发出'} · ${m.preview.slice(0, 140)}`,
      customer_id: scope.customer_id,
      ...(m.project_id ? { project_id: m.project_id } : {}),
    })),
  );
}

export async function evidence(ctx: Context, input: unknown) {
  const { scope, kind, id } = sourceRequest.parse(input);
  if (scope.kind !== 'entity') throw new ApiError(400, '请先打开具体实体');
  await entity(ctx, scope);
  if (kind === 'record') {
    const row = (await records(ctx, scope, id))[0];
    if (!row) throw new ApiError(404, '记录不存在或不属于当前实体');
    const details = await recordEvidence(ctx, scope.customer_id, id);
    const originals = details.sources
      .map((s) => `${s.speaker} · ${date(s.occurred_at)}\n${s.body}`)
      .join('\n\n');
    const facts = details.facts
      .map((f) => `${f.invalid_at ? '历史候选，截至' + date(f.invalid_at) : '当前候选'}：${f.fact}`)
      .join('\n');
    return {
      title: recordKinds[row.kind],
      body: `${date(row.occurred_at || row.created_at)}\n\n${row.body}${originals ? '\n\n原始依据：\n' + originals : ''}${facts ? '\n\n以下信息由同一条记录提取，不是独立证据或新增公司确认：\n' + facts : ''}`,
    };
  }
  const m = await mail.mailDetail(ctx, id);
  if (
    m.customer_id !== scope.customer_id ||
    (scope.object === 'projects' && m.project_id !== scope.record_id) ||
    (scope.object === 'people' && !m.people.some((p) => p.id === scope.record_id))
  )
    throw new ApiError(404, '邮件不存在或不属于当前实体');
  return {
    title: m.subject || '（无主题）',
    body: `${date(m.occurred_at)}\n发件人：${m.sender.map((s) => s.address).join(', ')}\n\n${m.body || m.preview}`,
  };
}

export const sourceIdentity = (ref: AskSource) => `${ref.kind}:${ref.object || ''}:${ref.id}`;
/** A safe, read-only collection projection shared by Ask and Home listing.
 * The raw browse rows and its wider summary never cross this boundary. */
export async function modelDirectorySnapshot(
  ctx: Context,
  scope: Extract<AskScope, { kind: 'records' | 'list' }>,
): Promise<{ snapshot: AgentSnapshot; total: number; returned: number }> {
  const result = await collection(ctx, scope);
  const description = `当前范围共 ${result.total} 条；可查看记录并打开具体实体继续提问。`;
  const snapshot: AgentSnapshot = {
    schema: await entitySchema(ctx),
    label: result.label,
    sources: [
      {
        id: 'page:scope',
        title: result.label,
        body: `${description}\n服务端查询匹配总数：${result.total}；当前列出 ${result.items.length} 条目录。`,
      },
      ...result.items.map((r) => {
        const ref: AskSource = {
          kind: 'entity',
          id: r.id,
          customer_id: r.customer_id,
          object: result.type,
          title: r.name,
          description: '当前筛选内的实体目录',
          directory_fields: Object.entries(r.fields)
            .filter(([label]) => !['姓名', '公司名称', '项目名称'].includes(label))
            .map(([label, value]) => ({ label, value })),
        };
        return {
          id: sourceIdentity(ref),
          title: ref.title,
          body: `${ref.description}（仅基础档案）：\n${JSON.stringify(r.fields)}`,
          ref,
        };
      }),
    ],
    warnings: [
      '仅当前目录或页面指引，没有读取目录内不同客户的业务原文；目录总数不是反馈商家数。',
      '目录明细仅当前页已列出的记录；未列出或未覆盖的其他分页没有读取。筛选总数大于已列出条数时，不能把本页符合姓氏或片段的数量当作整个筛选的匹配数。',
      '已列出的邮箱、电话和所属公司属于授权基础目录，可据此回答，无需读取业务原文；“未填写”只表示对应档案字段为空，不能用公司邮箱或其他联系人的邮箱代替。多位符合姓名或姓氏条件时，逐位列明姓名、所属公司和各自字段，不任意猜选；查询业务详情仍须确定单个实体。',
    ],
  };
  return { snapshot, total: result.total, returned: result.items.length };
}

export async function modelSnapshot(
  ctx: Context,
  scope: AskScope,
  searchPlan?: KnowledgeSearchPlan,
  notePlan?: NoteRetrievalPlan,
): Promise<AgentSnapshot> {
  if (scope.kind === 'records' || scope.kind === 'list')
    return (await modelDirectorySnapshot(ctx, scope)).snapshot;
  const info = await context(ctx, { scope });
  const schema = await entitySchema(ctx);
  if (scope.kind === 'page')
    return {
      schema,
      label: info.label,
      sources: [
        {
          id: 'page:scope',
          title: info.label,
          body: `${info.description}\n仅能回答当前页面使用方法和一般问题；未读取邮件正文或微信历史，没有业务写入工具。`,
        },
      ],
      warnings: [
        '仅当前目录或页面指引，没有读取目录内不同客户的业务原文；目录总数不是反馈商家数。',
      ],
    };
  const profile = await query(ctx, { scope, action: 'overview', question: '查看档案' });
  const refs = await query(ctx, { scope, action: 'relationships', question: '查看关系' });
  const own = await entity(ctx, scope);
  const primary = entitySource(scope, own.record.name);
  const result: AgentSource[] = [
    { id: sourceIdentity(primary), title: primary.title, body: profile.body, ref: primary },
  ];
  if (scope.object === 'projects') {
    const state = await prospectStateContext(ctx, scope.customer_id, scope.record_id);
    if (state) result[0].body += `\n\n${state}`;
  }
  if (scope.object !== 'customers') {
    const c = own.customer;
    const ref: AskSource = {
      kind: 'entity',
      object: 'customers',
      id: c.id,
      customer_id: c.id,
      title: c.name,
      description: '所属公司背景',
    };
    result.push({
      id: sourceIdentity(ref),
      title: c.name,
      body: `仅作所属公司背景，不代表当前联系人说过或当前项目已确认：\n类型：${customerTypes[c.type]}\n地区：${c.region}\n合作状态：${customerStatuses[c.status]}`,
      ref,
    });
  }
  for (const ref of refs.sources) {
    if (result.some((s) => s.id === sourceIdentity(ref))) continue;
    result.push({ id: sourceIdentity(ref), title: ref.title, body: ref.description, ref });
  }
  const profileCount = result.length;
  const rows = await records(ctx, scope);
  for (const row of rows) {
    if (row.source_kind === 'email') continue;
    const ref: AskSource = {
      kind: 'record',
      id: row.id,
      customer_id: scope.customer_id,
      title: `${recordKinds[row.kind]} · ${date(row.created_at)}`,
      description: row.body.slice(0, 160),
      ...(row.project_id ? { project_id: row.project_id } : {}),
    };
    result.push({ id: sourceIdentity(ref), title: ref.title, body: row.body.slice(0, 6000), ref });
  }
  const mails = await mail.mailList(ctx, {
    customer_id: scope.customer_id,
    ...(scope.object === 'people' ? { person_id: scope.record_id } : {}),
    ...(scope.object === 'projects' ? { project_id: scope.record_id } : {}),
  });
  for (const m of mails.items.slice(0, 10)) {
    const detail = await mail.mailDetail(ctx, m.id);
    const record = (
      await ctx.tx.query<{ id: string }>(
        'SELECT id FROM customer_records WHERE workspace_id=$1 AND customer_id=$2 AND source_mail_id=$3',
        [ctx.workspaceId, scope.customer_id, m.id],
      )
    ).rows[0];
    const ref: AskSource = {
      kind: record ? 'record' : 'mail',
      id: record?.id || m.id,
      customer_id: scope.customer_id,
      title: m.subject || '无主题邮件',
      description: `${date(m.occurred_at)} · ${m.direction === 'inbound' ? '收到' : '发出'}`,
      ...(m.project_id ? { project_id: m.project_id } : {}),
    };
    result.push({
      id: sourceIdentity(ref),
      title: ref.title,
      body: `方向：${m.direction}\n时间：${m.occurred_at}\n发件人：${m.sender.map((s) => s.address).join(', ')}\n${(detail.body || m.preview).slice(0, 6000)}`,
      ref,
    });
  }
  if (scope.object === 'customers') {
    const values = (
      await ctx.tx.query<{ name: string; value: unknown; origin: string }>(
        `SELECT f.name,v.value,v.origin FROM customer_attribute_values v JOIN customer_attributes f
       ON f.workspace_id=v.workspace_id AND f.id=v.attribute_id
       WHERE v.workspace_id=$1 AND v.customer_id=$2 AND NOT f.archived ORDER BY f.created_at,f.id LIMIT 30`,
        [ctx.workspaceId, scope.customer_id],
      )
    ).rows;
    if (values.length)
      result[0].body += `\n自定义属性（沿用已有值，AI 来源不等于公司确认事实）：\n${JSON.stringify(values).slice(0, 12000)}`;
  }
  const warnings = [
    `业务记录仅最近 ${rows.length} 条（上限20）；邮件总数 ${mails.total}，正文仅最近 ${Math.min(mails.items.length, 10)} 封，每份正文上限6000字。未覆盖历史不能推断不存在。`,
    '项目和联系人的关系来源不扩大归属；公司背景与本项目/本人表达分别归因。未提供跨商家统计、联网、微信历史读取或任何写入工具。',
  ];
  const filter = {
    ...(scope.object === 'projects' ? { project_id: scope.record_id } : {}),
    ...(scope.object === 'people' ? { person_id: scope.record_id } : {}),
  };
  if (
    searchPlan &&
    (searchPlan.scope.customer_id !== scope.customer_id ||
      JSON.stringify(searchPlan.scope.filter) !== JSON.stringify(filter))
  )
    throw new ApiError(409, '检索范围与当前实体不一致，请重新提问');
  const selection = searchPlan ? await validateKnowledgeSearch(ctx, searchPlan) : undefined;
  const knowledge = await knowledgeAgentSources(ctx, scope.customer_id, filter, selection);
  // Question hits and their correction evidence precede generic recent mail/records.
  result.splice(profileCount, 0, ...knowledge);
  let combined = result;
  if (notePlan) {
    if (
      notePlan.scope.customer_id !== scope.customer_id ||
      JSON.stringify(notePlan.scope.filter) !== JSON.stringify(filter)
    )
      throw new ApiError(409, '笔记检索范围与当前实体不一致，请重新提问');
    const notes = await noteRetrievedSources(ctx, notePlan);
    combined = mergeNoteSources(
      notes.sources,
      notes.sources.length
        ? await canonicalNoteEvidenceSources(ctx, scope.customer_id, result)
        : result,
    );
    warnings.push(...notes.warnings);
  }
  if (selection) warnings.push(selection.warning);
  warnings.push(
    '统一记录补充近期Record和图候选；已执行问题检索时优先纳入命中及必要纠正链。已抽取Record保留获授权原文，未抽取片段最多6000字；图候选来自同一Record，不是独立证据。未覆盖不等于不存在，沟通时间不等于公司确认时间。',
  );
  const bounded = budgetAgentSources(combined, selection?.atomic_record_groups);
  warnings.push(...bounded.warnings);
  return { schema, label: info.label, sources: bounded.sources, warnings };
}
export async function contextWithModel(ctx: Context, input: unknown, options: AgentModelOptions) {
  const info = await context(ctx, input),
    status = await agentStatus(ctx, options);
  return {
    ...info,
    model: status.configured,
    model_name: status.model,
    can_manage: status.can_manage,
    region: status.region,
  };
}
const runtimeKey = randomBytes(32);
export async function modelQuery(
  db: Database,
  actor: string,
  workspace: string,
  input: unknown,
  options: AgentModelOptions,
  stream?: AgentStream,
): Promise<AskAnswer> {
  const value = questionRequest
    .extend({
      continuation: z.string().max(1000000).optional(),
      chat_id: uuid.optional(),
      request_id: uuid.optional(),
    })
    .parse(input);
  stream?.signal.throwIfAborted();
  const chatId = value.chat_id || randomUUID();
  const requestId = value.request_id || randomUUID();
  const prepared = await scoped(db, actor, workspace, async (ctx) => {
    await assertRunAvailable(ctx, chatId, stream?.runToken);
    const session = await prepareAskSession(ctx, {
      chat_id: chatId,
      request_id: requestId,
      scope: value.scope,
      question: value.question,
      action: value.action,
    });
    if ('replay' in session) return { complete: session.replay };
    const preferencePlan = await preparePreference(ctx, {
      question: value.question,
      previousAssistant: session.history.filter((turn) => turn.role === 'assistant').at(-1)
        ?.content,
    });
    const status = await agentStatus(ctx, options);
    if (!status.configured) {
      const local = await query(ctx, {
        scope: value.scope,
        action: value.action,
        question: value.question,
      });
      stream?.signal.throwIfAborted();
      const saved = await saveAskAnswer(
        ctx,
        session.claim,
        value.question,
        local,
        local.sources,
        undefined,
        async (message_id) => ({
          preference: await applyPreference(ctx, preferencePlan, {
            chat_id: chatId,
            request_id: requestId,
            message_id,
          }),
        }),
      );
      stream?.signal.throwIfAborted();
      return { complete: saved.answer };
    }
    const snapshot = await modelSnapshot(ctx, value.scope);
    const search =
      value.scope.kind === 'entity'
        ? await prepareKnowledgeSearch(ctx, value.scope.customer_id, value.question, {
            ...(value.scope.object === 'projects' ? { project_id: value.scope.record_id } : {}),
            ...(value.scope.object === 'people' ? { person_id: value.scope.record_id } : {}),
          })
        : undefined;
    const transport = await prepareAgent(
      ctx,
      value.scope.kind === 'entity' ? value.scope.customer_id : null,
      options,
    );
    return {
      snapshot,
      entry_context: bindAgentEntry(ctx, 'page_ask', 'page_question', askEntryScope(value.scope))
        .modelContext,
      transport,
      search,
      noteSearch:
        value.scope.kind === 'entity'
          ? await prepareNoteRetrieval(ctx, value.scope.customer_id, value.question, {
              ...(value.scope.object === 'projects' ? { project_id: value.scope.record_id } : {}),
              ...(value.scope.object === 'people' ? { person_id: value.scope.record_id } : {}),
            })
          : undefined,
      claim: session.claim,
      history: session.history,
      preferencePlan,
    };
  });
  if (!prepared.claim) return prepared.complete!;
  try {
    const [searchPlan, notePlan] = await Promise.all([
      prepared.search
        ? executeKnowledgeSearch(prepared.search, options.knowledgeSearch)
        : undefined,
      prepared.noteSearch ? executeNoteRetrieval(db, prepared.noteSearch, options) : undefined,
    ]);
    const snapshot =
      searchPlan || notePlan
        ? await scoped(db, actor, workspace, (ctx) =>
            modelSnapshot(ctx, value.scope, searchPlan, notePlan),
          )
        : prepared.snapshot;
    // Keep encrypted continuations compatible for old clients. Persistent sessions
    // use their authorized server history, so refresh or elapsed time cannot expire them.
    const contextDigest = createHash('sha256')
      .update(
        JSON.stringify([
          snapshotDigest(prepared.snapshot),
          searchPlan ? [searchPlan.scope, searchPlan.publication] : null,
          notePlan ? [notePlan.scope, notePlan.digest, notePlan.vector?.index_version] : null,
        ]),
      )
      .digest('hex');
    const digest = snapshotDigest(snapshot),
      key = options.key || runtimeKey;
    const binding = `ask:${workspace}:${actor}:${JSON.stringify(value.scope)}`;
    const history = value.chat_id
      ? prepared.history
      : resumeTurns(value.continuation, key, binding, contextDigest);
    const modelInput = planAgentContext(
      { workspaceId: workspace, actorId: actor },
      bindAgentEntry(
        { workspaceId: workspace, actorId: actor },
        'page_ask',
        'page_question',
        askEntryScope(value.scope),
      ),
      {
        entry_context: prepared.entry_context,
        snapshot,
        history,
        question: value.question,
        user_preferences: prepared.preferencePlan.preferences.map(({ category, content }) => ({
          category,
          value: content,
        })),
        preference_instruction: prepared.preferencePlan.instruction,
      },
      {
        chatId: value.chat_id || undefined,
        runId: stream?.runId,
        dependencies: [{ kind: 'evidence', digest }],
      },
    );
    const guard = async (ctx: Context) => {
      const currentDigest = snapshotDigest(
        await modelSnapshot(ctx, value.scope, searchPlan, notePlan),
      );
      if (currentDigest !== digest)
        throw new ApiError(409, '生成期间资料或可见范围已变化，请重新提问');
      assertAgentContextCurrent(modelInput.context_plan, ctx, {
        scopeDigest: bindAgentEntry(ctx, 'page_ask', 'page_question', askEntryScope(value.scope))
          .scope_digest,
        evidenceDigest: currentDigest,
      });
    };
    stream?.registerGuard?.(guard);
    const checkedStream = stream
      ? {
          signal: stream.signal,
          async onText(text: string) {
            stream.signal.throwIfAborted();
            await scoped(db, actor, workspace, guard);
            await stream.onText(text);
          },
        }
      : undefined;
    const raw =
      checkedStream && prepared.transport.stream
        ? await prepared.transport.stream(modelInput, checkedStream, {
            beforeRetry: () => scoped(db, actor, workspace, guard),
          })
        : await prepared.transport.generate(modelInput, {
            beforeRetry: () => scoped(db, actor, workspace, guard),
          });
    stream?.signal.throwIfAborted();
    const result = parseAgentResult(raw, snapshot.sources);
    return await scoped(db, actor, workspace, async (ctx) => {
      await guard(ctx);
      stream?.signal.throwIfAborted();
      const reply: AskAnswer = {
        body: result.body,
        sources: result.sources.flatMap((s) => (s.ref ? [s.ref] : [])),
        mode: 'model',
        generated_at: new Date().toISOString(),
        model: agentModel,
        continuation: continueTurns(
          [
            ...history,
            { role: 'user', content: value.question },
            { role: 'assistant', content: result.body },
          ],
          key,
          binding,
          contextDigest,
        ),
      };
      const saved = await saveAskAnswer(
        ctx,
        prepared.claim,
        value.question,
        reply,
        snapshot.sources.flatMap((s) => (s.ref ? [s.ref] : [])),
        digest,
        async (message_id) => ({
          preference: await applyPreference(ctx, prepared.preferencePlan, {
            chat_id: chatId,
            request_id: requestId,
            message_id,
          }),
        }),
      );
      stream?.signal.throwIfAborted();
      return saved.answer;
    });
  } catch (error) {
    // The accepted empty conversation remains visible, but no half-answer is
    // committed. A revoked actor cannot enter scoped(); release only this known
    // private lease by its token without reading or modifying any CRM content.
    await scoped(db, actor, workspace, (ctx) => releaseAskSession(ctx, prepared.claim)).catch(() =>
      db
        .query(
          'DELETE FROM ask_session_claims WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3 AND request_id=$4 AND token=$5',
          [
            workspace,
            actor,
            prepared.claim.chat_id,
            prepared.claim.request_id,
            prepared.claim.token,
          ],
        )
        .catch(() => undefined),
    );
    throw error;
  }
}
