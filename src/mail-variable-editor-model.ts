import type {
  MailInlineNode,
  MailVariableCatalog,
  MailVariableField,
} from '../shared/mail-variables';

export function cloneMailNodes(nodes: MailInlineNode[]): MailInlineNode[] {
  return nodes.map((node) => ({ ...node }));
}

export function searchMailVariableFields(catalog: MailVariableCatalog, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  const rank = (field: MailVariableField) => {
    const label = field.label.toLocaleLowerCase();
    return label === normalized
      ? 0
      : label.startsWith(normalized)
        ? 1
        : label.includes(normalized)
          ? 2
          : 3;
  };
  return catalog.fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => field.path.join(' ').toLocaleLowerCase().includes(normalized))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index)
    .map(({ field }) => field);
}

/** Navigation is display-only; insertion retains the catalog's stable root and field ID. */
export function mailVariableNavigationPath(field: MailVariableField) {
  const path = field.path.slice(0, -1);
  const system = field.field.split(':').at(-1);
  if (field.ai_enabled || !field.field.includes(':')) return [...path, '更多属性', '自定义属性'];
  if (
    (['customer', 'recipient_company'].includes(field.root) &&
      ['type', 'contact_name'].includes(system || '')) ||
    (field.root === 'project' && ['type', 'stage'].includes(system || ''))
  )
    return [...path, '更多属性'];
  return path;
}

export function mailVariableDirectory(catalog: MailVariableCatalog, path: string[]) {
  const groups = new Map<string, string[]>();
  const fields: MailVariableField[] = [];
  for (const field of catalog.fields) {
    const parent = mailVariableNavigationPath(field);
    if (!path.every((part, index) => parent[index] === part)) continue;
    if (parent.length === path.length) fields.push(field);
    else {
      const label = parent[path.length];
      if (!groups.has(label)) groups.set(label, [...path, label]);
    }
  }
  return { groups: [...groups.entries()].map(([label, path]) => ({ label, path })), fields };
}

export function cleanMailPaste(value: string, multiline = true) {
  const normalized = value.replace(/\r\n?/g, '\n');
  return multiline ? normalized : normalized.replace(/\n/g, ' ');
}
