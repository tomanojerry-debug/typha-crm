import { z } from 'zod';
import type { AgentSource } from '../shared/agent.js';

export const extractionVersion = 'crm-communication-v2' as const;
const entityKind = z.enum(['company', 'person', 'project', 'custom', 'subject']);
const ref = z.string().min(1).max(80);
const evidence = z
  .array(
    z.strictObject({
      message_id: z.string().min(1).max(160),
      quote: z.string().min(1).max(1200),
    }),
  )
  .min(1)
  .max(12);
const modality = z.enum([
  'stated',
  'requested',
  'estimated',
  'proposed',
  'questioned',
  'negated',
  'reported',
]);
const value = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: z.string().min(1).max(2000), unit: z.null() }),
  z.strictObject({
    type: z.literal('number'),
    value: z.number().finite().min(-1e15).max(1e15),
    unit: z.string().max(40).nullable(),
  }),
  z.strictObject({ type: z.literal('date'), value: z.iso.date(), unit: z.null() }),
  z.strictObject({ type: z.literal('boolean'), value: z.boolean(), unit: z.null() }),
  z.strictObject({ type: z.literal('checkbox'), value: z.boolean(), unit: z.null() }),
  z.strictObject({
    type: z.literal('timestamp'),
    value: z.iso.datetime({ offset: true }),
    unit: z.null(),
  }),
  z.strictObject({
    type: z.literal('rating'),
    value: z.number().int().min(1).max(5),
    unit: z.null(),
  }),
  z.strictObject({
    type: z.literal('currency'),
    value: z.number().finite().min(-1e15).max(1e15),
    currency: z.enum(['CNY', 'USD', 'EUR', 'GBP', 'JPY']),
    unit: z.null(),
  }),
  z.strictObject({
    type: z.literal('select'),
    value: z.union([
      z.string().min(1).max(100),
      z.array(z.string().min(1).max(100)).min(1).max(40),
    ]),
    unit: z.null(),
  }),
  z.strictObject({
    type: z.enum(['email', 'phone', 'url', 'domain', 'status']),
    value: z.string().min(1).max(2000),
    unit: z.null(),
  }),
]);
const claim = {
  id: ref,
  speaker_id: ref,
  modality,
  effective_at: z.iso.datetime({ offset: true }).nullable(),
  evidence,
};

// This is a candidate protocol, not a business write or approval command.
export const communicationExtractionSchema = z.strictObject({
  version: z.literal(extractionVersion),
  record_id: z.uuid(),
  trust: z.literal('unconfirmed'),
  entities: z
    .array(
      z.strictObject({
        ref,
        kind: entityKind,
        object_id: z.string().min(1).max(80).nullable().optional(),
        name: z.string().min(1).max(200),
        canonical_id: z.uuid().nullable(),
        evidence,
      }),
    )
    .max(60),
  attributes: z
    .array(
      z.strictObject({
        ...claim,
        entity_ref: ref,
        field_id: z.string().min(1).max(160).nullable(),
        field_label: z.string().min(1).max(100),
        value,
      }),
    )
    .max(120),
  relations: z
    .array(
      z.strictObject({
        ...claim,
        from_ref: ref,
        to_ref: ref,
        definition_id: z.string().min(1).max(160).nullable(),
        label: z.string().min(1).max(100),
      }),
    )
    .max(80),
  changes: z
    .array(
      z.strictObject({
        new_claim_id: ref,
        old_claim_id: ref,
        kind: z.enum(['proposed_change', 'explicit_correction']),
        evidence,
      }),
    )
    .max(40),
  uncertainties: z
    .array(
      z.strictObject({
        description: z.string().min(1).max(1000),
        evidence,
      }),
    )
    .max(30),
});

