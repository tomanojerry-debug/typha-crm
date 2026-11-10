import { createHash } from 'node:crypto';
import { systemAttributes, systemRelationships } from '../shared/object-settings.js';
import { objectNames, type ObjectKind, type RelationDefinition } from '../shared/connections.js';
import type { CompanyAttribute } from '../shared/attributes.js';
import type { EntitySchema } from '../shared/entity-schema.js';
import type { SchemaAttribute, SchemaObject, SchemaReference } from '../shared/entity-schema.js';
import { customKindSemantics } from '../shared/data-model.js';
import type { CustomAttribute, CustomObject } from '../shared/custom-objects.js';
import type { Context } from './security.js';
import { filterFields } from '../shared/filters.js';

// No process cache: reads share the caller's authorized transaction on every model turn.
export async function entitySchema(ctx: Context): Promise<EntitySchema> {
  const company_attributes = (
    await ctx.tx.query<CompanyAttribute>(
      'SELECT id,name,kind,description,options,ai_enabled,guidance,archived,version FROM customer_attributes WHERE workspace_id=$1 AND NOT archived ORDER BY id',
      [ctx.workspaceId],
    )
  ).rows;
  const relationships = (
    await ctx.tx.query<RelationDefinition>(
      'SELECT id,source_object,target_object,source_label,target_label,cardinality FROM relationship_definitions WHERE workspace_id=$1 ORDER BY id',
      [ctx.workspaceId],
    )
  ).rows;
  const custom = (
    await ctx.tx.query<CustomObject>(
      'SELECT id,name,version,slug FROM custom_objects WHERE workspace_id=$1 ORDER BY id',
      [ctx.workspaceId],
    )
  ).rows;
  const fields = (
    await ctx.tx.query<CustomAttribute>(
      'SELECT id,object_id,name,description,kind,options,required,is_unique,currency,version,ai_enabled,guidance FROM custom_object_attributes WHERE workspace_id=$1 AND NOT archived ORDER BY object_id,id',
      [ctx.workspaceId],
    )
  ).rows;
  const kinds = { customers: 'company', people: 'person', projects: 'project' } as const;
  const objects: SchemaObject[] = (['customers', 'people', 'projects'] as ObjectKind[]).map(
    (id) => ({
      id,
      name: objectNames[id],
      kind: kinds[id],
      version: 1,
      attributes: systemAttributes(id).map((a): SchemaAttribute => {
        const type =
          a.valueType ||
          (a.id === 'email_count' ? 'number' : a.id === 'is_primary' ? 'checkbox' : 'text');
        const writable = !a.properties?.includes('只读');
        const labels = filterFields(id)[a.id]?.options;
        return {
          id: `${id}:${a.id}`,
          name: a.name,
          type,
          multiple: false,
          required: !!a.constraints?.includes('必填'),
          unique: !!a.constraints?.includes('唯一'),
          system: true,
          writable,
          computed: !!a.automated,
          inherited: id === 'people' && a.id === 'owner',
          extraction_supported: writable && !['actor_reference', 'record_reference'].includes(type),
          description: a.description,
          storage_key: a.id === 'contact' ? 'contact_name' : a.id === 'owner' ? 'owner_id' : a.id,
          ...(labels
            ? { options: Object.keys(labels), option_labels: labels }
            : a.options
              ? { options: a.options }
              : {}),
        };
      }),
    }),
  );
  objects[0].attributes.push(
    ...company_attributes.map((a): SchemaAttribute => ({
      id: a.id,
      name: a.name,
      ...customKindSemantics(a.kind),
      required: false,
      unique: false,
      system: false,
      writable: true,
      computed: false,
      inherited: false,
      extraction_supported: true,
      options: a.options,
      version: a.version,
      description: a.description,
      ai_enabled: a.ai_enabled,
      guidance: a.guidance,
    })),
  );
  const references: SchemaReference[] = [];
  for (const item of custom) {
    const defaults: SchemaAttribute[] = [
      {
        id: `${item.id}:id`,
        name: '记录编号',
        type: 'text',
        unique: true,
        writable: false,
        required: true,
      },
      {
        id: `${item.id}:name`,
        name: '名称',
        type: 'text',
        unique: false,
        writable: true,
        required: true,
      },
      {
        id: `${item.id}:customer_id`,
        name: '所属公司',
        type: 'record_reference',
        unique: false,
        writable: false,
        required: true,
      },
      {
        id: `${item.id}:project_id`,
        name: '关联项目',
        type: 'record_reference',
        unique: false,
        writable: true,
        required: false,
      },
      {
        id: `${item.id}:created_at`,
        name: '创建时间',
        type: 'timestamp',
        unique: false,
        writable: false,
        required: true,
      },
      {
        id: `${item.id}:created_by`,
        name: '创建人',
        type: 'actor_reference',
        unique: false,
        writable: false,
        required: true,
      },
    ].map((a) => ({
      ...a,
      multiple: false,
      system: true,
      computed: false,
      inherited: false,
      extraction_supported: a.writable && a.type === 'text',
    })) as SchemaAttribute[];
    objects.push({
      id: item.id,
      name: item.name,
      kind: 'custom',
      version: item.version,
      attributes: [
        ...defaults,
        ...fields
          .filter((a) => a.object_id === item.id)
          .map((a): SchemaAttribute => ({
            id: a.id,
            name: a.name,
            description: a.description,
            ai_enabled: a.ai_enabled,
            guidance: a.guidance,
            ...customKindSemantics(a.kind),
            required: a.required,
            unique: a.is_unique,
            system: false,
            writable: true,
            computed: false,
            inherited: false,
            extraction_supported: true,
            ...(a.kind === 'currency' ? { currency: a.currency } : {}),
            options: a.options,
            version: a.version,
          })),
      ],
    });
    for (const [target, label] of [
      ['customers', '所属公司'],
      ['projects', '关联项目'],
    ] as const)
      references.push({
        id: `custom-${target === 'customers' ? 'company' : 'project'}:${item.id}`,
        source_object: item.id,
        target_object: target,
        source_label: label,
        target_label: '',
        cardinality: 'many_to_one',
        bidirectional: false,
      });
  }
  const content = {
    entities: (['customers', 'people', 'projects'] as ObjectKind[]).map((id) => ({
      id,
      name: objectNames[id],
      attributes: systemAttributes(id),
    })),
    company_attributes,
    relationships: [...systemRelationships, ...relationships],
    objects,
    references,
    capabilities: {
      entity_types: 'registered' as const,
      custom_attributes: ['customers'] as ['customers'],
      communication_facts: 'candidates_only' as const,
      image_recognition: false as const,
      custom_records: 'read_only' as const,
    },
  };
  return {
    revision: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    ...content,
  };
}
