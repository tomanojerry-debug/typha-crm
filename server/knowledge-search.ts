import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  KnowledgeSearchRequest,
  KnowledgeEpisodeSearchRequest,
  KnowledgeSearchTransport,
  KnowledgeSelection,
} from '../shared/knowledge-search.js';
import type { KnowledgeGraphEdge } from '../shared/knowledge.js';
import { claimKey } from './communication-pipeline.js';
import {
  knowledgeGraphView,
  knowledgeSnapshot,
  knowledgeSourceDigest,
  knowledgeView,
} from './knowledge.js';
import { ApiError, type Context } from './security.js';

export type KnowledgeSearchFilter = { project_id?: string; person_id?: string };
type Scope = {
  workspace_id: string;
  actor_id: string;
  customer_id: string;
  filter: KnowledgeSearchFilter;
};
type Publication = {
  state: string;
  generation: string | null;
  requested_version: number | null;
  applied_version: number | null;
  schema_revision: string;
  digest: string | null;
  source_digest: string;
};
type Candidate = { id: string; group: string; record_ids: string[] };
export interface KnowledgeSearchPrepared {
  scope: Scope;
  query: string;
  publication: Publication;
  status: 'ready' | 'unavailable';
  warning: string;
  request: KnowledgeSearchRequest | null;
  candidates: Candidate[];
  correction_groups: string[][];
  episode_request?: KnowledgeEpisodeSearchRequest | null;
  episode_candidates?: Candidate[];
}
export interface KnowledgeSearchPlan {
  scope: Scope;
  query: string;
  publication: Publication;
  status: 'ready' | 'unavailable';
  selection: KnowledgeSelection;
}

const responseSchema = z.strictObject({
  protocol: z.literal('graphiti-hybrid-search-v1'),
  strategy: z.literal('graphiti-bm25-cosine-rrf'),
  hits: z
    .array(
      z.strictObject({
        fact_id: z.uuid(),
        group: z.string().regex(/^evidence_[a-f0-9]{32}$/),
        rank: z.number().int().min(1).max(30),
        score: z.number().finite().min(0),
      }),
    )
    .max(30),
  diagnostics: z.strictObject({
    embedding_dimensions: z.literal(384),
    partitions: z.number().int().min(0).max(64),
    keyword_candidates: z.number().int().min(0),
    vector_candidates: z.number().int().min(0),
  }),
});
const episodeResponseSchema = z.strictObject({
  protocol: z.literal('graphiti-episode-search-v1'),
  strategy: z.literal('graphiti-episode-bm25'),
  hits: z
    .array(
      z.strictObject({
        episode_id: z.uuid(),
        group: z.string().regex(/^evidence_[a-f0-9]{32}$/),
        rank: z.number().int().min(1).max(30),
        score: z.number().finite().min(0),
      }),
    )
    .max(30),
  diagnostics: z.strictObject({
    partitions: z.number().int().min(0).max(64),
    keyword_candidates: z.number().int().min(0),
  }),
});
const querySchema = z.string().trim().min(1).max(2000);
const filterSchema = z.strictObject({
  project_id: z.uuid().optional(),
  person_id: z.uuid().optional(),
});
const changed = () => new ApiError(409, '生成期间图谱、资料或可见范围已变化，请重新提问');

function sourceGroup(project: string | null, trust: string) {
  // Python's default JSON separators include this space. Match bridge.py rather
  // than creating a second partition naming scheme.
  return (
    'evidence_' +
    createHash('sha256')
      .update(`[${project ? JSON.stringify(project) : 'null'}, ${JSON.stringify(trust)}]`)
      .digest('hex')
      .slice(0, 32)
  );
}

function components(groups: string[][]) {
  const result: Set<string>[] = [];
  for (const values of groups) {
    const merged = new Set(values);
    for (let index = result.length - 1; index >= 0; index--)
      if ([...result[index]].some((id) => merged.has(id))) {
        result[index].forEach((id) => merged.add(id));
        result.splice(index, 1);
      }
    if (merged.size) result.push(merged);
  }
  return result.map((group) => [...group]);
}

function correctionGroups(edges: KnowledgeGraphEdge[]) {
  return components(
    edges
      .filter((edge) => ['explicit_correction', 'proposed_change'].includes(edge.kind))
      .map((edge) => [
        edge.id,
        edge.source.slice(edge.group.length + 1),
        edge.target.slice(edge.group.length + 1),
      ]),
  );
}

