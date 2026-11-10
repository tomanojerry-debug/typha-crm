import type { AgentSnapshot } from '../shared/agent.js';
import type { AskScope, AskSource } from '../shared/ask.js';
import type { ChatMessage } from '../shared/chat.js';
import type { ChatEntityType, ChatMatchMode, ChatRetrieval } from '../shared/chat-intent.js';
import { modelSnapshot } from './ask.js';
import type { Context } from './security.js';
import type { KnowledgeSearchPlan } from './knowledge-search.js';
import { customerStatuses, customerTypes, projectStages, projectTypes } from '../shared/domain.js';

export type ChatEntityScope = Extract<AskScope, { kind: 'entity' }>;
type Candidate = {
  id: string;
  customer_id: string;
  name: string;
  company: string;
  object: 'customers' | 'people' | 'projects';
  total: number;
  company_type: keyof typeof customerTypes;
  company_region: string;
  company_status: keyof typeof customerStatuses;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  job_title: string | null;
  project_type: keyof typeof projectTypes | null;
  project_stage: keyof typeof projectStages | null;
  due_date: string | null;
};
export type ChatRetrieved = {
  snapshot: AgentSnapshot;
  scope: ChatEntityScope | null;
  lookup: NonNullable<ChatMessage['lookup']>;
};

function directorySnapshot(record: Candidate): AgentSnapshot {
  const ref = reference(record);
  return {
    label: `邮件任务目标 · ${record.name}`,
    sources: [
      {
        id: `entity:${record.object}:${record.id}`,
        title: ref.title,
        body: JSON.stringify({
          name: ref.title,
          company: ref.company_name,
          fields: ref.directory_fields,
        }),
        ref,
      },
    ],
    warnings: [
      '本次只核验授权基础目录以确定邮件任务目标，未读取客户业务原文。先询问模板选择，不拟稿或发送。',
    ],
  };
}
// This projection deliberately excludes descriptions, records, AI attributes and
// raw communications. Only authorized, existing basic directory columns enter cards.
const directoryColumns = {
  customers: `c.id,c.id AS customer_id,c.name,c.name AS company,'customers'::text AS object,
    c.type AS company_type,c.region AS company_region,c.status AS company_status,
    c.email,c.phone,c.contact_name,NULL::text AS job_title,
    NULL::text AS project_type,NULL::text AS project_stage,NULL::text AS due_date`,
  people: `p.id,p.customer_id,p.name,c.name AS company,'people'::text AS object,
    c.type AS company_type,c.region AS company_region,c.status AS company_status,
    p.email,p.phone,NULL::text AS contact_name,p.job_title,
    NULL::text AS project_type,NULL::text AS project_stage,NULL::text AS due_date`,
  projects: `p.id,p.customer_id,p.name,c.name AS company,'projects'::text AS object,
    c.type AS company_type,c.region AS company_region,c.status AS company_status,
    NULL::text AS email,NULL::text AS phone,NULL::text AS contact_name,NULL::text AS job_title,
    p.type AS project_type,p.stage AS project_stage,p.due_date::text AS due_date`,
};
function directoryFields(record: Candidate): NonNullable<AskSource['directory_fields']> {
  const values: [string, string | null][] =
    record.object === 'projects'
      ? [
          ['项目类型', record.project_type ? projectTypes[record.project_type] : null],
          ['项目阶段', record.project_stage ? projectStages[record.project_stage] : null],
          ['目标日期', record.due_date],
        ]
      : [
          ...(record.object === 'people'
            ? ([
                ['邮箱', record.email],
                ['职位', record.job_title],
                ['电话', record.phone],
              ] as [string, string | null][])
            : []),
          ['公司类型', customerTypes[record.company_type]],
          ['地区', record.company_region],
          ['合作状态', customerStatuses[record.company_status]],
          ...(record.object === 'customers'
            ? ([
                ['公司邮箱', record.email],
                ['公司电话', record.phone],
                ['主要联系人', record.contact_name],
              ] as [string, string | null][])
            : []),
        ];
  return values.flatMap(([label, value]) =>
    typeof value === 'string' && value.trim() ? [{ label, value }] : [],
  );
}
const reference = (record: Candidate): AskSource => ({
  kind: 'entity',
  object: record.object,
  id: record.id,
  customer_id: record.customer_id,
  title: record.name,
  ...(record.object !== 'customers' ? { company_name: record.company } : {}),
  directory_fields: directoryFields(record),
  description: `候选目录 · ${record.object === 'customers' ? '公司' : record.object === 'people' ? '联系人' : '项目'} · 所属公司：${record.company}`,
});

