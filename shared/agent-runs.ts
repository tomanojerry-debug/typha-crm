import type { ChatDetail } from './chat.js';
import type { AgentHarnessTrace } from './agent-harness.js';
import type { AgentExecutionTelemetry } from './agent-execution.js';

export interface AgentRun {
  id: string;
  chat_id: string;
  request_id: string;
  kind: 'message' | 'ask' | 'workflow';
  status:
    'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  question: string;
  answer: string;
  revision: number;
  error?: string | null;
  created_at: string;
  updated_at: string;
  harness_trace?: AgentHarnessTrace[];
  execution?: AgentExecutionTelemetry;
}

export interface AgentRunResult {
  run: AgentRun;
  detail: ChatDetail;
}

export type AgentRunEvent =
  | { type: 'run'; run: AgentRun }
  | { type: 'done'; result: AgentRunResult }
  | { type: 'error'; status: number; error: string };

export function activeAgentRun(run: Pick<AgentRun, 'status'>): boolean {
  return ['queued', 'running', 'cancelling'].includes(run.status);
}
