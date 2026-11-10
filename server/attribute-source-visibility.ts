import type { AttributeSource } from '../shared/attributes.js';
import type { KnowledgeSource } from '../shared/knowledge.js';
import { ApiError, type Context } from './security.js';
import { sourceMaterials } from './source-index.js';

type CurrentSources = { materials: KnowledgeSource[]; profiles: Map<string, AttributeSource> };
const transactionCache = new WeakMap<Context, Map<string, Promise<CurrentSources>>>();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function currentSources(ctx: Context, customerId: string, materials?: KnowledgeSource[]) {
  let cache = transactionCache.get(ctx);
  if (!cache) {
    cache = new Map();
    transactionCache.set(ctx, cache);
  }
  if (!materials && cache.has(customerId)) return cache.get(customerId)!;
  const pending = (async (): Promise<CurrentSources> => {
    const current = materials || (await sourceMaterials(ctx, customerId));
    const profiles = new Map<string, AttributeSource>();
    const specs = [
      {
        kind: 'company',
        table: 'customers',
        columns: 'name,type,status,region,contact_name,email,phone',
        where: 'id=$2',
      },
      {
        kind: 'person',
        table: 'people',
        columns: 'id,name,job_title,email,phone,description',
        where: 'customer_id=$2',
      },
      {
        kind: 'project',
        table: 'projects',
        columns: "id,name,type,stage,description,to_char(due_date,'YYYY-MM-DD') AS due_date",
        where: 'customer_id=$2',
      },
    ] as const;
    for (const spec of specs) {
      const rows = (
        await ctx.tx.query<Record<string, unknown>>(
          `SELECT ${spec.columns} FROM ${spec.table} WHERE workspace_id=$1 AND ${spec.where} AND archived_at IS NULL`,
          [ctx.workspaceId, customerId],
        )
      ).rows;
      for (const row of rows) {
        const id = `${spec.kind}:${spec.kind === 'company' ? customerId : row.id}`;
        const { id: _id, ...value } = row;
        profiles.set(id, {
          id,
          kind: spec.kind,
          title: String(row.name),
          body: JSON.stringify(value),
        });
      }
    }
    const attributes = (
      await ctx.tx.query<{ attribute_id: string; name: string; value: unknown }>(
        `SELECT v.attribute_id,a.name,v.value FROM customer_attribute_values v JOIN customer_attributes a ON a.workspace_id=v.workspace_id AND a.id=v.attribute_id
      WHERE v.workspace_id=$1 AND v.customer_id=$2 AND v.origin='manual' AND NOT a.archived AND v.value<>'null'::jsonb`,
        [ctx.workspaceId, customerId],
      )
    ).rows;
    for (const attribute of attributes) {
      const id = `attribute:${attribute.attribute_id}`;
      profiles.set(id, {
        id,
        kind: 'attribute',
        title: attribute.name,
        body: JSON.stringify({ value: attribute.value }),
      });
    }
    return { materials: current, profiles };
  })();
  if (!materials) cache.set(customerId, pending);
  return pending;
}

function values(body: string): string[] {
  const result: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      result.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(body));
  } catch {
    /* Stored profile bodies are JSON; malformed data gives no evidence. */
  }
  return result;
}

/** Re-read live authorized originals instead of returning stale AI source snapshots. */
export async function sanitizeAttributeSources(
  ctx: Context,
  customerId: string,
  sources: AttributeSource[],
  materials?: KnowledgeSource[],
): Promise<{ sources: AttributeSource[]; invalid: boolean }> {
  if (!sources.length) return { sources: [], invalid: false };
  let current: CurrentSources;
  try {
    current = await currentSources(ctx, customerId, materials);
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 409, 422].includes(error.status))
      return { sources: [], invalid: true };
    throw error;
  }
  const originals = new Map<string, KnowledgeSource[]>();
  for (const material of current.materials) {
    const id = `record:${material.record_id}`;
    originals.set(id, [...(originals.get(id) || []), material]);
  }
  const visible: AttributeSource[] = [];
  let invalid = false;
  for (const source of sources) {
    const [kind, id, extra] = source.id.split(':');
    const quotes =
      source.quote
        ?.split('\n')
        .map((quote) => quote.trim())
        .filter(Boolean) || [];
    if (extra || kind !== source.kind || !idPattern.test(id || '') || !quotes.length) {
      invalid = true;
      continue;
    }
    if (source.kind === 'record') {
      const matched = originals.get(source.id);
      if (
        !matched ||
        quotes.some((quote) => !matched.some((material) => material.body.includes(quote)))
      ) {
        invalid = true;
        continue;
      }
      visible.push({
        id: source.id,
        kind: 'record',
        title: matched[0].title,
        quote: source.quote,
        body: JSON.stringify({
          originals: matched.map((material) => ({
            channel: material.channel,
            speaker: material.speaker,
            trust: material.trust,
            occurred_at: material.occurred_at,
            body: material.body,
          })),
        }),
      });
    } else {
      const profile = current.profiles.get(source.id);
      if (
        !profile ||
        quotes.some((quote) => !values(profile.body).some((value) => value.includes(quote)))
      ) {
        invalid = true;
        continue;
      }
      visible.push({ ...profile, quote: source.quote });
    }
  }
  return { sources: visible, invalid };
}
