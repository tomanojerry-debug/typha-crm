import type { ObjectKind, RelationDefinition } from './connections.js';
import type { SystemAttribute } from './object-settings.js';
import type { CompanyAttribute } from './attributes.js';
import type { DataType } from './data-model.js';

export interface SchemaAttribute {
  id: string;
  name: string;
  type: DataType;
  multiple: boolean;
  required: boolean;
  unique: boolean;
  system: boolean;
  writable: boolean;
  computed: boolean;
  inherited: boolean;
  extraction_supported: boolean;
  description?: string;
  ai_enabled?: boolean;
  guidance?: string;
  options?: string[];
  option_labels?: Record<string, string>;
  storage_key?: string;
  currency?: string;
  version?: number;
}
export interface SchemaObject {
  id: string;
  name: string;
  kind: 'company' | 'person' | 'project' | 'custom';
  version: number;
  attributes: SchemaAttribute[];
}
export interface SchemaReference {
  id: string;
  source_object: string;
  target_object: string;
  source_label: string;
  target_label: string;
  cardinality: 'many_to_one';
  bidirectional: false;
}

export interface EntitySchema {
  revision: string;
  entities: { id: ObjectKind; name: string; attributes: SystemAttribute[] }[];
  company_attributes: CompanyAttribute[];
  relationships: RelationDefinition[];
  /** Unified executable catalog. Optional only for legacy in-process fixtures. */
  objects?: SchemaObject[];
  references?: SchemaReference[];
  capabilities: {
    entity_types: 'fixed' | 'registered';
    custom_attributes: ['customers'];
    communication_facts: 'candidates_only';
    image_recognition: false;
    custom_records?: 'read_only';
  };
}
