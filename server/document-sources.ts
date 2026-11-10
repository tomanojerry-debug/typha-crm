import type { KnowledgeSource } from '../shared/knowledge.js';
import type { DocumentSection } from '../shared/documents.js';
import type { Context } from './security.js';

/** Read the original authorized text, never a model summary. One document is one Record. */
export async function documentKnowledgeSources(
  ctx: Context,
  customerId: string,
): Promise<KnowledgeSource[]> {
  const rows = (
    await ctx.tx.query<{
      id: string;
      name: string;
      record_id: string;
      project_id: string | null;
      sections: DocumentSection[];
      created_at: string;
    }>(
      `SELECT d.id,d.name,d.record_id,d.project_id,d.sections,d.created_at FROM documents d
    WHERE d.workspace_id=$1 AND d.customer_id=$2 AND d.status='ready' AND d.record_id IS NOT NULL ORDER BY d.created_at,d.id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  return rows.map((d) => ({
    id: `record:${d.record_id}`,
    record_id: d.record_id,
    channel: 'record',
    trust: 'customer_quote',
    project_id: d.project_id,
    person_ids: [],
    occurred_at: new Date(d.created_at).toISOString(),
    title: d.name,
    speaker: '对方提供的文档；陈述主体以原文为准',
    speaker_side: 'external',
    body: d.sections.map((s) => `【${s.label}】\n${s.text}`).join('\n\n'),
    ref: {
      kind: 'record',
      id: d.record_id,
      customer_id: customerId,
      ...(d.project_id ? { project_id: d.project_id } : {}),
      title: d.name,
      description: '文档提取原文；不代表本公司确认',
    },
  }));
}
