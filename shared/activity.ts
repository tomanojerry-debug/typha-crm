import type { AuditEvent, CustomerRecord } from './domain';

export type ActivityItem =
  | { type: 'record'; id: string; date: string; record: CustomerRecord }
  | { type: 'event'; id: string; date: string; event: AuditEvent };

// The API supplies authorized customer data. This selects the visible project timeline;
// it does not replace server-side authorization or customer isolation.
export function activityItems(
  records: CustomerRecord[],
  audit: AuditEvent[],
  projectId?: string,
): ActivityItem[] {
  const scopedRecords = projectId ? records.filter((r) => r.project_id === projectId) : records;
  const ids = new Set(scopedRecords.map((r) => r.id));
  const events = audit.filter((event) => {
    if (
      event.entity_type === 'customer_records' &&
      event.action === 'insert' &&
      ids.has(event.entity_id)
    )
      return false;
    return (
      !projectId ||
      (event.entity_type === 'projects' && event.entity_id === projectId) ||
      (event.entity_type === 'customer_records' && ids.has(event.entity_id))
    );
  });
  return [
    ...scopedRecords.map((record) => ({
      type: 'record' as const,
      id: `record-${record.id}`,
      date: record.occurred_at || record.created_at,
      record,
    })),
    ...events.map((event) => ({
      type: 'event' as const,
      id: `event-${event.id}`,
      date: event.created_at,
      event,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
