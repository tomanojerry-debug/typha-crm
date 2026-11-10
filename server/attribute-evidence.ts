import { createHash } from 'node:crypto';
import type { AttributeSource } from '../shared/attributes.js';
import type { AgentSource } from '../shared/agent.js';
import type { SourceSearchPlan, SourceSearchPrepared } from '../shared/source-search.js';
import type { AttributeModelOptions } from './attribute-model.js';
import type { Database } from './db.js';
import { scoped, type Context } from './security.js';
import { ApiError } from './security.js';
import { isDeepStrictEqual } from 'node:util';
import {
  prepareKnowledgeSearch,
  executeKnowledgeSearch,
  validateKnowledgeSearch,
  type KnowledgeSearchPrepared,
  type KnowledgeSearchPlan,
  type KnowledgeSearchFilter,
} from './knowledge-search.js';
import { knowledgeAgentSources } from './knowledge.js';
import { budgetAgentSources } from './agent-source-budget.js';
import {
  ensureSourceIndex,
  prepareSourceSearch,
  executeSourceSearch,
  validateSourceSearch,
} from './source-index.js';

export interface AttributeRetrievalPrepared {
  graph: KnowledgeSearchPrepared;
  source: SourceSearchPrepared | null;
  mode?: AttributeModelOptions['retrievalMode'];
}
export interface AttributeRetrievalPlan {
  graph: KnowledgeSearchPlan;
  source: SourceSearchPlan | null;
  mode?: AttributeModelOptions['retrievalMode'];
}

export async function prepareAttributeRetrieval(
  ctx: Context,
  customerId: string,
  query: string,
  filter: KnowledgeSearchFilter = {},
  rawEnabled = true,
): Promise<AttributeRetrievalPrepared> {
  return {
    graph: await prepareKnowledgeSearch(ctx, customerId, query.slice(0, 2000), filter),
    source: rawEnabled
      ? await prepareSourceSearch(ctx, customerId, query.slice(0, 2000), filter)
      : null,
  };
}

export async function executeAttributeRetrieval(
  prepared: AttributeRetrievalPrepared,
  options: AttributeModelOptions,
): Promise<AttributeRetrievalPlan> {
  const [graph, source] = await Promise.all([
    executeKnowledgeSearch(prepared.graph, options.knowledgeSearch),
    prepared.source
      ? executeSourceSearch(prepared.source, options.embeddings)
      : Promise.resolve(null),
  ]);
  return { graph, source, ...(prepared.mode ? { mode: prepared.mode } : {}) };
}

export async function buildAttributeRetrieval(
  db: Database,
  actorId: string,
  workspaceId: string,
  customerId: string,
  query: string,
  options: AttributeModelOptions,
  filter: KnowledgeSearchFilter = {},
) {
  const rawEnabled = options.retrievalMode !== 'graphiti' && !!options.embeddings;
  if (rawEnabled) await ensureSourceIndex(db, actorId, workspaceId, customerId, options.embeddings);
  const prepared = await scoped(db, actorId, workspaceId, (ctx) =>
    prepareAttributeRetrieval(ctx, customerId, query, filter, rawEnabled),
  );
  return executeAttributeRetrieval(
    { ...prepared, mode: options.retrievalMode || 'graphiti+raw' },
    options,
  );
}

const bodyValue = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

/** Merge both indexes into one source per authoritative Record before budgeting. */
export async function attributeRetrievedSources(ctx: Context, plan: AttributeRetrievalPlan) {
  if (plan.source && !isDeepStrictEqual(plan.graph.scope, plan.source.scope))
    throw new ApiError(409, '原文与图谱检索范围不一致，请重新整理');
  const selection = await validateKnowledgeSearch(ctx, plan.graph);
  const raw = plan.source ? await validateSourceSearch(ctx, plan.source) : null;
  const graph = await knowledgeAgentSources(
    ctx,
    plan.graph.scope.customer_id,
    plan.graph.scope.filter,
    selection,
  );
  const merged = new Map<string, AgentSource>();
  for (const source of raw?.sources || []) merged.set(source.id, source);
  for (const source of graph) {
    const prior = merged.get(source.id);
    if (prior)
      merged.set(source.id, {
        ...prior,
        body: JSON.stringify({
          original_chunks: bodyValue(prior.body),
          communication: bodyValue(source.body),
          notice: '同一 Record 的原文切片与派生图知识，只是一份证据。原话与公司确认分别判断。',
        }),
      });
    else merged.set(source.id, source);
  }
  const budget = budgetAgentSources([...merged.values()], selection.atomic_record_groups, 90000);
  const warnings = [
    ...(raw?.warnings || [
      plan.mode === 'graphiti'
        ? '本次使用 Graphiti 图事实与可用 Episode 原文搜索，未启用独立原文向量检索；未命中不代表全部历史没有相关信息。'
        : '本次原文向量索引未配置，只查询当前授权近期原文与可用图谱；不能断言全部历史没有相关信息。',
    ]),
    selection.warning,
    ...budget.warnings,
  ].filter(Boolean);
  const sources: AttributeSource[] = [];
  for (const source of budget.sources) {
    if (source.ref?.kind === 'record')
      sources.push({
        id: `record:${source.ref.id}`,
        kind: 'record',
        title: source.title,
        body: source.body,
      });
    else if (source.id === 'knowledge:status') warnings.push(source.body);
  }
  return {
    sources,
    warnings: [...new Set(warnings)],
    digest: createHash('sha256')
      .update(
        JSON.stringify({
          sources,
          warnings,
          raw: raw?.digest,
          graph: Object.entries(plan.graph.publication).sort(([a], [b]) => a.localeCompare(b)),
        }),
      )
      .digest('hex'),
  };
}
