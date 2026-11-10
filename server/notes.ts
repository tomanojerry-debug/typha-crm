import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Context } from './security.js';
import { activeCustomer, customer, project } from './service.js';
import { person } from './people.js';
import { resolveNoteSource } from './note-sources.js';
import {
  noteLimits,
  type NoteBlock,
  type NoteContent,
  type NoteDetail,
  type NoteDraft,
  type NoteListResponse,
  type NoteSourceRef,
  type NoteTemplate,
  type NoteKnowledgeVersion,
} from '../shared/notes.js';

const uuid = z.string().uuid();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceSchema = z.object({
  record_id: uuid,
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  quote: z.string().min(1).max(noteLimits.text),
  source_id: z.string().max(200).optional(),
  title: z.string().max(500).optional(),
});
const blockSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['paragraph', 'heading', 'bullet', 'numbered', 'quote']),
  text: z.string().max(noteLimits.text),
  origin: z.enum(['original', 'quote', 'derived']),
  sources: z.array(sourceSchema).max(noteLimits.sources).default([]),
});
const contentSchema = z.object({
  title: z.string().max(noteLimits.title),
  customer_id: uuid.nullable(),
  project_id: uuid.nullable(),
  person_ids: z.array(uuid).max(30),
  blocks: z.array(blockSchema).max(noteLimits.blocks),
});
const draftSchema = contentSchema.extend({
  request_id: uuid,
  version: z.number().int().min(0),
  note_id: uuid.nullable(),
  base_revision: z.number().int().min(0),
});
const publishSchema = z.strictObject({
  request_id: uuid,
  draft_id: uuid,
  draft_version: z.number().int().positive(),
  base_revision: z.number().int().min(0),
});
const versionSchema = z.strictObject({ version: z.number().int().positive(), request_id: uuid });
const iso = (value: string) => new Date(value).toISOString();

async function validateScope(ctx: Context, value: NoteContent, write = false) {
  if (!value.customer_id) {
    if (value.project_id || value.person_ids.length || value.blocks.some((b) => b.sources.length))
      throw new ApiError(400, '请先选择公司再关联项目、联系人或来源');
    return;
  }
  activeCustomer(await customer(ctx, value.customer_id, write));
  if (value.project_id) {
    const p = await project(ctx, value.customer_id, value.project_id);
    if (p.archived_at) throw new ApiError(409, '项目已归档');
  }
  for (const id of value.person_ids) {
    const p = await person(ctx, id, value.customer_id);
    if (p.archived_at) throw new ApiError(409, '联系人已归档');
  }
}

/** Server resolves citations; an HTTP origin tag cannot manufacture source evidence. */
async function validateContent(
  ctx: Context,
  value: NoteContent,
  noteId: string | null,
  previous: NoteBlock[] = [],
) {
  const blocks: NoteBlock[] = [];
  const ids = new Set<string>();
  let length = 0;
  for (const input of value.blocks) {
    if (ids.has(input.id)) throw new ApiError(400, '笔记内容块编号重复');
    ids.add(input.id);
    const before =
      previous.find((b) => b.id === input.id && b.origin !== 'original') ||
      previous.find((b) => b.id === input.id);
    const preserved = before && before.origin !== 'original' && input.origin === 'original';
    const b = {
      ...input,
      ...(preserved ? { origin: before.origin, sources: before.sources } : {}),
    };
    length += b.text.length;
    if (length > noteLimits.text) throw new ApiError(413, '笔记正文超过10000字符，请缩短后保存');
    if (b.origin === 'original') {
      if (b.sources.length) throw new ApiError(400, '带来源的内容必须保留引用或整理标记');
      blocks.push({ ...b, sources: [] });
      continue;
    }
    if (!value.customer_id || !b.sources.length)
      throw new ApiError(400, '引用与整理内容需要可核对的原始来源');
    const sources: NoteSourceRef[] = [];
    for (const ref of b.sources) {
      const resolved = await resolveNoteSource(ctx, value.customer_id, ref, {
        ...(value.project_id ? { project_id: value.project_id } : {}),
      });
      if (resolved.note_id && resolved.note_id === noteId)
        throw new ApiError(409, '不能将同一笔记的旧版本再次作为当前版证据');
      if (resolved.source_hash !== ref.source_hash || !resolved.body.includes(ref.quote))
        throw new ApiError(409, '笔记来源已变化，请重新选择来源');
      for (const personId of value.person_ids)
        if (!resolved.person_ids.includes(personId) || resolved.person_scope_complete === false)
          throw new ApiError(400, '来源不属于所选联系人的完整范围，请调整联系人关联或拆分笔记');
      sources.push({
        record_id: resolved.record_id,
        source_id: resolved.source_id,
        source_hash: resolved.source_hash,
        quote: ref.quote,
        title: resolved.title,
      });
    }
    if (
      b.origin === 'quote' &&
      b.text.trim() &&
      !sources.some((s) => s.quote.includes(b.text.trim()))
    )
      throw new ApiError(400, '引述必须与原文摘录一致；改写请使用整理标记');
    blocks.push({ ...b, sources });
  }
  return {
    title: value.title,
    customer_id: value.customer_id,
    project_id: value.project_id,
    person_ids: [...new Set(value.person_ids)],
    blocks,
  };
}