function episodeCandidates(
  sources: Awaited<ReturnType<typeof knowledgeSnapshot>>['sources'],
  filter: KnowledgeSearchFilter,
): Candidate[] {
  const records = new Map<string, typeof sources>();
  for (const source of sources)
    records.set(source.record_id, [...(records.get(source.record_id) || []), source]);
  return [...records].flatMap(([recordId, recordSources]) => {
    // Graphiti stores the complete Record as one Episode. A person/project
    // query must not match text hidden in a different fragment of that Record.
    if (
      recordSources.some(
        (source) =>
          (filter.project_id && source.project_id !== filter.project_id) ||
          (filter.person_id && !source.person_ids.includes(filter.person_id)),
      )
    )
      return [];
    const group = sourceGroup(recordSources[0].project_id, recordSources[0].trust);
    if (recordSources.some((source) => sourceGroup(source.project_id, source.trust) !== group))
      return [];
    return [{ id: claimKey(recordId, 'episode'), group, record_ids: [recordId] }];
  });
}

async function currentPublication(ctx: Context, customerId: string, filter: KnowledgeSearchFilter) {
  // knowledgeView checks customer/project/person ownership, current schema,
  // requested/applied versions and the publication digest under RLS.
  const view = await knowledgeView(ctx, customerId, filter);
  const snapshot = await knowledgeSnapshot(ctx, customerId);
  const row = (
    await ctx.tx.query<{
      generation: string | null;
      requested_version: number;
      applied_version: number;
      schema_revision: string | null;
      digest: string | null;
    }>(
      'SELECT generation,requested_version,applied_version,schema_revision,digest FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
      [ctx.workspaceId, customerId],
    )
  ).rows[0];
  const publication: Publication = {
    state: view.state,
    generation: row?.generation || null,
    requested_version: row ? Number(row.requested_version) : null,
    applied_version: row ? Number(row.applied_version) : null,
    schema_revision: view.schema_revision,
    digest: row?.digest || null,
    source_digest: knowledgeSourceDigest(snapshot),
  };
  return { publication, view, snapshot };
}

export async function prepareKnowledgeSearch(
  ctx: Context,
  customerId: string,
  query: string,
  filter: KnowledgeSearchFilter = {},
): Promise<KnowledgeSearchPrepared> {
  z.uuid().parse(customerId);
  const question = querySchema.parse(query);
  const validatedFilter = filterSchema.parse(filter);
  const { publication, view, snapshot } = await currentPublication(
    ctx,
    customerId,
    validatedFilter,
  );
  const base: KnowledgeSearchPrepared = {
    scope: {
      workspace_id: ctx.workspaceId,
      actor_id: ctx.actorId,
      customer_id: customerId,
      filter: validatedFilter,
    },
    query: question,
    publication,
    status: 'unavailable',
    warning: `本次未执行Graphiti混合检索：图谱状态为${view.state}。仅使用当前获授权原文及档案，不能据此断言历史不存在。`,
    request: null,
    candidates: [],
    correction_groups: [],
    episode_request: null,
    episode_candidates: [],
  };
  if (view.state !== 'ready' || !publication.generation) return base;
  const graph = await knowledgeGraphView(ctx, customerId, {
    ...(validatedFilter.project_id ? { project_id: validatedFilter.project_id } : {}),
  });
  if (graph.provenance !== 'graphiti_persisted' || graph.generation !== publication.generation) {
    base.warning =
      '本次未执行Graphiti混合检索：当前代次没有可检索的持久化图。仅使用授权原文及档案，不能据此断言历史不存在。';
    return base;
  }
  const sourceMap = new Map(snapshot.sources.map((source) => [source.id, source]));
  const edgeMap = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const available = new Map<string, Candidate>(
    view.facts.flatMap((fact) => {
      const edge = edgeMap.get(fact.id);
      const sources = fact.source_ids.map((id) => sourceMap.get(id)!);
      if (
        !edge ||
        edge.kind === 'crm_relationship' ||
        edge.fact !== fact.fact ||
        sources.some((source) => sourceGroup(source.project_id, source.trust) !== edge.group)
      )
        return [];
      return [
        [
          fact.id,
          {
            id: fact.id,
            group: edge.group,
            record_ids: [...new Set(sources.map((source) => source.record_id))],
          },
        ],
      ];
    }),
  );
  const correction_groups = correctionGroups(graph.edges);
  // A scoped person may see one endpoint but not the speaker/evidence at the
  // other endpoint. Exclude that entire chain instead of leaking it or exposing
  // a stale isolated value as the result of a complete graph retrieval.
  for (const group of correction_groups)
    if (group.some((id) => !available.has(id))) group.forEach((id) => available.delete(id));
  const groups = new Map<string, string[]>();
  for (const candidate of available.values())
    groups.set(candidate.group, [...(groups.get(candidate.group) || []), candidate.id]);
  const episodes = episodeCandidates(snapshot.sources, validatedFilter);
  const episodeGroups = new Map<string, string[]>();
  for (const candidate of episodes)
    episodeGroups.set(candidate.group, [
      ...(episodeGroups.get(candidate.group) || []),
      candidate.id,
    ]);
  if (groups.size > 64 || episodeGroups.size > 64)
    throw new ApiError(422, '当前授权范围超过64个检索分区，请指定项目后重新提问');
  return {
    ...base,
    status: 'ready',
    warning: '',
    request: {
      workspace_id: ctx.workspaceId,
      customer_id: customerId,
      generation: publication.generation,
      query: question,
      partitions: [...groups].map(([group, fact_ids]) => ({ group, fact_ids })),
      limit: 30,
    },
    candidates: [...available.values()],
    correction_groups: correction_groups.filter((group) => group.every((id) => available.has(id))),
    episode_request: {
      workspace_id: ctx.workspaceId,
      customer_id: customerId,
      generation: publication.generation,
      query: question,
      partitions: [...episodeGroups].map(([group, episode_ids]) => ({ group, episode_ids })),
      limit: 30,
    },
    episode_candidates: episodes,
  };
}

