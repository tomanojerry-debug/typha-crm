export const prospectChangedEvent = 'crm:prospects-changed';
export const prospectOpenEvent = 'crm:prospect-open';

export function prospectsChanged(workspace: string) {
  window.dispatchEvent(new CustomEvent(prospectChangedEvent, { detail: { workspace } }));
}

export function openProspect(workspace: string, id: string) {
  window.dispatchEvent(new CustomEvent(prospectOpenEvent, { detail: { workspace, id } }));
}