export type CommunicationExtraction = z.infer<typeof communicationExtractionSchema>;
export interface CommunicationExtractionInput {
  version: typeof extractionVersion;
  record_id: string;
  channel: 'email' | 'wechat' | 'record';
  timezone: 'Asia/Shanghai';
  objects?: { id: string; kind: z.infer<typeof entityKind>; name: string; version?: number }[];
  known_entities: {
    id: string;
    kind: z.infer<typeof entityKind>;
    name: string;
    object_id?: string;
  }[];
  attributes: {
    id: string;
    entity_kind: z.infer<typeof entityKind>;
    name: string;
    value_type: string;
    object_id?: string;
    multiple?: boolean;
    options?: string[];
    option_labels?: Record<string, string>;
    storage_key?: string;
    currency?: string;
    required?: boolean;
    unique?: boolean;
    system?: boolean;
    writable?: boolean;
    computed?: boolean;
    extraction_supported?: boolean;
    version?: number;
  }[];
  relation_definitions: {
    id: string;
    from_kind: z.infer<typeof entityKind>;
    to_kind: z.infer<typeof entityKind>;
    label: string;
    from_object?: string;
    to_object?: string;
    bidirectional?: boolean;
  }[];
  speakers: {
    id: string;
    name: string;
    side: 'internal' | 'external' | 'unknown';
    entity_id: string | null;
  }[];
  messages: { id: string; speaker_id: string; occurred_at: string; text: string }[];
  prior_claims: {
    id: string;
    description: string;
    claim_kind?: 'attribute' | 'relation';
    field_id?: string | null;
    definition_id?: string | null;
    object_id?: string | null;
    canonical_id?: string | null;
    entity_kind?: z.infer<typeof entityKind>;
    target_object_id?: string | null;
    target_kind?: z.infer<typeof entityKind>;
  }[];
}

export class ExtractionValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super('Communication extraction failed validation');
  }
}

