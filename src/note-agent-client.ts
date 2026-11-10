import type { NoteDraft } from '../shared/notes';
import type { AskSource } from '../shared/ask';
import { api } from './api';

export interface AgentNoteDraftResponse {
  draft: NoteDraft;
  regenerated: true;
  replayed?: boolean;
}

export function canOrganizeAnswerAsNote(sources: AskSource[] | undefined) {
  return Boolean(sources?.some((source) => source.kind === 'record' || source.kind === 'mail'));
}

/** Send only the identity of a persisted answer. Its text and scope are read on the server. */
export function organizeAnswerAsNote(
  workspace: string,
  input: {
    request_id: string;
    chat_id: string;
    message_id?: string;
    message_request_id?: string;
  },
  signal?: AbortSignal,
) {
  return api<AgentNoteDraftResponse>('/notes/from-answer', {
    workspace,
    method: 'POST',
    body: input,
    signal,
  });
}

export function openAgentNoteDraft(workspaceId: string, draft: NoteDraft, actorId: string) {
  window.dispatchEvent(
    new CustomEvent('crm:open-note', {
      detail: {
        workspaceId,
        actorId,
        draftId: draft.id,
        ...(draft.customer_id ? { customerId: draft.customer_id } : {}),
        ...(draft.project_id ? { projectId: draft.project_id } : {}),
        ...(draft.person_ids.length === 1 ? { personId: draft.person_ids[0] } : {}),
      },
    }),
  );
}
