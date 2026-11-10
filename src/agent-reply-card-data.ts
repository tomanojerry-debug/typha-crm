import type { AskSource } from '../shared/ask';
import type { ChatRetrieval } from '../shared/chat-intent';
import type { ChatMessage } from '../shared/chat';

export function agentRecordReplySource(
  message: ChatMessage,
  customerId?: string | null,
): AskSource | undefined {
  if (
    message.role === 'assistant' &&
    message.action === 'overview' &&
    customerId &&
    (!message.classification || message.classification.intent === '查询资料')
  ) {
    return message.sources?.find(
      (source) =>
        source.kind === 'entity' &&
        source.object === 'customers' &&
        source.id === customerId &&
        source.customer_id === customerId,
    );
  }
  const retrieval = message.retrieval;
  if (
    message.role !== 'assistant' ||
    message.classification?.intent !== '查询资料' ||
    (retrieval?.task && retrieval.task.intent !== '查询资料') ||
    retrieval?.status !== 'unique' ||
    retrieval.total !== 1 ||
    retrieval.candidates.length !== 1
  )
    return;
  const source = retrieval.candidates[0];
  return source.kind === 'entity' &&
    ['customers', 'people', 'projects'].includes(source.object || '')
    ? source
    : undefined;
}

export function agentRecordDisplayBody(body: string, source: AskSource): string {
  const labels: Record<string, string[]> = {
    people: ['联系人', '联系人姓名', '姓名', '名称'],
    customers: ['公司', '公司名称', '客户', '客户名称', '名称'],
    projects: ['项目', '项目名称', '名称'],
  };
  const identityLabels = labels[source.object || ''];
  const title = source.title.trim();
  if (source.kind !== 'entity' || !identityLabels || !title) return body;
  let fence: string | undefined;
  return body
    .split(/\r?\n/u)
    .filter((line) => {
      const marker = line.trimStart().match(/^(`{3,}|~{3,})/u)?.[0];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return true;
      }
      if (fence || /^(?: {4}|\t)/u.test(line) || /^\s*`[^`]+`\s*$/u.test(line)) return true;
      // Compare only visible, standalone identity text with the actual header.
      // Never remove a name mention or a confirmation carrying extra details.
      const text = line
        .trim()
        .replace(/^[-*+]\s+/u, '')
        .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
        .replace(/`([^`\n]+)`/gu, '$1');
      const selection = text.match(
        /^已选择第[0-9一二三四五六七八九十]+[个位项家条]候选[：:]\s*(.+)$/u,
      );
      if (selection && (selection[1] === title || selection[1].replace(/[。.!！]$/u, '') === title))
        return false;
      const field = text.match(/^([^：:]+)[：:]\s*(.*)$/u);
      return !(field && identityLabels.includes(field[1].trim()) && field[2].trim() === title);
    })
    .join('\n');
}

export function agentSourceKey(source: AskSource): string {
  return `${source.kind}:${source.object || ''}:${source.id}:${source.customer_id}`;
}

export function uniqueAgentSources(sources: AskSource[], exclude: AskSource[] = []): AskSource[] {
  const seen = new Set(exclude.map(agentSourceKey));
  return sources.filter((source) => {
    const key = agentSourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function agentDirectoryCompany(
  source: AskSource,
  allowLegacyDirectory = false,
): string | undefined {
  if (source.kind !== 'entity' || !['people', 'projects'].includes(source.object || '')) return;
  if (source.company_name !== undefined) return source.company_name;
  if (!allowLegacyDirectory) return;
  // Compatibility with the existing server's fixed directory display contract.
  // This reads an explicitly labeled value, never a name or model answer.
  const type = source.object === 'people' ? '联系人' : '项目';
  const prefix = `候选目录 · ${type} · 所属公司：`;
  return source.description.startsWith(prefix)
    ? source.description.slice(prefix.length)
    : undefined;
}

/** Listed customers are read-only directory results, never candidate choices. */
export function agentListedCustomerItems(retrieval?: ChatRetrieval | null): AskSource[] {
  if (retrieval?.status !== 'listed') return [];
  return uniqueAgentSources(retrieval.items || []).filter(
    (source) =>
      source.kind === 'entity' && source.object === 'customers' && source.id === source.customer_id,
  );
}

export function agentListedCustomerSummary(retrieval: ChatRetrieval): string {
  if (retrieval.status !== 'listed') return '';
  const listing = retrieval.listing;
  const scope =
    listing?.ownership === 'owned_by_me'
      ? '我负责的客户'
      : listing?.ownership === 'accessible'
        ? '当前可访问的客户'
        : '客户列表';
  const shown = agentListedCustomerItems(retrieval).length;
  const page = listing ? `第 ${listing.page} 页 · ` : '';
  return `${scope} · 共 ${retrieval.total} 条 · ${page}当前显示 ${shown} 条${retrieval.truncated && listing ? `；当前仅显示前 ${listing.page_size} 条，可补充名称缩小范围` : ''}`;
}

export function agentReplyCopyText(body: string, retrieval?: ChatRetrieval | null): string {
  if (retrieval?.status === 'listed') {
    const cards = agentListedCustomerItems(retrieval).map((source) => {
      const fields = (source.directory_fields || [])
        .map((field) => `${field.label}：${field.value}`)
        .join('\n');
      return `${source.title}${fields ? `\n${fields}` : ''}`;
    });
    return [body, agentListedCustomerSummary(retrieval), ...cards].filter(Boolean).join('\n\n');
  }
  if (retrieval?.status !== 'candidates') return body;
  const cards = retrieval.candidates.map((source, index) => {
    const name = agentDirectoryCompany(source, true);
    const company = name ? `\n所属公司：${name}` : '';
    const legacyDescription = !company && source.description ? `\n${source.description}` : '';
    const fields = (source.directory_fields || [])
      .map((field) => `${field.label}：${field.value}`)
      .join('\n');
    return `${index + 1}. ${source.title}${company}${legacyDescription}${fields ? `\n${fields}` : ''}`;
  });
  return [body, ...cards].join('\n\n');
}
