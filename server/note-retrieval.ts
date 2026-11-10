import { createHash } from 'node:crypto';
import type { AgentSource } from '../shared/agent.js';
import type { SourceSearchPlan } from '../shared/source-search.js';
import type { AgentModelOptions } from './agent-model.js';
import type { Database } from './db.js';
import type { KnowledgeSearchFilter } from './knowledge-search.js';
import { listNotes, noteDetail } from './notes.js';
import { currentNoteKnowledgeSources, resolveNoteSource } from './note-sources.js';
import { ApiError, scoped, type Context } from './security.js';
import {
  ensureSourceIndex,
  executeSourceSearch,
  prepareSourceSearch,
  validateSourceSearch,
} from './source-index.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = () => new ApiError(409, '生成期间笔记版本、来源或权限已变化，请重新提问');
export interface NoteRetrievalPrepared {
  scope: {
    workspace_id: string;
    actor_id: string;
    customer_id: string;
    filter: KnowledgeSearchFilter;
  };
  query: string;
  digest: string;
  original_count: number;
  can_index: boolean;
}
export interface NoteRetrievalPlan extends NoteRetrievalPrepared {
  vector: SourceSearchPlan | null;
  warning: string;
}

/** A note view is navigation over canonical sources, never a second independent fact. */
function searchTerms(query: string) {
  const quoted = [...query.matchAll(/[“"「『`](.{2,100}?)[”"」』`]/gu)].map((m) => m[1]);
  const parts = query
    .split(
      /(?:请|帮我|查找|查一下|找一下|寻找|找|看看|查看|总结|概括|整理|这家|这个|当前|客户|公司|项目|联系人|最近|之前|上个月|这个月|上周|本周|今年|去年|笔记|记录|关于|提到|写的|创建的|更新的|里的|的|[\s，。！？、：:;；])/u,
    )
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 100);
  return [...new Set([...quoted, ...parts.sort((a, b) => b.length - a.length)])].slice(0, 4);
}

async function currentContext(
  ctx: Context,
  customerId: string,
  filter: KnowledgeSearchFilter,
  query: string,
) {
  const page = await listNotes(ctx, { customer_id: customerId, ...filter, limit: 30, offset: 0 });
  // Pure summaries intentionally have no independent vector/Record. Search their
  // authorized text as well, so an older summary can still be found by its title/topic.
  const matched = new Map<string, (typeof page.notes)[number]>();
  for (const term of searchTerms(query)) {
    const found = await listNotes(ctx, {
      customer_id: customerId,
      ...filter,
      search: term,
      limit: 30,
      offset: 0,
    });
    for (const note of found.notes) if (!matched.has(note.id)) matched.set(note.id, note);
  }
  for (const note of page.notes) if (!matched.has(note.id)) matched.set(note.id, note);
  const originals = (await currentNoteKnowledgeSources(ctx, customerId)).filter(
    (s) =>
      (!filter.project_id || s.project_id === filter.project_id) &&
      (!filter.person_id || s.person_ids.includes(filter.person_id)),
  );
  const sources = new Map<string, AgentSource>();
  const views: unknown[] = [];
  for (const summary of matched.values()) {
    const note = await noteDetail(ctx, summary.id);
    const roots: Awaited<ReturnType<typeof resolveNoteSource>>[] = [];
    let eligible = true;
    for (const ref of note.sources) {
      try {
        const root = await resolveNoteSource(ctx, customerId, ref, filter);
        if (root.source_hash !== ref.source_hash || !root.body.includes(ref.quote)) throw changed();
        roots.push({ ...root, quote: ref.quote });
      } catch (error) {
        if (error instanceof ApiError && [403, 404, 409].includes(error.status)) {
          eligible = false;
          break;
        }
        throw error;
      }
    }
    if (!eligible) continue;
    const view = {
      note_id: note.id,
      revision_id: note.revision_id,
      version: note.revision_version,
      state_version: note.version,
      content_hash: note.content_hash,
      title: note.title,
      project_id: note.project_id,
      person_ids: note.person_ids,
      author: note.created_by_name,
      editor: note.edited_by_name,
      created_at: note.created_at,
      updated_at: note.updated_at,
      derived_blocks: note.blocks
        .filter((b) => b.origin !== 'original')
        .map((b) => ({
          text: b.text,
          origin: b.origin,
          record_ids: [...new Set(b.sources.map((s) => s.record_id))],
        })),
    };
    views.push(view);
    sources.set(`note-view:${note.id}`, {
      id: `note-view:${note.id}`,
      title: `笔记目录：${note.title} · v${note.revision_version}`,
      body: JSON.stringify({
        ...view,
        notice:
          '笔记目录与派生整理视图。事实引用原始Record，不能把此视图计为另一份证据。原始内部补充以对应笔记Record为准。',
      }),
    });
    for (const root of roots) {
      const id = `record::${root.record_id}`;
      const prior = sources.get(id);
      const quote = { source_hash: root.source_hash, quote: root.quote };
      const quotes = prior ? (JSON.parse(prior.body).quotes as unknown[]) : [];
      if (!quotes.some((q) => JSON.stringify(q) === JSON.stringify(quote))) quotes.push(quote);
      sources.set(id, {
        id,
        title: root.title || '笔记引用的原始资料',
        ref: {
          kind: 'record',
          id: root.record_id,
          customer_id: customerId,
          title: root.title || '原始资料',
          description: '笔记引用的原始Record；摘要不另计证据',
          source_hash: root.source_hash,
          ...(root.project_id ? { project_id: root.project_id } : {}),
          ...(root.note_id
            ? { note_id: root.note_id, note_revision_id: root.note_revision_id }
            : {}),
        },
        body: JSON.stringify({
          quotes,
          notice: '经当前权限及内容版本校验的原文摘录；与其他索引同Record合并。',
        }),
      });
    }
  }
  return {
    sources: [...sources.values()],
    original_count: originals.length,
    digest: digest([views, originals]),
    warning: page.has_more
      ? '笔记目录包含最近30篇及按问题标题/主题匹配的候选，语义检索另查当前范围的笔记内部原文；未覆盖不代表不存在。'
      : '',
  };
}

export async function prepareNoteRetrieval(
  ctx: Context,
  customerId: string,
  query: string,
  filter: KnowledgeSearchFilter = {},
): Promise<NoteRetrievalPrepared> {
  const content = await currentContext(ctx, customerId, filter, query);
  const canIndex = (
    await ctx.tx.query<{ ok: boolean }>('SELECT crm_access($1,$2,true) AS ok', [
      ctx.workspaceId,
      customerId,
    ])
  ).rows[0]?.ok;
  return {
    scope: {
      workspace_id: ctx.workspaceId,
      actor_id: ctx.actorId,
      customer_id: customerId,
      filter,
    },
    query: query.slice(0, 2000),
    digest: content.digest,
    original_count: content.original_count,
    can_index: !!canIndex,
  };
}

/** Embedding/index work stays outside CRM transactions and is restricted to note retrieval. */
export async function executeNoteRetrieval(
  db: Database,
  prepared: NoteRetrievalPrepared,
  options: AgentModelOptions,
): Promise<NoteRetrievalPlan> {
  const { actor_id: actor, workspace_id: workspace, customer_id: customer } = prepared.scope;
  let vector: SourceSearchPlan | null = null;
  let warning = '';
  if (prepared.original_count && options.embeddings) {
    if (prepared.can_index)
      await ensureSourceIndex(db, actor, workspace, customer, options.embeddings);
    const search = await scoped(db, actor, workspace, async (ctx) => {
      if (
        (await prepareNoteRetrieval(ctx, customer, prepared.query, prepared.scope.filter))
          .digest !== prepared.digest
      )
        throw changed();
      return prepareSourceSearch(ctx, customer, prepared.query, {
        ...prepared.scope.filter,
        note_only: true,
      });
    });
    vector = await executeSourceSearch(search, options.embeddings);
  } else if (prepared.original_count) {
    warning = '笔记原文语义检索未配置；本次使用当前授权近期笔记与可用图索引，不能断言完整历史。';
  }
  return { ...prepared, vector, warning };
}

export async function noteRetrievedSources(ctx: Context, plan: NoteRetrievalPlan) {
  if (ctx.actorId !== plan.scope.actor_id || ctx.workspaceId !== plan.scope.workspace_id)
    throw changed();
  const current = await currentContext(ctx, plan.scope.customer_id, plan.scope.filter, plan.query);
  if (current.digest !== plan.digest) throw changed();
  const vector = plan.vector ? await validateSourceSearch(ctx, plan.vector) : null;
  return {
    sources: mergeNoteSources(vector?.sources || [], current.sources),
    warnings: [plan.warning, current.warning, ...(vector?.warnings || [])].filter(Boolean),
  };
}

/** A direct mail view and its canonical Record remain one source alongside a note summary. */
export async function canonicalNoteEvidenceSources(
  ctx: Context,
  customerId: string,
  sources: AgentSource[],
) {
  const mails = sources.flatMap((s) => (s.ref?.kind === 'mail' ? [s.ref.id] : []));
  if (!mails.length) return sources;
  const rows = (
    await ctx.tx.query<{ id: string; source_mail_id: string }>(
      "SELECT id,source_mail_id FROM customer_records WHERE workspace_id=$1 AND customer_id=$2 AND source_kind='email' AND source_mail_id=ANY($3::uuid[])",
      [ctx.workspaceId, customerId, mails],
    )
  ).rows;
  const canonical = new Map(rows.map((r) => [r.source_mail_id, r.id]));
  return sources.map((s) => {
    const record = s.ref?.kind === 'mail' ? canonical.get(s.ref.id) : undefined;
    return record
      ? { ...s, id: `record::${record}`, ref: { ...s.ref!, kind: 'record' as const, id: record } }
      : s;
  });
}

/** Keep one Record identity while retaining the graph, quotation and vector evidence views. */
export function mergeNoteSources(priority: AgentSource[], rest: AgentSource[]): AgentSource[] {
  const merged = new Map<string, AgentSource>();
  const value = (body: string): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  };
  for (const source of [...priority, ...rest]) {
    const prior = merged.get(source.id);
    if (!prior) merged.set(source.id, source);
    else if (prior.body !== source.body)
      merged.set(source.id, {
        ...source,
        ref: prior.ref?.note_revision_id
          ? {
              ...source.ref,
              ...prior.ref,
              ...(prior.ref.note_version === undefined && source.ref?.note_version !== undefined
                ? { note_version: source.ref.note_version }
                : {}),
            }
          : source.ref?.note_revision_id
            ? source.ref
            : prior.ref?.source_hash
              ? prior.ref
              : source.ref || prior.ref,
        title: prior.ref?.note_revision_id ? prior.title : source.title,
        body: JSON.stringify({
          views: [value(prior.body), value(source.body)],
          notice: '同一Record的多种检索/整理视图，合计一份原始证据。',
        }),
      });
  }
  return [...merged.values()];
}