// Saved candidate order and historical answer text stay intact. Only attach
// current metadata from the same RLS-protected basic directory as search.
export async function hydrateChatCandidates(ctx: Context, refs: AskSource[]): Promise<AskSource[]> {
  const customers = refs
    .filter((ref) => ref.kind === 'entity' && ref.object === 'customers')
    .map((ref) => ref.id);
  const people = refs
    .filter((ref) => ref.kind === 'entity' && ref.object === 'people')
    .map((ref) => ref.id);
  const projects = refs
    .filter((ref) => ref.kind === 'entity' && ref.object === 'projects')
    .map((ref) => ref.id);
  const rows =
    customers.length || people.length || projects.length
      ? (
          await ctx.tx.query<Candidate>(
            `SELECT ${directoryColumns.customers},1 AS total FROM customers c
         WHERE c.workspace_id=$1 AND c.id=ANY($2::uuid[]) AND c.archived_at IS NULL
         UNION ALL
         SELECT ${directoryColumns.people},1 AS total
         FROM people p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id
         WHERE p.workspace_id=$1 AND p.id=ANY($3::uuid[]) AND p.archived_at IS NULL AND c.archived_at IS NULL
         UNION ALL
         SELECT ${directoryColumns.projects},1 AS total
         FROM projects p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id
         WHERE p.workspace_id=$1 AND p.id=ANY($4::uuid[]) AND p.archived_at IS NULL AND c.archived_at IS NULL`,
            [ctx.workspaceId, customers, people, projects],
          )
        ).rows
      : [];
  const current = new Map(
    rows.map((row) => [`${row.object}:${row.id}:${row.customer_id}`, reference(row)]),
  );
  return refs.map(({ company_name: _previous, directory_fields: _fields, ...ref }) => {
    const fresh = current.get(`${ref.object}:${ref.id}:${ref.customer_id}`);
    return fresh
      ? {
          ...ref,
          ...(fresh.company_name !== undefined ? { company_name: fresh.company_name } : {}),
          directory_fields: fresh.directory_fields,
        }
      : ref;
  });
}

export async function retrieveChatTarget(
  ctx: Context,
  target: string,
  customer: string | null,
  kind: 'name' | 'email',
  options: {
    candidateOnly?: boolean;
    entity_type?: ChatEntityType;
    match_mode?: ChatMatchMode | null;
    knowledgePlan?: KnowledgeSearchPlan;
    directoryOnly?: boolean;
  } = {},
): Promise<ChatRetrieved> {
  const query = target.trim().toLowerCase();
  const mode = options.match_mode || kind;
  const entity = mode === 'surname' ? 'person' : options.entity_type || 'unknown';
  const exactEmail = mode === 'email' && query.includes('@');
  const candidateOnly =
    options.candidateOnly || mode === 'surname' || (entity === 'person' && [...query].length === 1);
  const safe =
    query.length <= 254 &&
    (mode === 'surname'
      ? /^\p{Script=Han}{1,4}$/u.test(query)
      : query.length >= (entity === 'unknown' ? 2 : 1)) &&
    !/^(?:(?:全部|所有|当前|这个|这家)的?)?(?:客户|公司|联系人|项目|资料|信息)$/.test(query) &&
    !/[\r\n\u0000]/.test(query);
  const matches = safe
    ? (
        await ctx.tx.query<Candidate>(
          `WITH candidates AS (
      SELECT ${directoryColumns.customers}
      FROM customers c WHERE c.workspace_id=$1 AND c.archived_at IS NULL
        AND ($3::uuid IS NULL OR c.id=$3) AND $6 IN ('unknown','company') AND $7<>'surname'
        AND (CASE WHEN $4 THEN
          (CASE WHEN $5 THEN lower(trim(c.email))=$2 ELSE position($2 in lower(c.email))>0 END)
          OR EXISTS (SELECT 1 FROM people p WHERE p.workspace_id=c.workspace_id AND p.customer_id=c.id
            AND p.archived_at IS NULL AND CASE WHEN $5 THEN lower(trim(p.email))=$2 ELSE position($2 in lower(p.email))>0 END)
          ELSE position($2 in lower(c.name))>0 END)
      UNION ALL
      SELECT ${directoryColumns.people}
      FROM people p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id
      WHERE p.workspace_id=$1 AND p.archived_at IS NULL AND c.archived_at IS NULL
        AND ($3::uuid IS NULL OR p.customer_id=$3) AND $6 IN ('unknown','person')
        AND CASE WHEN $7='surname' THEN
          left(regexp_replace(trim(p.name), '^(\\[[^]]+\\]|【[^】]+】)[[:space:]]*', ''),char_length($2))=$2
          WHEN $4 THEN $6='person' AND CASE WHEN $5 THEN lower(trim(p.email))=$2 ELSE position($2 in lower(p.email))>0 END
          ELSE position($2 in lower(p.name))>0 END
      UNION ALL
      SELECT ${directoryColumns.projects}
      FROM projects p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id
      WHERE p.workspace_id=$1 AND p.archived_at IS NULL AND c.archived_at IS NULL AND NOT $4 AND $7<>'surname'
        AND ($3::uuid IS NULL OR p.customer_id=$3) AND $6 IN ('unknown','project') AND position($2 in lower(p.name))>0
    ) SELECT *,count(*) OVER()::int AS total FROM candidates ORDER BY name,object,id LIMIT 10`,
          [ctx.workspaceId, query, customer, mode === 'email', exactEmail, entity, mode],
        )
      ).rows
    : [];
  const total = matches[0]?.total || 0;
  const lookup = {
    query,
    kind,
    total,
    exact: exactEmail || (total === 1 && matches[0].name.toLowerCase() === query),
  };
  const refs = matches.map(reference);
  const retrieval: ChatRetrieval = {
    status: !safe
      ? 'not_searched'
      : total === 0
        ? 'no_match'
        : total === 1 && !candidateOnly
          ? 'unique'
          : 'candidates',
    query,
    entity_type: entity,
    match_mode: mode,
    total,
    truncated: total > refs.length,
    candidates: refs,
  };
  if (retrieval.status === 'unique') {
    const record = matches[0];
    const scope: ChatEntityScope = {
      kind: 'entity',
      object: record.object,
      customer_id: record.customer_id,
      record_id: record.id,
    };
    const snapshot = options.directoryOnly
      ? directorySnapshot(record)
      : await modelSnapshot(ctx, scope, options.knowledgePlan);
    snapshot.retrieval = retrieval;
    snapshot.warnings.push(
      '服务端已唯一匹配用户指定实体，直接依据资料回答，无需用户再次选择客户。',
    );
    return { snapshot, scope, lookup };
  }
  return {
    scope: null,
    lookup,
    snapshot: {
      label: `授权${entity === 'person' ? '联系人' : '实体'}目录 · ${query}`,
      sources: refs.map((ref, index) => ({
        id: `entity:${ref.object}:${ref.id}`,
        title: ref.title,
        body: `候选${index + 1} · ${ref.description}`,
        ref,
      })),
      retrieval,
      warnings: [
        !safe
          ? '搜索条件不足或不支持此匹配方式，本次没有查询。请补充可用于限定搜索的信息，不要求预先选择客户。'
          : total
            ? `找到${total}个候选，按服务端顺序最多显示10个；即使只有一位也先展示候选。请用户选择具体实体；本次未读取候选业务原文，不得混合分析。`
            : '当前授权目录内未找到匹配实体。请核对姓氏、名称或邮箱；不能推断全系统没有资料或用户没有权限。',
      ],
    },
  };
}

