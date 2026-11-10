import { z } from 'zod';
import { ApiError } from './security.js';
import type { AgentContextPlanSummary } from '../shared/agent-context-plan.js';
import { agentContextPlanSummarySchema } from './agent-context-plan.js';
import {
  createAgentFeedbackJournal,
  agentFeedbackTelemetrySchema,
  type AgentFeedbackJournal,
} from './agent-feedback.js';
import {
  agentExecutionPolicyVersion,
  type AgentExecutionErrorCode,
  type AgentExecutionLimits,
  type AgentExecutionPhase,
  type AgentExecutionTelemetry,
  type AgentProviderUsage,
} from '../shared/agent-execution.js';

export type { AgentExecutionLimits, AgentExecutionTelemetry, AgentProviderUsage };
export interface AgentModelCallRuntime {
  signal?: AbortSignal;
  onUsage?(usage: AgentProviderUsage): void;
  /** Code-owned fresh domain revalidation, not a deserialized model/HTTP field. */
  beforeRetry?(): Promise<void>;
}
const limitsSchema = z.strictObject({
  maxDurationMs: z.number().int().min(1).max(900_000).default(180_000),
  maxModelCalls: z.number().int().min(1).max(32).default(8),
  maxKnownTokens: z.number().int().min(1).max(10_000_000).optional(),
});
/** Validate immutable server policy before a queue can accept/claim any Run. */
export function agentExecutionLimits(value: AgentExecutionLimits = {}) {
  return Object.freeze(limitsSchema.parse(value));
}
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tokenCount = z.number().int().min(0).max(1_000_000_000);
const usageSchema = z
  .strictObject({ input_tokens: tokenCount.nullable(), output_tokens: tokenCount.nullable() })
  .refine((value) => value.input_tokens !== null || value.output_tokens !== null);
