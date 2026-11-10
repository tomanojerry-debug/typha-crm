/** Explicit domain-only time baselines. Never changes Date, timers, sessions or database clocks. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const evaluationClockPolicySchema = z.strictObject({
  version: z.literal('light-crm-evaluation-clock-v1'),
  mode: z.literal('fixed_outgoing_clock'),
  reference_time: z.iso.datetime({ offset: true }),
  timezone: z.literal('Asia/Shanghai'),
  // First policy version supports only the independently authenticated fake-send path.
  case_ids: z.array(z.literal('MAIL-010')).min(1).max(1),
});
export type EvaluationClockPolicy = z.infer<typeof evaluationClockPolicySchema>;
export interface EvaluationClockMetadata {
  version: 'light-crm-evaluation-clock-v1';
  mode: 'fixed_outgoing_clock' | 'native_wall_clock';
  case_id: string | null;
  reference_time: string | null;
  timezone: 'Asia/Shanghai';
  policy_sha256: string | null;
  scope: {
    outgoing_schedule_validation: 'fixed_reference_time' | 'native_wall_clock';
    outgoing_worker_tick: 'explicit_tick_argument';
    javascript_date_and_timers: 'native_unchanged';
    model_deadlines_and_telemetry: 'native_unchanged';
    authentication_and_sessions: 'native_unchanged';
    database_defaults_and_triggers: 'real_database_transaction_time';
  };
}

export function evaluationClockPolicy(manifest: unknown): EvaluationClockPolicy | null {
  const raw =
    manifest && typeof manifest === 'object' && 'clock_policy' in manifest
      ? (manifest as { clock_policy: unknown }).clock_policy
      : undefined;
  if (raw === undefined) return null;
  const policy = evaluationClockPolicySchema.parse(raw);
  if (!Number.isFinite(Date.parse(policy.reference_time)))
    throw new Error('Invalid fixed evaluation reference time');
  return policy;
}

export function selectEvaluationClock(
  manifest: unknown,
  caseId: string | null,
): EvaluationClockMetadata {
  const policy = evaluationClockPolicy(manifest);
  const enabled = !!policy && caseId === 'MAIL-010' && policy.case_ids.includes(caseId);
  const mode = enabled ? 'fixed_outgoing_clock' : 'native_wall_clock';
  return {
    version: 'light-crm-evaluation-clock-v1',
    mode,
    case_id: caseId,
    reference_time: enabled ? new Date(policy.reference_time).toISOString() : null,
    timezone: 'Asia/Shanghai',
    policy_sha256: policy
      ? createHash('sha256').update(JSON.stringify(policy)).digest('hex')
      : null,
    scope: {
      outgoing_schedule_validation: enabled ? 'fixed_reference_time' : 'native_wall_clock',
      outgoing_worker_tick: 'explicit_tick_argument',
      javascript_date_and_timers: 'native_unchanged',
      model_deadlines_and_telemetry: 'native_unchanged',
      authentication_and_sessions: 'native_unchanged',
      database_defaults_and_triggers: 'real_database_transaction_time',
    },
  };
}

/** A code-owned callback supplied only to OutgoingOptions; never a request parameter. */
export function outgoingEvaluationClock(
  metadata: EvaluationClockMetadata,
): (() => number) | undefined {
  if (metadata.version !== 'light-crm-evaluation-clock-v1' || metadata.timezone !== 'Asia/Shanghai')
    throw new Error('Unknown evaluation clock contract');
  if (metadata.mode === 'native_wall_clock') {
    if (metadata.reference_time !== null)
      throw new Error('Native evaluation clock cannot claim a fixed reference');
    return undefined;
  }
  if (
    metadata.case_id !== 'MAIL-010' ||
    !metadata.reference_time ||
    !metadata.policy_sha256 ||
    !/^[a-f0-9]{64}$/.test(metadata.policy_sha256)
  )
    throw new Error('Fixed evaluation clock requires its explicit case and frozen policy');
  const reference = Date.parse(metadata.reference_time);
  if (!Number.isFinite(reference)) throw new Error('Invalid fixed evaluation reference time');
  return () => reference;
}