export async function retrieveChatSelection(
  ctx: Context,
  ref: AskSource,
  customer: string | null,
  previous: ChatRetrieval,
  knowledgePlan?: KnowledgeSearchPlan,
  options: { directoryOnly?: boolean } = {},
): Promise<ChatRetrieved> {
  const object = ref.object;
  // Server-persisted references still require current RLS, parent and archive checks.
  const rows =
    object && ['customers', 'people', 'projects'].includes(object)
      ? (
          await ctx.tx.query<Candidate>(
            object === 'customers'
              ? `SELECT ${directoryColumns.customers},1 AS total FROM customers c
         WHERE c.workspace_id=$1 AND c.id=$2 AND c.id=$3 AND c.archived_at IS NULL AND ($4::uuid IS NULL OR c.id=$4)`
              : `SELECT ${directoryColumns[object]},1 AS total FROM ${object} p
         JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id
         WHERE p.workspace_id=$1 AND p.id=$2 AND p.customer_id=$3 AND p.archived_at IS NULL AND c.archived_at IS NULL
           AND ($4::uuid IS NULL OR p.customer_id=$4)`,
            [ctx.workspaceId, ref.id, ref.customer_id, customer],
          )
        ).rows
      : [];
  const record = rows[0];
  const retrieval: ChatRetrieval = {
    ...previous,
    status: record ? 'unique' : 'not_searched',
    candidates: record ? [reference(record)] : [],
    total: record ? 1 : 0,
    truncated: false,
  };
  const lookup = {
    query: previous.query || '',
    total: retrieval.total,
    exact: true,
    kind: previous.match_mode === 'email' ? ('email' as const) : ('name' as const),
  };
  if (!record)
    return {
      scope: null,
      lookup,
      snapshot: {
        label: '候选已失效',
        sources: [],
        retrieval,
        warnings: [
          '选中的候选已不可访问或已归档，本次没有读取业务资料。请重新限定条件搜索，不按旧序号猜选其他人。',
        ],
      },
    };
  const scope: ChatEntityScope = {
    kind: 'entity',
    object: record.object,
    customer_id: record.customer_id,
    record_id: record.id,
  };
  const snapshot = options.directoryOnly
    ? directorySnapshot(record)
    : await modelSnapshot(ctx, scope, knowledgePlan);
  snapshot.retrieval = retrieval;
  snapshot.warnings.push(
    '用户已选择候选，服务端重新验证权限和归属。继续原任务，直接依据该实体资料回答，不再次要求选择客户。',
  );
  return { scope, lookup, snapshot };
}
