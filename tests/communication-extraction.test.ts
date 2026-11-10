import { describe, expect, it } from 'vitest';
import {
  extractionEnvelope,
  extractionAgentSource,
  extractionVersion,
  validateCommunicationExtraction,
  type CommunicationExtraction,
  type CommunicationExtractionInput,
} from '../server/communication-extraction.js';

const record = '10000000-0000-4000-8000-000000000001';
const person = '10000000-0000-4000-8000-000000000002';
const input: CommunicationExtractionInput = {
  version: extractionVersion,
  record_id: record,
  channel: 'wechat',
  timezone: 'Asia/Shanghai',
  known_entities: [{ id: person, kind: 'person', name: '顾老师' }],
  attributes: [{ id: 'job_title', entity_kind: 'person', name: '职务', value_type: 'text' }],
  relation_definitions: [{ id: 'staff', from_kind: 'company', to_kind: 'person', label: '联系人' }],
  speakers: [
    { id: 'external', name: '顾老师', side: 'external', entity_id: person },
    { id: 'internal', name: '我', side: 'internal', entity_id: null },
  ],
  messages: [
    {
      id: 'm1',
      speaker_id: 'external',
      occurred_at: '2026-10-22T04:00:00Z',
      text: '预计采购80套，样衣4件。',
    },
    { id: 'm2', speaker_id: 'internal', occurred_at: '2026-10-22T04:01:00Z', text: '可以先评估。' },
  ],
  prior_claims: [],
};

function candidate(): CommunicationExtraction {
  return {
    version: extractionVersion,
    record_id: record,
    trust: 'unconfirmed',
    entities: [
      {
        ref: 'purchase',
        kind: 'subject',
        name: '本次采购需求',
        canonical_id: null,
        evidence: [{ message_id: 'm1', quote: '预计采购80套' }],
      },
      {
        ref: 'sample',
        kind: 'subject',
        name: '样衣',
        canonical_id: null,
        evidence: [{ message_id: 'm1', quote: '样衣4件' }],
      },
    ],
    attributes: [
      {
        id: 'a1',
        entity_ref: 'purchase',
        field_id: null,
        field_label: '预计采购量',
        value: { type: 'number', value: 80, unit: '套' },
        speaker_id: 'external',
        modality: 'estimated',
        effective_at: null,
        evidence: [{ message_id: 'm1', quote: '预计采购80套' }],
      },
      {
        id: 'a2',
        entity_ref: 'sample',
        field_id: null,
        field_label: '样衣数量',
        value: { type: 'number', value: 4, unit: '件' },
        speaker_id: 'external',
        modality: 'requested',
        effective_at: null,
        evidence: [{ message_id: 'm1', quote: '样衣4件' }],
      },
    ],
    relations: [],
    changes: [],
    uncertainties: [],
  };
}

describe('communication extraction candidate protocol', () => {
  it('exposes one Record citation while keeping internal graph and message references out of the answer view', () => {
    const source = extractionAgentSource(candidate(), input);
    expect(source.id).toBe(`record::${record}`);
    const body = JSON.parse(source.body);
    expect(body.original_messages).toHaveLength(input.messages.length);
    expect(body.original_messages[1].text).toBe(input.messages[1].text);
    expect(body.attributes[0].evidence[0]).toEqual({
      quote: '预计采购80套',
      occurred_at: '2026-10-22T04:00:00Z',
      speaker: '顾老师',
    });
    expect(source.body).not.toContain('message_id');
    expect(source.body).not.toContain('canonical_id');
    expect(source.body).not.toContain('entity_ref');
    expect(source.body).not.toContain('claim_id');
  });
  it('keeps original Record citation, separate subjects and observation time without approving a request', () => {
    const result = extractionEnvelope(candidate(), input);
    expect(result.record_id).toBe(record);
    expect(result.citation_id).toBe(`record::${record}`);
    expect(result.trust).toBe('unconfirmed');
    expect(result.claims.map((c) => 'entity_ref' in c && c.entity_ref)).toEqual([
      'purchase',
      'sample',
    ]);
    expect(result.claims[0].effective_at).toBeNull();
    expect(result.claims[0].observed_at).toEqual(['2026-10-22T04:00:00Z']);
  });
  it('rejects another Record or an unknown canonical entity', () => {
    const value = candidate();
    value.record_id = person;
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
    value.record_id = record;
    value.entities[0].canonical_id = record;
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
  });
  it('rejects invented or paraphrased quotations and references to other messages', () => {
    const value = candidate();
    value.attributes[0].evidence[0].quote = '已确认采购80套';
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
    value.attributes[0].evidence = [
      { message_id: 'another-customer-message', quote: '预计采购80套' },
    ];
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
  });
  it('rejects attributing one speaker’s words to the other speaker', () => {
    const value = candidate();
    value.attributes[0].speaker_id = 'internal';
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
  });
  it('rejects unregistered fields, wrong entity kinds and fabricated relation endpoints', () => {
    const value = candidate();
    value.attributes[0].field_id = 'job_title';
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
    value.attributes[0].field_id = null;
    value.relations.push({
      id: 'r1',
      from_ref: 'purchase',
      to_ref: 'missing',
      definition_id: 'staff',
      label: '联系人',
      speaker_id: 'external',
      modality: 'stated',
      effective_at: null,
      evidence: [{ message_id: 'm1', quote: '预计采购80套' }],
    });
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
  });
  it('keeps a model from granting approval or returning Schema instead of candidate values', () => {
    expect(() =>
      validateCommunicationExtraction({ ...candidate(), trust: 'company_confirmed' }, input),
    ).toThrow();
    expect(() =>
      validateCommunicationExtraction({ type: 'object', properties: {} }, input),
    ).toThrow();
  });
  it('rejects duplicate claim IDs and invented change targets', () => {
    const value = candidate();
    value.attributes[1].id = 'a1';
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
    value.attributes[1].id = 'a2';
    value.changes.push({
      new_claim_id: 'a1',
      old_claim_id: 'missing',
      kind: 'proposed_change',
      evidence: [{ message_id: 'm1', quote: '预计采购80套' }],
    });
    expect(() => validateCommunicationExtraction(value, input)).toThrow();
  });
});