const telemetrySchema = z.strictObject({
  feedback: agentFeedbackTelemetrySchema.optional(),
  context_plans: z.array(agentContextPlanSummarySchema).max(32).optional(),
  policy_version: z.literal(agentExecutionPolicyVersion),
  attempt: count,
  sequence: count,
  started_at: z.iso.datetime(),
  deadline_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  duration_ms: z.number().nonnegative(),
  limits: z.strictObject({
    duration_ms: count,
    model_calls: count,
    known_tokens: count.nullable(),
  }),
  model_calls: z.strictObject({
    started: count,
    returned: count,
    failed: count,
    cancelled: count,
    active: count,
  }),
  phases: z.strictObject({
    classify: z.strictObject({ calls: count, duration_ms: z.number().nonnegative() }),
    answer: z.strictObject({ calls: count, duration_ms: z.number().nonnegative() }),
  }),
  provider_usage: z.strictObject({
    complete: z.boolean(),
    reported_calls: count,
    partial_calls: count,
    unknown_calls: count,
    input_tokens: count.nullable(),
    output_tokens: count.nullable(),
    reported_input_tokens: count,
    reported_output_tokens: count,
    cost_amount: z.null(),
  }),
  error_code: z
    .enum([
      'deadline',
      'model_call_limit',
      'known_token_limit',
      'cancelled',
      'model_error',
      'scope_changed',
    ])
    .nullable(),
  telemetry_failures: count,
});
/** Whitelist before publishing private stored metadata; never spread arbitrary fields. */
export function publicAgentExecution(value: unknown): AgentExecutionTelemetry | undefined {
  const parsed = telemetrySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export class AgentExecutionError extends ApiError {
  constructor(readonly code: 'deadline' | 'model_call_limit' | 'known_token_limit') {
    super(
      code === 'deadline' ? 504 : 429,
      code === 'deadline'
        ? '本次 Agent 运行超过时间限制，请重试'
        : code === 'model_call_limit'
          ? '本次 Agent 运行达到模型调用上限，请调整任务后重试'
          : '本次 Agent 运行达到已知模型 token 上限，请缩小范围后重试',
    );
  }
}
interface Call {
  phase: AgentExecutionPhase;
  started: number;
  ended?: number;
  status: 'active' | 'returned' | 'failed' | 'cancelled';
  usage?: AgentProviderUsage;
}
export interface AgentExecutionContext {
  readonly signal: AbortSignal;
  readonly feedback: AgentFeedbackJournal;
  assertActive(): void;
  run<T>(work: () => Promise<T>): Promise<T>;
  runModel<T>(
    phase: AgentExecutionPhase,
    work: (runtime: AgentModelCallRuntime) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  snapshot(): AgentExecutionTelemetry;
  recordContextPlan(summary: AgentContextPlanSummary): void;
  dispose(): void;
}
/** One server-owned context per persistent Run attempt, including classification. */
export function createAgentExecution(
  options: {
    signal?: AbortSignal;
    limits?: AgentExecutionLimits;
    attempt?: number;
    onUpdate?(telemetry: AgentExecutionTelemetry): Promise<void> | void;
  } = {},
): AgentExecutionContext {
  const limits = agentExecutionLimits(options.limits);
  const attempt = z
    .number()
    .int()
    .min(1)
    .parse(options.attempt ?? 1);
  const started = Date.now(),
    deadline = started + limits.maxDurationMs;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const calls: Call[] = [];
  const contextPlans: AgentContextPlanSummary[] = [];
  let disposed = false,
    ended: number | undefined,
    sequence = 0,
    telemetryFailures = 0;
  let errorCode: AgentExecutionErrorCode | null = null;
  let publishing = Promise.resolve();
  const feedback = createAgentFeedbackJournal((event) => {
    if (
      !signal.aborted &&
      event.action === 'stop' &&
      ['permission', 'scope_changed'].includes(event.reason)
    )
      errorCode = 'scope_changed';
    sequence++;
    publish();
  });
  const reasonCode = () =>
    signal.reason instanceof AgentExecutionError
      ? signal.reason.code
      : signal.reason instanceof ApiError
        ? ('scope_changed' as const)
        : ('cancelled' as const);
  const terminateCalls = () => {
    errorCode = reasonCode();
    for (const call of calls)
      if (call.status === 'active') {
        call.status = errorCode === 'cancelled' ? 'cancelled' : 'failed';
        call.ended = Date.now();
      }
    sequence++;
  };
  signal.addEventListener('abort', terminateCalls, { once: true });
  if (signal.aborted) terminateCalls();
  const timer = setTimeout(
    () => controller.abort(new AgentExecutionError('deadline')),
    limits.maxDurationMs,
  );
  timer.unref();
  function assertActive() {
    if (signal.aborted) throw signal.reason;
    if (disposed) throw new ApiError(409, '本次 Agent 执行已结束');
    if (Date.now() >= deadline) {
      controller.abort(new AgentExecutionError('deadline'));
      throw signal.reason;
    }
  }
  function snapshot(): AgentExecutionTelemetry {
    const reported = calls.filter((call) => !!call.usage);
    const input = reported.reduce((n, call) => n + (call.usage!.input_tokens ?? 0), 0);
    const output = reported.reduce((n, call) => n + (call.usage!.output_tokens ?? 0), 0);
    const inputComplete =
      calls.length > 0 &&
      calls.every(
        (call) =>
          call.status !== 'active' &&
          call.usage?.input_tokens !== null &&
          call.usage?.input_tokens !== undefined,
      );
    const outputComplete =
      calls.length > 0 &&
      calls.every(
        (call) =>
          call.status !== 'active' &&
          call.usage?.output_tokens !== null &&
          call.usage?.output_tokens !== undefined,
      );
    const complete = inputComplete && outputComplete;
    const partial = reported.filter(
      (call) => call.usage!.input_tokens === null || call.usage!.output_tokens === null,
    ).length;
    const phase = (name: AgentExecutionPhase) => ({
      calls: calls.filter((call) => call.phase === name).length,
      duration_ms: calls
        .filter((call) => call.phase === name)
        .reduce(
          (n, call) => n + Math.max(0, (call.ended ?? ended ?? Date.now()) - call.started),
          0,
        ),
    });
    return {
      ...(feedback.snapshot() ? { feedback: feedback.snapshot()! } : {}),
      ...(contextPlans.length ? { context_plans: contextPlans.map((plan) => ({ ...plan })) } : {}),
      policy_version: agentExecutionPolicyVersion,
      attempt,
      sequence,
      started_at: new Date(started).toISOString(),
      deadline_at: new Date(deadline).toISOString(),
      ended_at: ended === undefined ? null : new Date(ended).toISOString(),
      duration_ms: Math.max(0, (ended ?? Date.now()) - started),
      limits: {
        duration_ms: limits.maxDurationMs,
        model_calls: limits.maxModelCalls,
        known_tokens: limits.maxKnownTokens ?? null,
      },
      model_calls: {
        started: calls.length,
        returned: calls.filter((call) => call.status === 'returned').length,
        failed: calls.filter((call) => call.status === 'failed').length,
        cancelled: calls.filter((call) => call.status === 'cancelled').length,
        active: calls.filter((call) => call.status === 'active').length,
      },
      phases: { classify: phase('classify'), answer: phase('answer') },
      provider_usage: {
        complete,
        reported_calls: reported.length - partial,
        partial_calls: partial,
        unknown_calls: calls.length - reported.length,
        input_tokens: inputComplete ? input : null,
        output_tokens: outputComplete ? output : null,
        reported_input_tokens: input,
        reported_output_tokens: output,
        cost_amount: null,
      },
      error_code: errorCode,
      telemetry_failures: telemetryFailures,
    };
  }
  function publish() {
    if (!options.onUpdate || disposed || signal.aborted) return;
    const telemetry = snapshot();
    publishing = publishing
      .then(async () => {
        if (!disposed && !signal.aborted) await options.onUpdate!(telemetry);
      })
      .catch(() => {
        telemetryFailures++;
      });
  }
  function bounded<T>(work: () => Promise<T>, activeSignal = signal): Promise<T> {
    assertActive();
    activeSignal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(activeSignal.reason);
      activeSignal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          assertActive();
          activeSignal.throwIfAborted();
          return work();
        })
        .then(resolve, reject)
        .finally(() => activeSignal.removeEventListener('abort', abort));
    });
  }
  function checkKnownTokens() {
    if (limits.maxKnownTokens === undefined) return;
    const usage = snapshot().provider_usage;
    if (usage.reported_input_tokens + usage.reported_output_tokens > limits.maxKnownTokens) {
      controller.abort(new AgentExecutionError('known_token_limit'));
      throw signal.reason;
    }
  }
  return {
    signal,
    feedback,
    recordContextPlan(summary) {
      assertActive();
      if (contextPlans.length >= limits.maxModelCalls) {
        controller.abort(new AgentExecutionError('model_call_limit'));
        throw signal.reason;
      }
      contextPlans.push(agentContextPlanSummarySchema.parse(summary));
      publish();
    },
    assertActive,
    snapshot,
    run: (work) => bounded(work),
    async runModel(phase, work, additionalSignal) {
      assertActive();
      checkKnownTokens();
      if (calls.length >= limits.maxModelCalls) {
        controller.abort(new AgentExecutionError('model_call_limit'));
        throw signal.reason;
      }
      const call: Call = { phase, started: Date.now(), status: 'active' };
      calls.push(call);
      sequence++;
      publish();
      const activeSignal = additionalSignal ? AbortSignal.any([signal, additionalSignal]) : signal;
      try {
        const result = await bounded(
          () =>
            work({
              signal: activeSignal,
              onUsage(value) {
                // Optional telemetry never throws, masks provider failures, or adopts
                // results from a cancelled/completed/previous attempt.
                if (disposed || activeSignal.aborted || call.status !== 'active') return;
                const usage = usageSchema.safeParse(value);
                if (usage.success) {
                  call.usage = usage.data;
                  sequence++;
                  publish();
                }
              },
            }),
          activeSignal,
        );
        assertActive();
        activeSignal.throwIfAborted();
        checkKnownTokens();
        call.status = 'returned';
        // A recovered model failure is not the Run's final stop code. Its failed
        // call and feedback journal remain available; terminal reasons stay set.
        if (errorCode === 'model_error') errorCode = null;
        return result;
      } catch (error) {
        if (call.status === 'active') {
          call.status = signal.aborted && reasonCode() === 'cancelled' ? 'cancelled' : 'failed';
          errorCode = signal.aborted ? reasonCode() : 'model_error';
        }
        throw error;
      } finally {
        call.ended ??= Date.now();
        sequence++;
        publish();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ended = Date.now();
      clearTimeout(timer);
      signal.removeEventListener('abort', terminateCalls);
      sequence++;
    },
  };
}
