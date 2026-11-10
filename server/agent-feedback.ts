import { z } from 'zod';
import { ApiError } from './security.js';
import {
  agentFeedbackPolicyVersion,
  agentFeedbackReasons,
  agentFeedbackBlockReasons,
  type AgentFeedbackReason,
  type AgentFeedbackEvent,
  type AgentFeedbackTelemetry,
} from '../shared/agent-feedback.js';

/** Constructed by the native provider adapter, never deserialized from HTTP/model JSON. */
export class AgentProviderFailure extends ApiError {
  constructor(
    readonly reason:
      | 'transient_provider'
      | 'transient_network'
      | 'provider_auth'
      | 'provider_quota'
      | 'invalid_response',
    status: number,
    message: string,
  ) {
    super(status, message);
  }
}

export function agentFeedbackReason(error: unknown): AgentFeedbackReason {
  if (error instanceof AgentProviderFailure) return error.reason;
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (error instanceof ApiError) {
    if ('code' in error && error.code === 'model_call_limit') return 'model_call_limit';
    if ('code' in error && error.code === 'known_token_limit') return 'known_token_limit';
    if (error.status === 401) return 'provider_auth';
    if ([403, 404].includes(error.status)) return 'permission';
    if (error.status === 409) return 'scope_changed';
    if (error.status === 429) return 'provider_quota';
    if (error.status === 504) return 'deadline';
    // An untyped 502 could be a failed citation, policy, structure or write.
    // Status codes and free-form error messages never establish retry safety.
  }
  return 'unknown';
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const agentFeedbackTelemetrySchema = z.strictObject({
  policy_version: z.literal(agentFeedbackPolicyVersion),
  max_model_retries: z.literal(1),
  retries_reserved: z.number().int().min(0).max(1),
  events: z
    .array(
      z.strictObject({
        sequence: count,
        phase: z.enum(['classify', 'answer']),
        model_call: count,
        reason: z.enum(agentFeedbackReasons),
        action: z.enum(['retry_model', 'stop']),
        outcome: z.enum(['selected', 'recovered', 'failed', 'blocked', 'stopped']),
        retry_number: z.union([z.literal(0), z.literal(1)]),
        block_reason: z.enum(agentFeedbackBlockReasons).nullable(),
      }),
    )
    .max(64),
});

type Ticket = Readonly<Pick<AgentFeedbackEvent, 'phase' | 'model_call' | 'reason'>>;
export interface AgentFeedbackJournal {
  route(input: {
    phase: 'classify' | 'answer';
    modelCall: number;
    reason: AgentFeedbackReason;
    contextBound: boolean;
    hasGuard: boolean;
    visibleOutput: boolean;
  }): { action: 'stop' } | { action: 'retry_model'; ticket: Ticket };
  finish(ticket: Ticket, outcome: 'recovered' | 'failed' | 'blocked'): void;
  snapshot(): AgentFeedbackTelemetry | undefined;
}

/** One journal per Run attempt. A failed domain guard consumes the reservation. */
export function createAgentFeedbackJournal(
  onChange: (event: AgentFeedbackEvent) => void,
): AgentFeedbackJournal {
  const events: AgentFeedbackEvent[] = [];
  const tickets = new WeakSet<Ticket>();
  let reserved = 0;
  function append(event: Omit<AgentFeedbackEvent, 'sequence'>) {
    if (events.length >= 64) return;
    const safe = Object.freeze({ ...event, sequence: events.length + 1 });
    events.push(safe);
    onChange(safe);
  }
  return {
    route(input) {
      const recoverable = ['transient_provider', 'transient_network'].includes(input.reason);
      const blocked = !recoverable
        ? 'non_recoverable'
        : !input.contextBound
          ? 'no_context_plan'
          : !input.hasGuard
            ? 'no_guard'
            : input.visibleOutput
              ? 'visible_output'
              : reserved >= 1
                ? 'retry_limit'
                : null;
      const base = {
        phase: input.phase,
        model_call: input.modelCall,
        reason: input.reason,
      };
      if (blocked) {
        append({
          ...base,
          action: 'stop',
          outcome: 'stopped',
          retry_number: reserved ? 1 : 0,
          block_reason: blocked,
        });
        return { action: 'stop' };
      }
      reserved++;
      const ticket = Object.freeze(base);
      tickets.add(ticket);
      append({
        ...base,
        action: 'retry_model',
        outcome: 'selected',
        retry_number: 1,
        block_reason: null,
      });
      return { action: 'retry_model', ticket };
    },
    finish(ticket, outcome) {
      if (!tickets.has(ticket)) return;
      tickets.delete(ticket);
      append({
        ...ticket,
        action: 'retry_model',
        outcome,
        retry_number: 1,
        block_reason: null,
      });
    },
    snapshot() {
      return events.length
        ? {
            policy_version: agentFeedbackPolicyVersion,
            max_model_retries: 1,
            retries_reserved: reserved,
            events: events.map((event) => ({ ...event })),
          }
        : undefined;
    },
  };
}