/** Input must be built by the authorized server scope; model output cannot expand it. */
export function validateCommunicationExtraction(raw: unknown, input: CommunicationExtractionInput) {
  const parsed = communicationExtractionSchema.safeParse(raw);
  if (!parsed.success)
    throw new ExtractionValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code}`),
    );
  const output = parsed.data;
  const issues: string[] = [];
  if (output.record_id !== input.record_id) issues.push('record_id: outside input');
  const messages = new Map(input.messages.map((m) => [m.id, m]));
  const speakers = new Map(input.speakers.map((s) => [s.id, s]));
  const known = new Map(input.known_entities.map((e) => [e.id, e]));
  const objects = new Map(input.objects?.map((o) => [o.id, o]) || []);
  const entities = new Map(output.entities.map((e) => [e.ref, e]));
  const claims = [...output.attributes, ...output.relations];
  const claimIds = new Set(claims.map((c) => c.id));
  const prior = new Set(input.prior_claims.map((c) => c.id));
  if (entities.size !== output.entities.length) issues.push('entities: duplicate ref');
  if (claimIds.size !== claims.length) issues.push('claims: duplicate id');
  if (claims.some((c) => prior.has(c.id))) issues.push('claims: id conflicts with prior claim');
  const checkEvidence = (items: z.infer<typeof evidence>, label: string, speaker?: string) => {
    for (const item of items) {
      const message = messages.get(item.message_id);
      if (!message || !message.text.includes(item.quote))
        issues.push(`${label}: quote not in original message`);
    }
    if (speaker && !items.some((e) => messages.get(e.message_id)?.speaker_id === speaker))
      issues.push(`${label}: speaker has no cited message`);
  };
  for (const entity of output.entities) {
    checkEvidence(entity.evidence, entity.ref);
    if (entity.canonical_id && known.get(entity.canonical_id)?.kind !== entity.kind)
      issues.push(`${entity.ref}: canonical entity unavailable or wrong kind`);
    const canonical = entity.canonical_id ? known.get(entity.canonical_id) : undefined;
    if (
      entity.kind === 'custom' &&
      (!entity.object_id || objects.get(entity.object_id)?.kind !== 'custom')
    )
      issues.push(`${entity.ref}: unregistered custom object`);
    if (entity.object_id && objects.size && objects.get(entity.object_id)?.kind !== entity.kind)
      issues.push(`${entity.ref}: object identity does not match entity kind`);
    if (canonical?.object_id && entity.object_id && canonical.object_id !== entity.object_id)
      issues.push(`${entity.ref}: canonical entity belongs to another object`);
    if (
      entity.kind === 'custom' &&
      canonical?.object_id !== undefined &&
      canonical.object_id !== entity.object_id
    )
      issues.push(`${entity.ref}: custom canonical object mismatch`);
  }
  for (const c of claims) {
    if (!speakers.has(c.speaker_id)) issues.push(`${c.id}: unknown speaker`);
    checkEvidence(c.evidence, c.id, c.speaker_id);
  }
  for (const a of output.attributes) {
    const entity = entities.get(a.entity_ref);
    if (!entity) issues.push(`${a.id}: unknown entity ref`);
    if (a.field_id) {
      const field = input.attributes.find(
        (f) =>
          f.id === a.field_id &&
          f.entity_kind === entity?.kind &&
          (!f.object_id ||
            f.object_id === entity?.object_id ||
            (entity?.kind !== 'custom' &&
              !entity?.object_id &&
              objects.get(f.object_id)?.kind === entity?.kind)),
      );
      if (!field) issues.push(`${a.id}: field not in entity schema`);
      else {
        if (a.field_label !== field.name)
          issues.push(`${a.id}: field label does not match registered field`);
        if (field.writable === false || field.computed || field.extraction_supported === false)
          issues.push(`${a.id}: field is system maintained or extraction unsupported`);
        if (a.value.type !== field.value_type)
          issues.push(`${a.id}: value type does not match registered field`);
        if (field.multiple ? !Array.isArray(a.value.value) : Array.isArray(a.value.value))
          issues.push(`${a.id}: value multiplicity does not match field`);
        if (a.value.type === 'select' || a.value.type === 'status') {
          const choices = Array.isArray(a.value.value) ? a.value.value : [a.value.value];
          if (
            new Set(choices).size !== choices.length ||
            choices.some((v) => !field.options?.includes(v))
          )
            issues.push(`${a.id}: unregistered or duplicate option`);
        }
        if (a.value.type === 'currency' && a.value.currency !== field.currency)
          issues.push(`${a.id}: currency differs from registered field`);
        if (a.value.type === 'email' && !z.email().safeParse(a.value.value).success)
          issues.push(`${a.id}: invalid email value`);
      }
    }
  }
  for (const r of output.relations) {
    const from = entities.get(r.from_ref),
      to = entities.get(r.to_ref);
    if (!from || !to) issues.push(`${r.id}: unknown relation endpoint`);
    if (
      r.definition_id &&
      !input.relation_definitions.some(
        (d) =>
          d.id === r.definition_id &&
          d.from_kind === from?.kind &&
          d.to_kind === to?.kind &&
          (!d.from_object ||
            d.from_object === from?.object_id ||
            (from?.kind !== 'custom' && !from?.object_id)) &&
          (!d.to_object ||
            d.to_object === to?.object_id ||
            (to?.kind !== 'custom' && !to?.object_id)),
      )
    )
      issues.push(`${r.id}: relation definition or endpoint kinds invalid`);
    if (
      r.definition_id &&
      input.relation_definitions.find((d) => d.id === r.definition_id)?.label !== r.label
    )
      issues.push(`${r.id}: relation label does not match registered definition`);
  }
  for (const change of output.changes) {
    if (
      !claimIds.has(change.new_claim_id) ||
      (!claimIds.has(change.old_claim_id) && !prior.has(change.old_claim_id)) ||
      change.new_claim_id === change.old_claim_id
    )
      issues.push('changes: unknown or identical claim reference');
    const newer = claims.find((c) => c.id === change.new_claim_id);
    const older = claims.find((c) => c.id === change.old_claim_id);
    const previous = input.prior_claims.find((c) => c.id === change.old_claim_id);
    if (newer && (older || previous)) {
      const descriptor = (c: (typeof claims)[number]) => {
        const attribute = 'entity_ref' in c;
        const subject = entities.get(attribute ? c.entity_ref : c.from_ref);
        const target = !attribute ? entities.get(c.to_ref) : undefined;
        return {
          claim_kind: attribute ? 'attribute' : 'relation',
          field_id: attribute ? c.field_id : null,
          definition_id: !attribute ? c.definition_id : null,
          object_id: subject?.object_id,
          canonical_id: subject?.canonical_id,
          entity_kind: subject?.kind,
          local_ref: attribute ? c.entity_ref : c.from_ref,
          target_object_id: target?.object_id,
          target_kind: target?.kind,
        };
      };
      const n = descriptor(newer),
        o = older ? descriptor(older) : previous!;
      if (o.claim_kind && n.claim_kind !== o.claim_kind)
        issues.push('changes: attribute and relation claims cannot replace each other');
      for (const key of [
        'field_id',
        'definition_id',
        'object_id',
        'canonical_id',
        'entity_kind',
        'target_object_id',
        'target_kind',
      ] as const)
        if (n[key] && o[key] && n[key] !== o[key]) issues.push(`changes: mismatched ${key}`);
      if (
        older &&
        'local_ref' in o &&
        n.local_ref !== o.local_ref &&
        !(n.canonical_id && n.canonical_id === o.canonical_id)
      )
        issues.push('changes: different local subjects');
    }
    checkEvidence(change.evidence, 'changes');
  }
  for (const uncertainty of output.uncertainties)
    checkEvidence(uncertainty.evidence, 'uncertainties');
  if (issues.length) throw new ExtractionValidationError(issues);
  return output;
}

/** Persist this alongside the Record. Internal IDs are not answer citation IDs. */
export function extractionEnvelope(
  output: CommunicationExtraction,
  input: CommunicationExtractionInput,
) {
  const validated = validateCommunicationExtraction(output, input);
  const messageMap = new Map(input.messages.map((m) => [m.id, m]));
  const claims = [...validated.attributes, ...validated.relations].map((c) => ({
    ...c,
    record_id: input.record_id,
    observed_at: [...new Set(c.evidence.map((e) => messageMap.get(e.message_id)!.occurred_at))],
  }));
  return {
    record_id: input.record_id,
    citation_id: `record::${input.record_id}`,
    extraction_version: extractionVersion,
    trust: validated.trust,
    entities: validated.entities,
    claims,
    changes: validated.changes,
    uncertainties: validated.uncertainties,
    notice: '候选理解结果；未经业务确认，不更新正式实体、属性、关系或历史有效期。',
  };
}

/** A candidate-only answer view; internal graph/message/claim IDs stay out of its body. */
export function extractionAgentSource(
  output: CommunicationExtraction,
  input: CommunicationExtractionInput,
): AgentSource {
  const validated = validateCommunicationExtraction(output, input);
  const names = new Map(validated.entities.map((e) => [e.ref, e.name]));
  const messages = new Map(input.messages.map((m) => [m.id, m]));
  const speakers = new Map(input.speakers.map((s) => [s.id, s.name]));
  const displayEvidence = (items: z.infer<typeof evidence>) =>
    items.map((e) => {
      const message = messages.get(e.message_id)!;
      return {
        quote: e.quote,
        occurred_at: message.occurred_at,
        speaker: speakers.get(message.speaker_id),
      };
    });
  return {
    id: `record::${input.record_id}`,
    title: '沟通Record及结构化候选',
    body: JSON.stringify({
      trust: 'unconfirmed',
      channel: input.channel,
      original_messages: input.messages.map((m) => ({
        speaker: speakers.get(m.speaker_id),
        occurred_at: m.occurred_at,
        text: m.text,
      })),
      attributes: validated.attributes.map((a) => ({
        subject: names.get(a.entity_ref),
        field: a.field_label,
        value: a.value,
        modality: a.modality,
        speaker: speakers.get(a.speaker_id),
        effective_at: a.effective_at,
        evidence: displayEvidence(a.evidence),
      })),
      relations: validated.relations.map((r) => ({
        from: names.get(r.from_ref),
        relation: r.label,
        to: names.get(r.to_ref),
        modality: r.modality,
        speaker: speakers.get(r.speaker_id),
        effective_at: r.effective_at,
        evidence: displayEvidence(r.evidence),
      })),
      uncertainties: validated.uncertainties.map((u) => ({
        description: u.description,
        evidence: displayEvidence(u.evidence),
      })),
      notice:
        '仅为原文的候选理解，不代表公司确认。日期按Asia/Shanghai解释；引用只使用外层来源id。此视图不包含历史变化结论，需另行核对原始Record。',
    }),
  };
}