const uniqueSources = (sources: NoteSourceRef[]) => [
  ...new Map(sources.map((s) => [s.record_id, s])).values(),
];
async function validateTitleSources(
  ctx: Context,
  content: NoteContent,
  noteId: string | null,
  sources: NoteSourceRef[],
) {
  const refs = uniqueSources(sources);
  if (refs.length > noteLimits.sources) throw new ApiError(422, '标题及正文来源过多，请减少来源');
  if (!refs.length) return [];
  return (
    await validateContent(
      ctx,
      {
        ...content,
        blocks: [
          {
            id: 'title-dependencies',
            type: 'paragraph',
            text: '',
            origin: 'derived',
            sources: refs,
          },
        ],
      },
      noteId,
    )
  ).blocks[0].sources;
}

type Mutation = {
  kind: string;
  target_id: string;
  payload_hash: string;
  response: Record<string, unknown>;
};
async function replay(
  ctx: Context,
  requestId: string,
  kind: string,
  target: string,
  payload: unknown,
) {
  const prior = (
    await ctx.tx.query<Mutation>(
      'SELECT kind,target_id,payload_hash,response FROM note_mutations WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
      [ctx.workspaceId, ctx.actorId, requestId],
    )
  ).rows[0];
  if (
    prior &&
    (prior.kind !== kind || prior.target_id !== target || prior.payload_hash !== hash(payload))
  )
    throw new ApiError(409, '相同请求编号不能用于不同笔记内容');
  return prior;
}
async function remember(
  ctx: Context,
  requestId: string,
  kind: string,
  target: string,
  payload: unknown,
  response: unknown,
) {
  await ctx.tx.query(
    'INSERT INTO note_mutations(workspace_id,actor_id,request_id,kind,target_id,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      ctx.workspaceId,
      ctx.actorId,
      requestId,
      kind,
      target,
      hash(payload),
      JSON.stringify(response),
    ],
  );
}

