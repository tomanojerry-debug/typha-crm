import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { KnowledgeSnapshot, KnowledgeSource } from '../shared/knowledge.js';
import { SseFrames } from '../shared/sse.js';
import { minimaxChatEndpoint } from './minimax-endpoint.js';
import {
  communicationExtractionSchema,
  extractionVersion,
  validateCommunicationExtraction,
  ExtractionValidationError,
  type CommunicationExtraction,
  type CommunicationExtractionInput,
} from './communication-extraction.js';

export const extractionSystem = readFileSync(
  new URL('../docs/prompts/communication-extraction-v2.md', import.meta.url),
  'utf8',
);
const outputSchema = z.toJSONSchema(communicationExtractionSchema);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const extractionRevision = hash([extractionSystem, outputSchema, 'pipeline-v2']);
export interface RecordExtraction {
  record_id: string;
  input_digest: string;
  output: CommunicationExtraction;
}
export interface ExtractionRecord {
  input: CommunicationExtractionInput;
  output: CommunicationExtraction;
  source_ids: string[];
  project_id: string | null;
  trust: KnowledgeSource['trust'];
}
export type ExtractionTrace = (stage: string, value: unknown) => Promise<void>;
export type ExtractionGenerate = (
  input: CommunicationExtractionInput,
  issues: string[],
) => Promise<unknown>;
const kinds = { customers: 'company', people: 'person', projects: 'project' } as const;

export function communicationInputs(snapshot: KnowledgeSnapshot): CommunicationExtractionInput[] {
  const records = new Map<string, KnowledgeSource[]>();
  for (const source of snapshot.sources) {
    const list = records.get(source.record_id) || [];
    list.push(source);
    records.set(source.record_id, list);
  }
  return [...records].map(([record_id, sources]) => {
    if (
      sources.some(
        (s) =>
          s.project_id !== sources[0].project_id ||
          s.trust !== sources[0].trust ||
          s.channel !== sources[0].channel,
      )
    )
      throw new Error('Inconsistent Record provenance');
    const speakers: CommunicationExtractionInput['speakers'] = [];
    const catalog = snapshot.schema.objects;
    const objectKind = (id: string) =>
      catalog?.find((o) => o.id === id)?.kind || kinds[id as keyof typeof kinds];
    const messages = sources.map((s) => {
      const side = s.speaker_side || 'unknown';
      let speaker = speakers.find((p) => p.name === s.speaker && p.side === side);
      if (!speaker) {
        // Matching a display name is not enough to assert a canonical person ID.
        speaker = { id: `speaker_${speakers.length + 1}`, name: s.speaker, side, entity_id: null };
        speakers.push(speaker);
      }
      return { id: s.id, speaker_id: speaker.id, occurred_at: s.occurred_at, text: s.body };
    });
    return {
      version: extractionVersion,
      record_id,
      channel: sources[0].channel,
      timezone: 'Asia/Shanghai',
      objects: catalog?.map((o) => ({ id: o.id, kind: o.kind, name: o.name, version: o.version })),
      known_entities: snapshot.entities
        .filter(
          (e) =>
            e.object === 'customers' ||
            (e.object === 'projects' && sources[0].project_id === e.id) ||
            (e.object === 'people' && sources.some((s) => s.person_ids.includes(e.id))) ||
            (objectKind(e.object) === 'custom' &&
              (!e.attributes.project_id || e.attributes.project_id === sources[0].project_id)),
        )
        .map((e) => ({ id: e.id, kind: objectKind(e.object), object_id: e.object, name: e.name })),
      attributes: catalog
        ? catalog.flatMap((o) =>
            o.attributes.map((a) => ({
              id: a.id,
              entity_kind: o.kind,
              object_id: o.id,
              name: a.name,
              value_type: a.type,
              multiple: a.multiple,
              options: a.options,
              option_labels: a.option_labels,
              storage_key: a.storage_key,
              currency: a.currency,
              required: a.required,
              unique: a.unique,
              system: a.system,
              writable: a.writable,
              computed: a.computed,
              extraction_supported: a.extraction_supported,
              version: a.version,
            })),
          )
        : [
            ...snapshot.schema.entities.flatMap((e) =>
              e.attributes.map((a) => ({
                id: `${e.id}:${a.id}`,
                entity_kind: kinds[e.id],
                name: a.name,
                value_type:
                  a.valueType ||
                  (a.id === 'email_count' ? 'number' : a.id === 'is_primary' ? 'checkbox' : 'text'),
              })),
            ),
            ...snapshot.schema.company_attributes.map((a) => ({
              id: a.id,
              entity_kind: 'company' as const,
              name: a.name,
              value_type: a.kind,
            })),
          ],
      relation_definitions: [
        ...snapshot.schema.relationships,
        ...(snapshot.schema.references || []),
      ].map((r) => ({
        id: r.id,
        from_kind: objectKind(r.source_object),
        to_kind: objectKind(r.target_object),
        from_object: r.source_object,
        to_object: r.target_object,
        bidirectional: !('bidirectional' in r) || r.bidirectional,
        label: r.source_label,
      })),
      speakers,
      messages,
      prior_claims: [],
    };
  });
}

