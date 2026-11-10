/** Task inputs, never CRM facts, identity bindings, preferences or send approvals. */
export const taskSlotNames = [
  'language',
  'style',
  'writing_requirements',
  'template_choice',
] as const;
export type TaskSlotName = (typeof taskSlotNames)[number];
export type TaskTurnAction = 'start' | 'continue' | 'modify' | 'cancel' | 'clarify';
export interface TaskSlotUpdate {
  slot: TaskSlotName;
  op: 'set' | 'clear';
  value: string | null;
  evidence: string;
}
export interface TaskSlot extends TaskSlotUpdate {
  request_id: string;
}
export interface TaskUnderstanding {
  turn_action?: TaskTurnAction;
  turn_evidence?: string;
  slot_updates?: TaskSlotUpdate[];
}
export interface ClassificationDiagnostics {
  contract_version: 'task-slots-v1';
  duration_ms: number;
}
