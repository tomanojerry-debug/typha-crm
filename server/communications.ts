import { communicationColumns, emailStrengthRules as rules } from '../shared/communications.js';

export const communicationSorts = Object.fromEntries(
  Object.keys(communicationColumns).map((key) => [key, `communication.${key}`]),
);

// Runs as the calling transaction's restricted role. Never bypass mail/customer RLS.
// EXISTS prevents one message to multiple people from inflating company totals.
export function communicationJoin(object: 'customers' | 'people') {
  const owner = object === 'customers' ? 'c' : 'p';
  const customer = object === 'customers' ? 'c.id' : 'p.customer_id';
  return `CROSS JOIN LATERAL (
    SELECT stats.*, CASE
      WHEN last_email_at IS NULL THEN 0
      WHEN last_email_at < now() - interval '${rules.veryWeakDays} days' THEN 1
      WHEN last_email_at < now() - interval '${rules.weakDays} days' THEN 2
      WHEN last_email_at < now() - interval '${rules.recentDays} days' THEN 3
      WHEN recent_inbound AND recent_outbound AND email_count_30d >= ${rules.veryStrongCount} THEN 5
      WHEN recent_inbound AND recent_outbound AND email_count_30d >= ${rules.strongCount} THEN 4
      ELSE 3 END AS email_strength
    FROM (
      SELECT min(m.occurred_at) AS first_email_at, max(m.occurred_at) AS last_email_at,
        max(m.occurred_at) FILTER(WHERE m.direction='inbound') AS last_inbound_at,
        max(m.occurred_at) FILTER(WHERE m.direction='outbound') AS last_outbound_at,
        count(DISTINCT m.fingerprint)::int AS email_count,
        count(DISTINCT m.fingerprint) FILTER(WHERE m.occurred_at >= now() - interval '${rules.recentDays} days')::int AS email_count_30d,
        bool_or(m.direction='inbound' AND m.occurred_at >= now() - interval '${rules.recentDays} days') AS recent_inbound,
        bool_or(m.direction='outbound' AND m.occurred_at >= now() - interval '${rules.recentDays} days') AS recent_outbound
      FROM mail_messages m
      WHERE m.workspace_id=${owner}.workspace_id AND m.customer_id=${customer}
        AND m.occurred_at <= now()
        ${object === 'people' ? 'AND EXISTS(SELECT 1 FROM mail_people mp WHERE mp.workspace_id=m.workspace_id AND mp.customer_id=m.customer_id AND mp.message_id=m.id AND mp.person_id=p.id)' : ''}
    ) stats
  ) communication`;
}
// Keep internal inputs out of the public record response.
export const communicationSelect = [...Object.keys(communicationColumns), 'email_count_30d']
  .map((key) => `communication.${key}`)
  .join(', ');