// Stable cross-record references. Local model claim IDs never become citation IDs.
export function claimKey(record: string, id: string) {
  const hex = hash([record, id]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function priorClaims(records: ExtractionRecord[], sources: KnowledgeSource[]) {
  // Keep prior claims inside exactly the same project/trust/person evidence partition.
  const people = [...new Set(sources.flatMap((s) => s.person_ids))].sort();
  return records
    .filter(
      (r) =>
        r.project_id === sources[0].project_id &&
        r.trust === sources[0].trust &&
        JSON.stringify(r.input.speakers.map((s) => s.name).sort()) ===
          JSON.stringify([...new Set(sources.map((s) => s.speaker))].sort()) &&
        JSON.stringify(
          r.input.known_entities
            .filter((e) => e.kind === 'person')
            .map((e) => e.id)
            .sort(),
        ) === JSON.stringify(people),
    )
    .flatMap((r) => {
      const names = new Map(r.output.entities.map((e) => [e.ref, e.name]));
      return [...r.output.attributes, ...r.output.relations].map((c) => ({
        id: claimKey(r.output.record_id, c.id),
        ...(() => {
          const attribute = 'entity_ref' in c;
          const subject = r.output.entities.find(
            (e) => e.ref === (attribute ? c.entity_ref : c.from_ref),
          );
          const target = !attribute ? r.output.entities.find((e) => e.ref === c.to_ref) : undefined;
          return {
            claim_kind: attribute ? ('attribute' as const) : ('relation' as const),
            field_id: attribute ? c.field_id : null,
            definition_id: !attribute ? c.definition_id : null,
            object_id: subject?.object_id,
            canonical_id: subject?.canonical_id,
            entity_kind: subject?.kind,
            target_object_id: target?.object_id,
            target_kind: target?.kind,
          };
        })(),
        description: JSON.stringify({
          record_id: r.output.record_id,
          speaker: r.input.speakers.find((s) => s.id === c.speaker_id)?.name,
          ...('entity_ref' in c
            ? { subject: names.get(c.entity_ref), field: c.field_label, value: c.value }
            : { from: names.get(c.from_ref), relation: c.label, to: names.get(c.to_ref) }),
          modality: c.modality,
          evidence: c.evidence.map((e) => e.quote),
        }),
      }));
    })
    .slice(-100);
}
export async function extractSnapshot(
  snapshot: KnowledgeSnapshot,
  cached: RecordExtraction[],
  generate: ExtractionGenerate,
  trace?: ExtractionTrace,
): Promise<{ extractions: RecordExtraction[]; records: ExtractionRecord[] }> {
  const records: ExtractionRecord[] = [],
    extractions: RecordExtraction[] = [];
  for (const input of communicationInputs(snapshot)) {
    const sources = snapshot.sources.filter((s) => s.record_id === input.record_id);
    input.prior_claims = priorClaims(records, sources);
    const input_digest = hash([extractionRevision, snapshot.schema.revision, input]);
    const previous = cached.find(
      (c) => c.record_id === input.record_id && c.input_digest === input_digest,
    );
    await trace?.('extraction-input', {
      input,
      schema_revision: snapshot.schema.revision,
      input_digest,
      cached: !!previous,
    });
    let output: CommunicationExtraction | undefined;
    if (previous) output = validateCommunicationExtraction(previous.output, input);
    else {
      let issues: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const raw = await generate(input, issues);
          await trace?.('extraction-response', { record_id: input.record_id, attempt, raw });
          output = validateCommunicationExtraction(raw, input);
          break;
        } catch (error) {
          issues =
            error instanceof ExtractionValidationError
              ? error.issues
              : ['模型传输或 JSON 响应未完成，请重新输出完整结果。'];
          await trace?.('extraction-retry', { record_id: input.record_id, attempt, issues });
          if (attempt === 2) throw new Error('Communication extraction failed');
        }
      }
    }
    if (!output) throw new Error('Missing extraction');
    extractions.push({ record_id: input.record_id, input_digest, output });
    records.push({
      input,
      output,
      source_ids: sources.map((s) => s.id),
      project_id: sources[0].project_id,
      trust: sources[0].trust,
    });
    await trace?.('extraction-validated', { input_digest, ...records.at(-1) });
  }
  return { extractions, records };
}