export async function executeKnowledgeSearch(
  prepared: KnowledgeSearchPrepared,
  transport?: KnowledgeSearchTransport,
): Promise<KnowledgeSearchPlan> {
  const base: KnowledgeSearchPlan = {
    scope: prepared.scope,
    query: prepared.query,
    publication: prepared.publication,
    status: 'unavailable',
    selection: {
      fact_ids: [],
      episode_record_ids: [],
      atomic_record_groups: [],
      warning: prepared.warning,
    },
  };
  if (prepared.status !== 'ready' || !prepared.request) return base;
  if (!transport) {
    base.selection.warning =
      '本次未执行Graphiti混合检索：检索运行器未配置。仅使用授权原文及档案，不能据此断言历史不存在。';
    return base;
  }
  const factRequest = prepared.request.partitions.length ? prepared.request : null;
  const episodeRequest =
    transport.searchEpisodes && prepared.episode_request?.partitions.length
      ? prepared.episode_request
      : null;
  let raw: unknown, episodeRaw: unknown;
  try {
    [raw, episodeRaw] = await Promise.all([
      factRequest ? transport.search(factRequest) : Promise.resolve(null),
      episodeRequest ? transport.searchEpisodes!(episodeRequest) : Promise.resolve(null),
    ]);
  } catch {
    throw new ApiError(503, 'Graphiti检索失败，本次未生成回答，请稍后重试');
  }
  const available = new Map(prepared.candidates.map((candidate) => [candidate.id, candidate]));
  const ids = new Set<string>();
  let factHits = 0,
    episodeHits = 0;
  if (factRequest) {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new ApiError(502, 'Graphiti检索结果格式无效，本次未生成回答');
    const response = parsed.data;
    if (
      response.hits.length > factRequest.limit ||
      response.diagnostics.partitions !== factRequest.partitions.length ||
      new Set(response.hits.map((hit) => hit.fact_id)).size !== response.hits.length ||
      response.hits.some(
        (hit, index) => hit.rank !== index + 1 || available.get(hit.fact_id)?.group !== hit.group,
      )
    )
      throw new ApiError(502, 'Graphiti检索返回了范围外或无效身份，本次未生成回答');
    factHits = response.hits.length;
    for (const hit of response.hits) {
      const closure = prepared.correction_groups.find((group) => group.includes(hit.fact_id));
      (closure || [hit.fact_id]).forEach((id) => ids.add(id));
    }
  }
  const episodeRecords = new Set<string>();
  if (episodeRequest) {
    const parsed = episodeResponseSchema.safeParse(episodeRaw);
    if (!parsed.success) throw new ApiError(502, 'Graphiti原文检索结果格式无效，本次未生成回答');
    const response = parsed.data;
    const availableEpisodes = new Map(
      (prepared.episode_candidates || []).map((candidate) => [candidate.id, candidate]),
    );
    if (
      response.hits.length > episodeRequest.limit ||
      response.diagnostics.partitions !== episodeRequest.partitions.length ||
      new Set(response.hits.map((hit) => hit.episode_id)).size !== response.hits.length ||
      response.hits.some(
        (hit, index) =>
          hit.rank !== index + 1 || availableEpisodes.get(hit.episode_id)?.group !== hit.group,
      )
    )
      throw new ApiError(502, 'Graphiti原文检索返回了范围外或无效身份，本次未生成回答');
    episodeHits = response.hits.length;
    for (const hit of response.hits)
      availableEpisodes.get(hit.episode_id)!.record_ids.forEach((id) => episodeRecords.add(id));
    // An Episode hit may concern an old value. Keep any visible correction
    // chain connected to that Record, even when fact search did not hit it.
    for (const candidate of available.values()) {
      if (!candidate.record_ids.some((id) => episodeRecords.has(id))) continue;
      const closure = prepared.correction_groups.find((group) => group.includes(candidate.id));
      closure?.forEach((id) => ids.add(id));
    }
  }
  const atomic_record_groups = components(
    [...ids].map((id) => {
      const closure = prepared.correction_groups.find((group) => group.includes(id)) || [id];
      return [...new Set(closure.flatMap((factId) => available.get(factId)!.record_ids))];
    }),
  );
  return {
    ...base,
    status: 'ready',
    selection: {
      fact_ids: [...ids],
      atomic_record_groups,
      episode_record_ids: [...episodeRecords],
      warning: `${factRequest ? `本次按问题执行Graphiti关键词＋向量混合检索，命中${factHits}条相似候选，连同纠正／修改依据共纳入${ids.size}条候选。` : '当前授权范围没有可检索的图事实，本次未运行图事实向量查询。'}${episodeRequest ? `Graphiti Episode原文关键词检索命中${episodeHits}份Record。` : transport.searchEpisodes ? '当前授权范围没有可检索的完整Episode原文。' : 'Graphiti Episode原文检索运行器未配置，本次未执行原文搜索。'}必须核对原文是否支持当前问题；不相关或未证实内容不得回答成已知事实。未命中不代表资料不存在；候选不自动成为公司确认。`,
    },
  };
}