export async function noteDraft(ctx: Context, draftId: string): Promise<NoteDraft> {
  const row = (
    await ctx.tx.query<NoteDraft>(
      'SELECT id,note_id,customer_id,project_id,base_revision,version,title,blocks,title_sources,person_ids,created_at,updated_at FROM note_drafts WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, uuid.parse(draftId)],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '草稿不存在或无权访问');
  await validateScope(ctx, row);
  // Recheck dependencies even for the owner's private recovery; stale snapshots do not bypass withdrawal.
  await validateContent(ctx, row, row.note_id);
  await validateTitleSources(ctx, row, row.note_id, row.title_sources || []);
  return { ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at) };
}

export const getNoteDraft = noteDraft;

export async function saveNoteDraft(
  ctx: Context,
  draftId: string,
  input: unknown,
): Promise<NoteDraft> {
  const id = uuid.parse(draftId),
    value = draftSchema.parse(input);
  await validateScope(ctx, value, true);
  const prior = await replay(ctx, value.request_id, 'draft', id, value);
  if (prior) {
    const current = await noteDraft(ctx, id);
    if (current.version !== prior.response.version)
      throw new ApiError(409, '该保存请求已被较新的草稿取代，请核对当前内容');
    return current;
  }
  const existing = (
    await ctx.tx.query<NoteDraft>(
      'SELECT * FROM note_drafts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (existing ? existing.version !== value.version : value.version !== 0)
    throw new ApiError(409, '草稿已变化，请保留当前输入并重新打开');
  if (
    existing &&
    (existing.note_id !== value.note_id ||
      (existing.customer_id && existing.customer_id !== value.customer_id))
  )
    throw new ApiError(409, '切换客户请新建空白草稿');
  let published: NoteDetail | undefined;
  if (value.note_id) {
    published = await noteDetail(ctx, value.note_id);
    if (
      published.customer_id !== value.customer_id ||
      published.version !== value.base_revision ||
      published.archived_at
    )
      throw new ApiError(409, '笔记正式版本已变化，请先核对最新版本');
  } else if (value.base_revision !== 0) throw new ApiError(400, '新笔记不能指定已有版本');
  const content = await validateContent(ctx, value, value.note_id, [
    ...(existing?.blocks || []),
    ...(published?.blocks || []),
  ]);
  const inheritedTitle =
    existing?.title === value.title
      ? existing.title_sources || []
      : published?.title === value.title
        ? published.title_sources || []
        : [];
  const titleSources = await validateTitleSources(ctx, content, value.note_id, [
    ...inheritedTitle,
    ...content.blocks.flatMap((b) => b.sources),
  ]);
  if (existing)
    await ctx.tx.query(
      'UPDATE note_drafts SET title=$3,customer_id=$4,project_id=$5,person_ids=$6,blocks=$7,base_revision=$8,title_sources=$9,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',
      [
        ctx.workspaceId,
        id,
        content.title,
        content.customer_id,
        content.project_id,
        content.person_ids,
        JSON.stringify(content.blocks),
        value.base_revision,
        JSON.stringify(titleSources),
      ],
    );
  else
    await ctx.tx.query(
      'INSERT INTO note_drafts(workspace_id,actor_id,id,note_id,customer_id,project_id,base_revision,title,blocks,person_ids,title_sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        ctx.workspaceId,
        ctx.actorId,
        id,
        value.note_id,
        content.customer_id,
        content.project_id,
        value.base_revision,
        content.title,
        JSON.stringify(content.blocks),
        content.person_ids,
        JSON.stringify(titleSources),
      ],
    );
  const result = await noteDraft(ctx, id);
  await remember(ctx, value.request_id, 'draft', id, value, {
    id: result.id,
    version: result.version,
  });
  return result;
}

export async function deleteNoteDraft(ctx: Context, draftId: string, input: unknown) {
  const { version } = z.strictObject({ version: z.number().int().positive() }).parse(input);
  const d = await noteDraft(ctx, draftId);
  if (d.version !== version) throw new ApiError(409, '草稿已变化，请刷新后重试');
  await ctx.tx.query('DELETE FROM note_drafts WHERE workspace_id=$1 AND id=$2 AND version=$3', [
    ctx.workspaceId,
    draftId,
    version,
  ]);
  return { deleted: true };
}

const detailColumns = `n.id,n.customer_id,c.name AS customer_name,n.version,n.current_revision_id AS revision_id,n.created_by,n.created_at,n.updated_at,n.archived_at,
 nr.title,nr.project_id,p.name AS project_name,nr.content_hash,nr.record_id,nr.blocks,nr.title_sources,nr.version AS revision_version,nr.created_by AS edited_by,
 coalesce(author.display_name,'内部成员') AS created_by_name,coalesce(editor.display_name,'内部成员') AS edited_by_name,
 crm_access(n.workspace_id,n.customer_id,true) AS can_edit`;
const detailFrom = `FROM notes n JOIN note_revisions nr ON nr.workspace_id=n.workspace_id AND nr.id=n.current_revision_id
 JOIN customers c ON c.workspace_id=n.workspace_id AND c.id=n.customer_id
 LEFT JOIN projects p ON p.workspace_id=nr.workspace_id AND p.id=nr.project_id
 LEFT JOIN workspace_people author ON author.workspace_id=n.workspace_id AND author.actor_id=n.created_by
 LEFT JOIN workspace_people editor ON editor.workspace_id=nr.workspace_id AND editor.actor_id=nr.created_by`;

export async function noteDetail(ctx: Context, noteId: string): Promise<NoteDetail> {
  const r = (
    await ctx.tx.query<
      Omit<NoteDetail, 'people' | 'person_ids' | 'excerpt' | 'sources' | 'knowledge_state'>
    >(`SELECT ${detailColumns} ${detailFrom} WHERE n.workspace_id=$1 AND n.id=$2`, [
      ctx.workspaceId,
      uuid.parse(noteId),
    ])
  ).rows[0];
  if (!r) throw new ApiError(404, '笔记不存在、来源已失效或无权访问');
  const people = (
    await ctx.tx.query<{ id: string; name: string }>(
      'SELECT p.id,p.name FROM note_people np JOIN people p ON p.workspace_id=np.workspace_id AND p.id=np.person_id WHERE np.workspace_id=$1 AND np.revision_id=$2 ORDER BY p.id',
      [ctx.workspaceId, r.revision_id],
    )
  ).rows;
  const states = (
    await ctx.tx.query<{ graph: NoteKnowledgeVersion | null; vector: NoteKnowledgeVersion | null }>(
      `SELECT CASE WHEN k.customer_id IS NULL THEN NULL ELSE jsonb_build_object('state',k.state,'requested_version',k.requested_version,'applied_version',k.applied_version,'generation',k.generation,'digest',k.digest,'schema_revision',k.schema_revision) END AS graph,
       CASE WHEN s.customer_id IS NULL THEN NULL ELSE jsonb_build_object('state',s.state,'requested_version',s.requested_version,'applied_version',s.applied_version,'digest',s.digest,'model_revision',s.model_revision) END AS vector
       FROM customers c LEFT JOIN knowledge_sync k ON k.workspace_id=c.workspace_id AND k.customer_id=c.id LEFT JOIN source_index_sync s ON s.workspace_id=c.workspace_id AND s.customer_id=c.id WHERE c.workspace_id=$1 AND c.id=$2`,
      [ctx.workspaceId, r.customer_id],
    )
  ).rows[0];
  const sources = [
    ...new Map(
      [...r.blocks.flatMap((b) => b.sources), ...(r.title_sources || [])].map((s) => [
        s.record_id,
        s,
      ]),
    ).values(),
  ];
  return {
    ...r,
    people,
    person_ids: people.map((p) => p.id),
    excerpt: r.blocks
      .map((b) => b.text)
      .join('\n')
      .slice(0, 180),
    sources,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    archived_at: r.archived_at ? iso(r.archived_at) : null,
    knowledge_versions: { graph: states?.graph || null, vector: states?.vector || null },
    knowledge_state: r.archived_at
      ? 'unavailable'
      : !r.record_id
        ? 'not_required'
        : states?.graph?.state === 'failed' || states?.vector?.state === 'failed'
          ? 'failed'
          : states?.graph?.state === 'ready' &&
              states?.vector?.state === 'ready' &&
              states.graph.requested_version === states.graph.applied_version &&
              states.vector.requested_version === states.vector.applied_version
            ? 'ready'
            : 'pending',
  };
}

export const getNote = noteDetail;

export async function listNotes(ctx: Context, input: unknown): Promise<NoteListResponse> {
  const q = z
    .object({
      view: z.enum(['all', 'drafts']).default('all'),
      customer_id: uuid.optional(),
      project_id: uuid.optional(),
      person_id: uuid.optional(),
      author_id: uuid.optional(),
      updated_from: z.iso.date().optional(),
      updated_to: z.iso.date().optional(),
      search: z.string().max(250).default(''),
      archived: z.enum(['true', 'false']).default('false'),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    })
    .parse(input);
  if (q.updated_from && q.updated_to && q.updated_from > q.updated_to)
    throw new ApiError(400, '更新时间范围无效');
  if ((q.project_id || q.person_id) && !q.customer_id)
    throw new ApiError(400, '项目或联系人查询需要明确公司');
  if (q.customer_id)
    await validateScope(ctx, {
      title: '',
      blocks: [],
      customer_id: q.customer_id,
      project_id: q.project_id || null,
      person_ids: q.person_id ? [q.person_id] : [],
    });
  if (q.view === 'drafts') {
    const all = (
      await ctx.tx.query<{ id: string }>(
        `SELECT id FROM note_drafts WHERE workspace_id=$1 AND ($2::uuid IS NULL OR customer_id=$2) AND ($3::uuid IS NULL OR project_id=$3) AND ($4::uuid IS NULL OR $4=ANY(person_ids))
         AND ($5='' OR position(lower($5) in lower(title||' '||coalesce((SELECT string_agg(b->>'text',' ') FROM jsonb_array_elements(blocks)b),'')))>0)
         AND ($6::uuid IS NULL OR actor_id=$6)
         AND ($7::date IS NULL OR updated_at >= ($7::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
         AND ($8::date IS NULL OR updated_at < (($8::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) ORDER BY updated_at DESC,id`,
        [
          ctx.workspaceId,
          q.customer_id || null,
          q.project_id || null,
          q.person_id || null,
          q.search,
          q.author_id || null,
          q.updated_from || null,
          q.updated_to || null,
        ],
      )
    ).rows;
    const visible: NoteDraft[] = [];
    for (const row of all)
      try {
        visible.push(await noteDraft(ctx, row.id));
      } catch (error) {
        if (!(error instanceof ApiError && [404, 409].includes(error.status))) throw error;
      }
    return {
      notes: [],
      drafts: visible.slice(q.offset, q.offset + q.limit),
      total: visible.length,
      offset: q.offset,
      limit: q.limit,
      has_more: visible.length > q.offset + q.limit,
    };
  }
  const ids = (
    await ctx.tx.query<{ id: string }>(
      `SELECT n.id ${detailFrom} WHERE n.workspace_id=$1 AND ($2::uuid IS NULL OR n.customer_id=$2) AND ($3::uuid IS NULL OR nr.project_id=$3) AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM note_people np WHERE np.workspace_id=n.workspace_id AND np.revision_id=nr.id AND np.person_id=$4)) AND (n.archived_at IS NOT NULL)=$5
       AND ($6='' OR position(lower($6) in lower(nr.title||' '||coalesce((SELECT string_agg(b->>'text',' ') FROM jsonb_array_elements(nr.blocks)b),'')))>0)
       AND ($7::uuid IS NULL OR n.created_by=$7)
       AND ($8::date IS NULL OR n.updated_at >= ($8::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
       AND ($9::date IS NULL OR n.updated_at < (($9::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) ORDER BY n.updated_at DESC,n.id`,
      [
        ctx.workspaceId,
        q.customer_id || null,
        q.project_id || null,
        q.person_id || null,
        q.archived === 'true',
        q.search,
        q.author_id || null,
        q.updated_from || null,
        q.updated_to || null,
      ],
    )
  ).rows;
  const notes = [];
  for (const row of ids.slice(q.offset, q.offset + q.limit)) {
    const { blocks: _b, sources: _s, ...summary } = await noteDetail(ctx, row.id);
    notes.push(summary);
  }
  return {
    notes,
    drafts: [],
    total: ids.length,
    offset: q.offset,
    limit: q.limit,
    has_more: ids.length > q.offset + q.limit,
  };
}

export async function publishNote(ctx: Context, input: unknown): Promise<NoteDetail> {
  const value = publishSchema.parse(input);
  const prior = await replay(ctx, value.request_id, 'publish', value.draft_id, value);
  if (prior) {
    const current = await noteDetail(ctx, String(prior.response.id));
    if (current.version !== prior.response.version)
      throw new ApiError(409, '该发布请求对应旧版本，请核对当前笔记');
    return current;
  }
  const d = await noteDraft(ctx, value.draft_id);
  if (d.version !== value.draft_version || d.base_revision !== value.base_revision)
    throw new ApiError(409, '草稿或基准版本已变化，请核对后保存');
  if (!d.customer_id || !d.title.trim() || !d.blocks.some((b) => b.text.trim()))
    throw new ApiError(400, '正式保存需要选择公司并填写标题和正文');
  await validateScope(ctx, d, true);
  const published = d.note_id ? await noteDetail(ctx, d.note_id) : undefined;
  const content = await validateContent(ctx, d, d.note_id, published?.blocks);
  const titleSources = await validateTitleSources(ctx, content, d.note_id, d.title_sources || []);
  const noteId = d.note_id || randomUUID();
  let revisionNumber = 1;
  if (d.note_id) {
    const n = (
      await ctx.tx.query<{
        version: number;
        revision_version: number;
        archived_at: string | null;
        customer_id: string;
      }>(
        'SELECT n.version,n.archived_at,n.customer_id,nr.version AS revision_version FROM notes n JOIN note_revisions nr ON nr.workspace_id=n.workspace_id AND nr.id=n.current_revision_id WHERE n.workspace_id=$1 AND n.id=$2 FOR UPDATE OF n',
        [ctx.workspaceId, noteId],
      )
    ).rows[0];
    if (!n || n.version !== value.base_revision || n.archived_at || n.customer_id !== d.customer_id)
      throw new ApiError(409, '笔记已由其他人修改，请保留本次编辑并比较最新版本');
    revisionNumber = n.revision_version + 1;
  } else
    await ctx.tx.query(
      'INSERT INTO notes(workspace_id,id,customer_id,created_by) VALUES($1,$2,$3,$4)',
      [ctx.workspaceId, noteId, d.customer_id, ctx.actorId],
    );
  const revisionId = randomUUID(),
    next = value.base_revision + 1;
  const original = content.blocks
    .filter((b) => b.origin === 'original')
    .map((b) => b.text)
    .filter((s) => s.trim())
    .join('\n\n');
  const recordId = original ? randomUUID() : null;
  if (recordId)
    await ctx.tx.query(
      "INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind) VALUES($1,$2,$3,$4,'inference',$5,$6,'note')",
      [ctx.workspaceId, d.customer_id, d.project_id, recordId, original, ctx.actorId],
    );
  await ctx.tx.query(
    'INSERT INTO note_revisions(workspace_id,customer_id,note_id,id,version,title,project_id,blocks,content_hash,record_id,created_by,title_sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      ctx.workspaceId,
      d.customer_id,
      noteId,
      revisionId,
      revisionNumber,
      content.title.trim(),
      content.project_id,
      JSON.stringify(content.blocks),
      hash({ ...content, title: content.title.trim(), title_sources: titleSources }),
      recordId,
      ctx.actorId,
      JSON.stringify(titleSources),
    ],
  );
  for (const id of content.person_ids)
    await ctx.tx.query(
      'INSERT INTO note_people(workspace_id,customer_id,revision_id,person_id) VALUES($1,$2,$3,$4)',
      [ctx.workspaceId, d.customer_id, revisionId, id],
    );
  const refs = [
    ...new Map(
      [...content.blocks.flatMap((b) => b.sources), ...titleSources].map((s) => [s.record_id, s]),
    ).values(),
  ];
  if (refs.length > noteLimits.sources) throw new ApiError(422, '本篇笔记引用来源过多，请减少来源');
  for (const ref of refs)
    await ctx.tx.query(
      'INSERT INTO note_source_refs(workspace_id,customer_id,revision_id,record_id,source_hash) VALUES($1,$2,$3,$4,$5)',
      [ctx.workspaceId, d.customer_id, revisionId, ref.record_id, ref.source_hash],
    );
  await ctx.tx.query(
    'UPDATE notes SET current_revision_id=$3,version=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId, noteId, revisionId, next],
  );
  const result = await noteDetail(ctx, noteId);
  await ctx.tx.query('DELETE FROM note_drafts WHERE workspace_id=$1 AND id=$2 AND version=$3', [
    ctx.workspaceId,
    d.id,
    d.version,
  ]);
  await remember(ctx, value.request_id, 'publish', d.id, value, {
    id: result.id,
    version: result.version,
  });
  return result;
}

export async function archiveNote(
  ctx: Context,
  noteId: string,
  input: unknown,
  archived = true,
): Promise<NoteDetail> {
  const value = versionSchema.parse(input),
    id = uuid.parse(noteId),
    kind = archived ? 'archive' : 'restore';
  const current = await noteDetail(ctx, id);
  await customer(ctx, current.customer_id, true);
  const prior = await replay(ctx, value.request_id, kind, id, value);
  if (prior) {
    if (current.version !== prior.response.version)
      throw new ApiError(409, '该操作已被较新的笔记版本取代');
    return current;
  }
  if (current.version !== value.version) throw new ApiError(409, '笔记已变化，请刷新后重试');
  const updated = (
    await ctx.tx.query(
      'UPDATE notes SET archived_at=$3,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$4 RETURNING id',
      [ctx.workspaceId, id, archived ? new Date().toISOString() : null, value.version],
    )
  ).rows[0];
  if (!updated) throw new ApiError(409, '笔记已变化，请刷新后重试');
  const result = await noteDetail(ctx, id);
  await remember(ctx, value.request_id, kind, id, value, { id, version: result.version });
  return result;
}

export async function listNoteTemplates(ctx: Context): Promise<{ templates: NoteTemplate[] }> {
  return {
    templates: (
      await ctx.tx.query<NoteTemplate>(
        'SELECT id,name,blocks,created_at FROM note_templates WHERE workspace_id=$1 ORDER BY created_at DESC,id',
        [ctx.workspaceId],
      )
    ).rows.map((r) => ({ ...r, created_at: iso(r.created_at) })),
  };
}

export async function noteVersions(ctx: Context, noteId: string) {
  await noteDetail(ctx, noteId);
  const revisions = (
    await ctx.tx.query<{
      revision_id: string;
      version: number;
      content_hash: string;
      edited_by: string;
      created_at: string;
      current: boolean;
    }>('SELECT * FROM crm_note_versions($1,$2)', [ctx.workspaceId, noteId])
  ).rows;
  return { revisions: revisions.map((r) => ({ ...r, created_at: iso(r.created_at) })) };
}
export async function createNoteTemplate(ctx: Context, input: unknown): Promise<NoteTemplate> {
  const value = z
    .strictObject({
      name: z.string().trim().min(1).max(100),
      blocks: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(100),
            type: z.enum(['paragraph', 'heading', 'bullet', 'numbered', 'quote']),
            text: z.string().max(noteLimits.text),
          }),
        )
        .max(noteLimits.blocks),
    })
    .parse(input);
  if (value.blocks.reduce((sum, b) => sum + b.text.length, 0) > noteLimits.text)
    throw new ApiError(413, '模板正文过长');
  const id = randomUUID();
  const r = (
    await ctx.tx.query<NoteTemplate>(
      'INSERT INTO note_templates(workspace_id,actor_id,id,name,blocks) VALUES($1,$2,$3,$4,$5) RETURNING id,name,blocks,created_at',
      [ctx.workspaceId, ctx.actorId, id, value.name, JSON.stringify(value.blocks)],
    )
  ).rows[0];
  return { ...r, created_at: iso(r.created_at) };
}
