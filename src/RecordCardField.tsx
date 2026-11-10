import type { ReactNode } from 'react';
import {
  Activity,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CircleDot,
  Clock3,
  Coins,
  Fingerprint,
  Folder,
  Hash,
  Layers,
  Link2,
  Mail,
  MapPin,
  Phone,
  SquareCheck,
  Star,
  Tag,
  Text,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

type RecordCardFieldKind =
  | 'text'
  | 'number'
  | 'currency'
  | 'date'
  | 'timestamp'
  | 'checkbox'
  | 'rating'
  | 'select'
  | 'multi_select'
  | 'stage'
  | 'member'
  | 'company'
  | 'project'
  | 'relation'
  | 'email'
  | 'phone'
  | 'location'
  | 'identifier'
  | 'job_title'
  | 'contact'
  | 'activity';

// These are existing system field IDs, rather than guesses from field labels
// or business content. User-defined fields supply their actual schema kind.
const systemKinds: Record<string, RecordCardFieldKind> = {
  type: 'select',
  status: 'stage',
  stage: 'stage',
  source: 'select',
  customer: 'company',
  customer_name: 'company',
  project: 'project',
  owner: 'member',
  created_by: 'member',
  contact: 'contact',
  job_title: 'job_title',
  email: 'email',
  phone: 'phone',
  region: 'location',
  due_date: 'date',
  created: 'timestamp',
  created_at: 'timestamp',
  updated_at: 'timestamp',
  first_email_at: 'timestamp',
  last_email_at: 'timestamp',
  last_inbound_at: 'timestamp',
  last_outbound_at: 'timestamp',
  project_count: 'number',
  email_count: 'number',
  email_strength: 'activity',
  id: 'identifier',
};

const kindIcons: Record<RecordCardFieldKind, LucideIcon> = {
  text: Text,
  number: Hash,
  currency: Coins,
  date: CalendarDays,
  timestamp: Clock3,
  checkbox: SquareCheck,
  rating: Star,
  select: Tag,
  multi_select: Layers,
  stage: CircleDot,
  member: UserRound,
  company: Building2,
  project: Folder,
  relation: Link2,
  email: Mail,
  phone: Phone,
  location: MapPin,
  identifier: Fingerprint,
  job_title: BriefcaseBusiness,
  contact: UserRound,
  activity: Activity,
};

function emptyValue(value: unknown) {
  return (
    value == null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && !value.length)
  );
}

function enumTone(fieldId: string, value: unknown) {
  const key = `${fieldId}:${JSON.stringify(value)}`;
  let hash = 0;
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return ['slate', 'blue', 'purple', 'amber', 'teal'][hash % 5];
}

export function RecordCardField({
  fieldId,
  label,
  kind: schemaKind,
  value,
  children,
}: {
  fieldId: string;
  label: string;
  kind?: RecordCardFieldKind;
  value: unknown;
  children: ReactNode;
}) {
  const kind = schemaKind ?? systemKinds[fieldId] ?? 'text';
  const Icon = kindIcons[kind];
  const empty = emptyValue(value);
  const enumeration = kind === 'select' || kind === 'multi_select' || kind === 'stage';
  const relation =
    kind === 'company' || kind === 'project' || kind === 'member' || kind === 'relation';
  const valueClass = [
    'record-card-value',
    empty ? 'is-empty' : '',
    !empty && enumeration ? 'is-enum' : '',
    !empty && relation ? 'is-relation' : '',
    kind === 'email' ? 'is-email' : '',
    kind === 'date' || kind === 'timestamp' ? 'is-date' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="kanban-card-field" data-field-id={fieldId} data-field-kind={kind}>
      <span className="kanban-card-field-label" title={label}>
        <Icon size={12} strokeWidth={1.6} aria-hidden="true" />
        <span>{label}</span>
      </span>
      <div
        className={valueClass}
        data-tone={!empty && enumeration ? enumTone(fieldId, value) : undefined}
      >
        {children}
      </div>
    </div>
  );
}