export async function validateKnowledgeSearch(
  ctx: Context,
  plan: KnowledgeSearchPlan,
): Promise<KnowledgeSelection> {
  if (ctx.workspaceId !== plan.scope.workspace_id || ctx.actorId !== plan.scope.actor_id)
    throw changed();
  const { publication, view, snapshot } = await currentPublication(
    ctx,
    plan.scope.customer_id,
    plan.scope.filter,
  ).catch((error: unknown) => {
    if (error instanceof ApiError && [403, 404].includes(error.status)) throw changed();
    throw error;
  });
  if (!isDeepStrictEqual(publication, plan.publication)) throw changed();
  const facts = new Map(view.facts.map((fact) => [fact.id, fact]));
  if (plan.selection.fact_ids.some((id) => !facts.has(id))) throw changed();
  const recordIds = new Set(
    plan.selection.fact_ids.flatMap((id) =>
      facts.get(id)!.sources.map((source) => source.record_id),
    ),
  );
  const visibleEpisodeRecords = new Set(
    episodeCandidates(snapshot.sources, plan.scope.filter).flatMap(
      (candidate) => candidate.record_ids,
    ),
  );
  if (plan.selection.episode_record_ids?.some((id) => !visibleEpisodeRecords.has(id)))
    throw changed();
  plan.selection.episode_record_ids?.forEach((id) => recordIds.add(id));
  if (plan.selection.atomic_record_groups.flat().some((id) => !recordIds.has(id))) throw changed();
  return plan.selection;
}
