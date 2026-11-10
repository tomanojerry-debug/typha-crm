import type { AgentSource } from '../shared/agent.js';

/** Preserve whole correction evidence groups, even when a single Record is large. */
export function budgetAgentSources(
  input: AgentSource[],
  atomicRecordGroups: string[][] = [],
  limit = 100000,
) {
  const unique = new Map<string, AgentSource>();
  for (const source of input) if (!unique.has(source.id)) unique.set(source.id, source);
  const units = new Map<string, Set<string>>();
  for (const records of atomicRecordGroups) {
    const ids = new Set(records.map((id) => `record::${id}`));
    for (const id of [...ids]) {
      for (const other of units.get(id) || []) ids.add(other);
    }
    for (const id of ids) units.set(id, ids);
  }
  const handled = new Set<string>(),
    sources: AgentSource[] = [],
    warnings: string[] = [];
  let bytes = 0;
  for (const source of unique.values()) {
    if (handled.has(source.id)) continue;
    const ids = units.get(source.id) || new Set([source.id]);
    const group = [...unique.values()].filter((item) => ids.has(item.id));
    ids.forEach((id) => handled.add(id));
    const size = group.reduce((n, s) => n + Buffer.byteLength(JSON.stringify(s)), 0);
    if (bytes + size > limit || (units.has(source.id) && group.length !== ids.size)) {
      warnings.push(
        units.has(source.id)
          ? '部分检索命中及其纠正历史因上下文容量或来源不完整被整组省略，不能据此裁定唯一有效说法或推断不存在。'
          : '上下文达到容量上限，部分来源未纳入；不能作全量结论。',
      );
      continue;
    }
    sources.push(...group);
    bytes += size;
  }
  return { sources, warnings: [...new Set(warnings)] };
}
