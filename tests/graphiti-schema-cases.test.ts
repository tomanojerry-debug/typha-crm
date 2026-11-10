import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { graphitiSchemaCases } from '../scripts/fixtures/graphiti-schema-cases.js';
import {
  extractionVersion,
  validateCommunicationExtraction,
  type CommunicationExtractionInput,
} from '../server/communication-extraction.js';

it('supplies two invented channel cases with a full type matrix, corrections and preserved unknowns', () => {
  expect(graphitiSchemaCases.map((c) => c.id)).toEqual(['email', 'wechat']);
  for (const c of graphitiSchemaCases) {
    expect(new Set(c.messages.map((m) => m.id)).size).toBe(c.messages.length);
    expect(c.fields.map((f) => f.kind).sort()).toEqual(
      [
        'text',
        'number',
        'currency',
        'date',
        'timestamp',
        'checkbox',
        'rating',
        'select',
        'multi_select',
      ].sort(),
    );
    expect(c.fields.some((f) => f.initial === false)).toBe(true);
    const text = c.messages.map((m) => m.text).join('\n');
    expect(text).toContain(c.record);
    expect(text).toContain('纠正');
    expect(text).toContain(c.expected.unconfigured_field);
    expect(text).toMatch(/不承诺|不要承诺|不是已承诺/);
    expect(text).not.toContain(c.excluded_company);
    expect(c.messages.every((m) => Number.isFinite(Date.parse(m.at)))).toBe(true);
  }
  expect(graphitiSchemaCases[1].fields.some((f) => f.initial === 0)).toBe(true);
});

for (const c of graphitiSchemaCases) {
  it(`${c.id} validates actual fixture quotes against a configured custom field and rejects forged scope/type`, () => {
    const object = randomUUID(),
      record = randomUUID(),
      field = randomUUID();
    const message = c.messages.find((m) => m.text.includes('本人'))!;
    const input: CommunicationExtractionInput = {
      version: extractionVersion,
      record_id: randomUUID(),
      channel: c.id,
      timezone: 'Asia/Shanghai',
      objects: [{ id: object, kind: 'custom', name: c.object.name }],
      known_entities: [{ id: record, kind: 'custom', name: c.record, object_id: object }],
      attributes: [
        {
          id: field,
          entity_kind: 'custom',
          object_id: object,
          name: '已配置数字',
          value_type: 'number',
          multiple: false,
          writable: true,
          computed: false,
          extraction_supported: true,
        },
      ],
      relation_definitions: [],
      speakers: [{ id: 'customer', name: c.contact, side: 'external', entity_id: null }],
      messages: [
        { id: message.id, speaker_id: 'customer', occurred_at: message.at, text: message.text },
      ],
      prior_claims: [],
    };
    const output = {
      version: extractionVersion,
      record_id: input.record_id,
      trust: 'unconfirmed',
      entities: [
        {
          ref: 'subject',
          kind: 'custom',
          name: c.record,
          canonical_id: record,
          object_id: object,
          evidence: [{ message_id: message.id, quote: message.text }],
        },
      ],
      attributes: [
        {
          id: 'revised',
          entity_ref: 'subject',
          field_id: field,
          field_label: '已配置数字',
          value: { type: 'number', value: Number(c.expected.revised), unit: null },
          speaker_id: 'customer',
          modality: 'requested',
          effective_at: null,
          evidence: [{ message_id: message.id, quote: message.text }],
        },
      ],
      relations: [],
      changes: [],
      uncertainties: [],
    };
    expect(validateCommunicationExtraction(output, input).attributes[0].field_id).toBe(field);
    const foreign = structuredClone(output);
    foreign.entities[0].canonical_id = randomUUID();
    expect(() => validateCommunicationExtraction(foreign, input)).toThrow();
    const fakeQuote = structuredClone(output);
    fakeQuote.attributes[0].evidence[0].quote = '从未出现的公司确认';
    expect(() => validateCommunicationExtraction(fakeQuote, input)).toThrow();
    const wrongType = structuredClone(output);
    Object.assign(wrongType.attributes[0], {
      value: { type: 'text', value: c.expected.revised, unit: null },
    });
    expect(() => validateCommunicationExtraction(wrongType, input)).toThrow();
  });
}