/** Reconstruct inputs from authorized sources; never accept model-supplied scope/input. */
export async function validateExtractions(snapshot: KnowledgeSnapshot, raw: unknown) {
  const parsed = z
    .array(
      z.strictObject({
        record_id: z.uuid(),
        input_digest: z.string().length(64),
        output: communicationExtractionSchema,
      }),
    )
    .max(200)
    .parse(raw);
  if (
    new Set(parsed.map((r) => r.record_id)).size !== parsed.length ||
    parsed.length !== communicationInputs(snapshot).length
  )
    throw new Error('Incomplete Record extractions');
  return extractSnapshot(snapshot, parsed, async () => {
    throw new Error('Invalid cached extraction');
  });
}

export function minimaxExtractor(options: {
  apiKey: string;
  region: 'cn' | 'global';
  fetch?: typeof fetch;
  trace?: ExtractionTrace;
}): ExtractionGenerate {
  return async (input, issues) => {
    const body = {
      model: 'MiniMax-M3.1-Flash',
      stream: true,
      reasoning_split: true,
      reasoning_effort: 'medium',
      temperature: 0,
      max_completion_tokens: 16000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: extractionSystem },
        {
          role: 'user',
          content: JSON.stringify({
            input,
            output_schema: outputSchema,
            ...(issues.length
              ? {
                  validation_errors: issues,
                  instruction: '根据原始资料重新输出完整的实际 JSON 数据，修正校验错误。',
                }
              : {}),
          }),
        },
      ],
    };
    await options.trace?.('extraction-request', { record_id: input.record_id, body });
    const response = await (options.fetch || fetch)(minimaxChatEndpoint(options.region), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(240000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Extraction provider unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty extraction response');
    let content = '',
      bytes = 0,
      finished = '',
      done = false;
    const decoder = new TextDecoder(),
      frames = new SseFrames();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 2_000_000) throw new Error('Extraction response too large');
        for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
          if (frame === '[DONE]') {
            done = true;
            break;
          }
          const data = JSON.parse(frame);
          if (data.error || data.base_resp?.status_code)
            throw new Error('Extraction provider failure');
          const choice = data.choices?.[0];
          if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
          if (choice?.finish_reason) finished = choice.finish_reason;
        }
        if (done) break;
      }
      if (!done || finished !== 'stop') throw new Error('Incomplete extraction response');
      return JSON.parse(
        content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, ''),
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
}
