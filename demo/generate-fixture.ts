/**
 * Regenerate the public browser demo from a fresh, in-memory application database.
 * No environment file, persistent database, worker, provider or communication adapter is used.
 * Run from the repository root: node --import tsx demo/generate-fixture.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import request from 'supertest';
import { format, resolveConfig } from 'prettier';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import { sourceMaterials } from '../server/source-index.js';
import * as service from '../server/service.js';
import * as activities from '../server/business-activities.js';
import * as attributes from '../server/attributes.js';
import * as notes from '../server/notes.js';
import * as workflows from '../server/home-workflows.js';
import { createPerson } from '../server/people.js';
import { createDashboard } from '../server/reports.js';
import { append, createChat } from '../server/chats.js';
import { applyPreference, preparePreference } from '../server/user-preferences.js';
import {
  enqueueKnowledge,
  knowledgeGraphView,
  knowledgeView,
  syncKnowledgeOnce,
} from '../server/knowledge.js';
import {
  claimKey,
  extractSnapshot,
  type ExtractionGenerate,
} from '../server/communication-pipeline.js';
import type { KnowledgeFact, KnowledgeGraph, KnowledgeSnapshot } from '../shared/knowledge.js';
import type { ActivityModelOptions } from '../server/activity-model.js';
import type { AgentModelOptions } from '../server/agent-model.js';
import { activityBaseField as base } from '../shared/business-activities.js';
import type { BusinessActivity, ActivityTask } from '../shared/business-activities.js';
import type { ActivityAnalysisInput, ActivityAnalysisResult } from '../shared/activity-analysis.js';
import type { Customer, CustomerRecord, Person, Project } from '../shared/domain.js';
import { snapshotKey, type DemoFixture } from './types.js';

// All names, addresses, correspondence and model responses below are prepared examples.
// A reserved .invalid domain keeps every mailbox unusable for real communication.
const examples = [
  {
    name: 'Northstar 舞蹈用品',
    type: 'distributor',
    region: '英国 · 伦敦',
    contact: 'Alex Morgan',
    job: '采购经理',
    project: '秋季练功服反馈',
    projectType: 'sample',
    stage: 'waiting_customer',
  },
  {
    name: '青禾芭蕾工作室',
    type: 'group',
    region: '中国 · 上海',
    contact: '林老师',
    job: '教务负责人',
    project: '冬季汇演团服',
    projectType: 'custom',
    stage: 'in_progress',
  },
  {
    name: '星河舞蹈学校',
    type: 'group',
    region: '中国 · 杭州',
    contact: '沈老师',
    job: '采购联系人',
    project: '春季训练服样衣',
    projectType: 'sample',
    stage: 'waiting_customer',
  },
  {
    name: 'Aurora Dance',
    type: 'distributor',
    region: '法国 · 里昂',
    contact: 'Camille Laurent',
    job: '产品买手',
    project: '新系列合作评估',
    projectType: 'inquiry',
    stage: 'new',
  },
  {
    name: '小禾',
    type: 'retail',
    region: '中国 · 南京',
    contact: '小禾',
    job: '个人客户',
    project: '练功服尺码咨询',
    projectType: 'inquiry',
    stage: 'waiting_customer',
  },
  {
    name: '松林艺术中心',
    type: 'group',
    region: '中国 · 北京',
    contact: '周老师',
    job: '课程负责人',
    project: '基础款补货沟通',
    projectType: 'purchase',
    stage: 'in_progress',
  },
] as const;

// This is a prepared extraction runner, not a Graphiti or model connection. The
// real extraction validator and knowledge publication/readback contract still run.
const preparedExtraction: ExtractionGenerate = async (input) => {
  const message = input.messages[0];
  const product = message.text.match(/(?:A214|B700)/)?.[0];
  const issue = ['肩带偏长', '胸围偏紧', '面料舒适'].find((value) => message.text.includes(value));
  const project = input.known_entities.find((entity) => entity.kind === 'project');
  const output = {
    version: input.version,
    record_id: input.record_id,
    trust: 'unconfirmed' as const,
    entities: [],
    attributes: [],
    relations: [],
    changes: [],
    uncertainties: [],
  };
  if (input.channel !== 'email' || !product || !issue || !project) return output;
  const evidence = [{ message_id: message.id, quote: message.text }];
  const statement = {
    speaker_id: message.speaker_id,
    modality: 'reported',
    effective_at: null,
    evidence,
  };
  return {
    ...output,
    entities: [
      {
        ref: 'project',
        kind: 'project',
        object_id: project.object_id,
        name: project.name,
        canonical_id: project.id,
        evidence,
      },
      {
        ref: 'product',
        kind: 'subject',
        object_id: null,
        name: product,
        canonical_id: null,
        evidence,
      },
    ],
    attributes: [
      {
        id: 'feedback',
        entity_ref: 'product',
        field_id: null,
        field_label: '试穿反馈',
        value: { type: 'text', value: issue, unit: null },
        ...statement,
      },
    ],
    relations: [
      {
        id: 'product-context',
        from_ref: 'project',
        to_ref: 'product',
        definition_id: null,
        label: '反馈涉及款式',
        ...statement,
      },
    ],
    uncertainties: message.text.includes('没有注明产品修订')
      ? [{ description: '产品修订待客户补充吊牌照片后核实。', evidence }]
      : [],
  };
};

async function preparedProjection(snapshot: KnowledgeSnapshot) {
  const extracted = await extractSnapshot(snapshot, [], preparedExtraction);
  const stableId = (...parts: string[]) => {
    const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const graph: KnowledgeGraph = {
    nodes: snapshot.entities.map((entity) => ({
      key: `crm:${entity.id}`,
      id: entity.id,
      group: 'crm',
      name: entity.name,
      labels: ['Entity'],
      origin: 'crm',
      object_id: entity.object,
      attributes: entity.attributes,
      source_ids: [],
      record_ids: [],
    })),
    edges: [],
  };
  for (const relation of snapshot.relationships) {
    const definition = [
      ...snapshot.schema.relationships,
      ...(snapshot.schema.references || []),
    ].find((entry) => entry.id === relation.definition_id);
    assert(definition);
    graph.edges.push({
      key: `crm:${relation.id}`,
      id: relation.id,
      group: 'crm',
      source: `crm:${relation.source_id}`,
      target: `crm:${relation.target_id}`,
      label: definition.source_label,
      fact: JSON.stringify(definition),
      kind: 'crm_relationship',
      valid_at: null,
      invalid_at: null,
      source_ids: [],
      record_ids: [],
      project_id: null,
      trust: null,
    });
  }
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
  const facts: KnowledgeFact[] = [];
  for (const record of extracted.records) {
    const group =
      'evidence_' +
      createHash('sha256')
        .update(
          `[${record.project_id ? JSON.stringify(record.project_id) : 'null'}, ${JSON.stringify(record.trust)}]`,
        )
        .digest('hex')
        .slice(0, 32);
    const recordId = record.output.record_id;
    const identities = new Map(
      record.output.entities.map((entity) => [
        entity.ref,
        entity.canonical_id || stableId(recordId, 'entity', entity.ref),
      ]),
    );
    for (const entity of record.output.entities) {
      const id = identities.get(entity.ref)!,
        key = `${group}:${id}`;
      const existing = nodes.get(key);
      const objectId =
        entity.object_id ||
        ({ company: 'customers', person: 'people', project: 'projects' } as Record<string, string>)[
          entity.kind
        ] ||
        null;
      nodes.set(key, {
        key,
        id,
        group,
        name: entity.name,
        labels: ['Entity', entity.kind],
        origin: 'candidate',
        object_id: objectId,
        attributes: {
          canonical_id: entity.canonical_id || '',
          candidate: true,
          object_id: objectId || '',
        },
        source_ids: [...new Set([...(existing?.source_ids || []), ...record.source_ids])],
        record_ids: [...new Set([...(existing?.record_ids || []), recordId])],
      });
    }
    const names = new Map(record.output.entities.map((entity) => [entity.ref, entity.name]));
    for (const claim of [...record.output.attributes, ...record.output.relations]) {
      const id = claimKey(recordId, claim.id),
        key = `${group}:${id}`;
      const sourceIds = [...new Set(claim.evidence.map((entry) => entry.message_id))];
      const attribute = 'entity_ref' in claim;
      const label = attribute ? claim.field_label : claim.label;
      const speaker = record.input.speakers.find((entry) => entry.id === claim.speaker_id)!;
      const fact = `${speaker.name}：${label}：${
        attribute
          ? String(claim.value.value)
          : `${names.get(claim.from_ref)} → ${names.get(claim.to_ref)}`
      }`;
      nodes.set(key, {
        key,
        id,
        group,
        name: label,
        labels: ['Entity', 'Claim'],
        origin: 'claim',
        object_id: null,
        attributes: {
          ...claim,
          observed_at: [
            ...new Set(
              claim.evidence.map(
                (entry) =>
                  record.input.messages.find((message) => message.id === entry.message_id)!
                    .occurred_at,
              ),
            ),
          ],
          speaker: speaker.name,
        },
        source_ids: sourceIds,
        record_ids: [recordId],
      });
      facts.push({
        id,
        fact,
        relation: label,
        valid_at: claim.effective_at,
        invalid_at: null,
        source_ids: sourceIds,
        project_id: record.project_id,
        trust: record.trust,
      });
      graph.edges.push({
        key,
        id,
        group,
        source: `${group}:${identities.get(attribute ? claim.entity_ref : claim.from_ref)}`,
        target: attribute ? key : `${group}:${identities.get(claim.to_ref)}`,
        label,
        fact,
        kind: attribute ? 'attribute_candidate' : 'relation_candidate',
        valid_at: claim.effective_at,
        invalid_at: null,
        source_ids: sourceIds,
        record_ids: [recordId],
        project_id: record.project_id,
        trust: record.trust,
      });
    }
  }
  graph.nodes = [...nodes.values()];
  return { graph, facts, extractions: extracted.extractions };
}

const db = await openDatabase();
try {
  await migrate(db);
  const { workspaceId, actorId } = await createWorkspace(db, {
    name: 'Typha 示例工作空间',
    email: 'lin@typha-demo.invalid',
    displayName: '林然',
    // A fresh, discarded bootstrap credential is never serialized or printed.
    password: randomBytes(32).toString('hex'),
  });
  const run = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actorId, workspaceId, fn);
  const customers: Customer[] = [];
  const people: Person[] = [];
  const projects: Project[] = [];
  const noteIds: string[] = [];
  for (const [index, example] of examples.entries()) {
    const customer = (await run((ctx) =>
      service.insert(ctx, 'customers', {
        name: example.name,
        type: example.type,
        region: example.region,
        source: index === 4 ? 'store' : 'email',
        status: index === 3 ? 'potential' : 'active',
        owner_id: actorId,
        contact_name: example.contact,
        email: `contact-${index + 1}@example.invalid`,
      }),
    )) as unknown as Customer;
    customers.push(customer);
    people.push(
      await run((ctx) =>
        createPerson(ctx, {
          customer_id: customer.id,
          name: example.contact,
          job_title: example.job,
          email: customer.email,
          description: '款式、尺码与样衣反馈的主要联系人。',
        }),
      ),
    );
    const project = (await run((ctx) =>
      service.insert(ctx, 'projects', {
        customer_id: customer.id,
        name: example.project,
        type: example.projectType,
        stage: example.stage,
        owner_id: actorId,
        due_date: '2026-11-20',
        description:
          '先核实款式、尺码与产品修订，再根据已确认的信息推进；交期与调整方案尚待双方确认。',
      }),
    )) as unknown as Project;
    projects.push(project);
    const draft = await run((ctx) =>
      notes.saveNoteDraft(ctx, randomUUID(), {
        title: `${example.name} · 跟进要点`,
        customer_id: customer.id,
        project_id: project.id,
        person_ids: [people[index].id],
        note_id: null,
        base_revision: 0,
        version: 0,
        request_id: randomUUID(),
        blocks: [
          {
            id: 'followup',
            type: 'paragraph',
            origin: 'original',
            sources: [],
            text: '回复前先核对客户提到的款式、尺码和产品修订。没有写明的版本保留待核实，不将试穿建议当作已确认的生产修改。',
          },
          {
            id: 'next',
            type: 'bullet',
            origin: 'original',
            sources: [],
            text: '请客户补充正面与侧面试穿照片，再与打版同事核对测量位置。',
          },
        ],
      }),
    );
    noteIds.push(
      (
        await run((ctx) =>
          notes.publishNote(ctx, {
            request_id: randomUUID(),
            draft_id: draft.id,
            draft_version: draft.version,
            base_revision: 0,
          }),
        )
      ).id,
    );
  }

  const preference = await run((ctx) =>
    attributes.createField(ctx, {
      name: '关注款式',
      kind: 'text',
      description: '由业务员明确记录的当前关注款式。',
    }),
  );
  for (const [index, customer] of customers.entries())
    await run((ctx) =>
      attributes.saveValue(ctx, customer.id, preference.id, {
        value: index % 2 ? 'B700 基础练功服' : 'A214 吊带练功服',
        version: 0,
        attribute_version: preference.version,
      }),
    );

  const schema = await run((ctx) =>
    activities.createSchema(ctx, {
      name: '产品反馈',
      fields: [
        { name: '货号', kind: 'text', ai_enabled: true, guidance: '只取客户原话明确提到的货号。' },
        {
          name: '问题',
          kind: 'select',
          options: ['肩带偏长', '胸围偏紧', '面料舒适'],
          ai_enabled: true,
          guidance: '保留客户原话中的问题或正面评价，不推断质量结论。',
        },
        {
          name: '产品修订',
          kind: 'text',
          ai_enabled: true,
          guidance: '只取明确产品修订，未说明则留空。',
        },
        { name: '尺码', kind: 'text', ai_enabled: true, guidance: '取客户明确提到的尺码。' },
        { name: '颜色', kind: 'text', ai_enabled: true, guidance: '取客户明确提到的颜色。' },
        {
          name: '反馈阶段',
          kind: 'select',
          options: ['售后', '样衣'],
          ai_enabled: true,
          guidance: '区分样衣试穿与售后反馈。',
        },
        {
          name: '事项编号',
          kind: 'text',
          ai_enabled: true,
          guidance: '取明确事项编号，仅同客户且内容一致时用于去重。',
        },
      ],
    }),
  );
  const type = await run((ctx) =>
    activities.createType(ctx, { name: '客户产品反馈', schema_id: schema.id }),
  );
  const fields = Object.fromEntries(schema.fields.map((field) => [field.name, field.id]));
  const analysisConfig: DemoFixture['analysisConfig'] = {
    typeId: type.id,
    fields: {
      product: fields['货号'],
      issue: fields['问题'],
      version: fields['产品修订'],
      size: fields['尺码'],
      color: fields['颜色'],
      stage: fields['反馈阶段'],
      case: fields['事项编号'],
    },
  };
  const accountId = randomUUID();
  await run((ctx) =>
    ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by,enabled) VALUES($1,$2,$3,$4,$5,false)',
      [workspaceId, accountId, 'studio@typha-demo.invalid', '', actorId],
    ),
  );
  let current: Record<string, string | null> = {};
  let preparedActivityCalls = 0;
  const activityModel: ActivityModelOptions = {
    transport: {
      async generate(input) {
        preparedActivityCalls++;
        if (input.mode === 'verify')
          return {
            events: input.candidate!.events.map((event) => ({
              event_id: event.event_id,
              supported: true,
              reason: 'Prepared browser demo response',
              fields: event.fields.map((field) => ({
                field_id: field.field_id,
                supported: true,
                reason: 'Prepared browser demo response',
              })),
            })),
          };
        const source = input.sources[0];
        return {
          events: [
            {
              event_id: 'feedback',
              source_ids: [source.id],
              fields: input.fields.map((field) => {
                const value =
                  field.id === base.occurred ? source.occurred_at : (current[field.id] ?? null);
                return {
                  field_id: field.id,
                  value,
                  evidence: value === null ? [] : [{ source_id: source.id, quote: source.body }],
                };
              }),
            },
          ],
        };
      },
    },
  };
  const feedback: BusinessActivity[] = [];
  const mailIds: string[] = [];
  for (let index = 0; index < 23; index++) {
    // Two separately recorded messages explicitly refer to the same customer case.
    const key = index === 1 ? 0 : index;
    const customerIndex = key % customers.length;
    const product = key % 3 === 0 ? 'A214' : 'B700';
    const issue = ['肩带偏长', '胸围偏紧', '面料舒适'][key % 3];
    const revision = key % 6 === 0 ? null : key % 4 === 0 ? 'v1' : 'v2';
    const size = key % 2 ? 'M' : 'S';
    const color = key % 2 ? '蓝色' : '黑色';
    const stage = key % 5 === 0 ? '样衣' : '售后';
    const caseId = `FB-110${1 + (key % 9)}-${String(key + 1).padStart(2, '0')}`;
    const observation =
      issue === '肩带偏长'
        ? '做抬手和下蹲动作时，肩带会往外侧滑。想请你们先看一下肩带的测量位置，暂时不用直接修改下一批。'
        : issue === '胸围偏紧'
          ? '胸围位置比平时穿的同码略紧，抬手时有一点牵扯。我们还没有确认是尺码选择还是版型问题，能否先一起核对尺寸？'
          : '面料贴身但没有明显闷热感，课堂练习时活动比较自在。这次是正面试穿感受，暂时没有提出修改要求。';
    const body = `你好，关于 ${caseId} 的${stage === '样衣' ? '样衣试穿' : '售后使用'}反馈：\n\n我们这次试穿的是 ${product}，${color} ${size} 码。${revision ? `吊牌标注产品修订为 ${revision}。` : '手边吊牌没有注明产品修订，我会补拍照片，请先保留为待核实。'}\n${observation}\n\n请先记录为“${issue}”，${stage === '样衣' ? '这是样衣阶段的意见，还不是量产确认。' : '这是已经收到产品后的使用反馈。'}\n${examples[customerIndex].contact}`;
    current = {
      [base.title]: `${product} ${issue} · ${stage}反馈`,
      [base.summary]: observation,
      [fields['货号']]: product,
      [fields['问题']]: issue,
      [fields['产品修订']]: revision,
      [fields['尺码']]: size,
      [fields['颜色']]: color,
      [fields['反馈阶段']]: stage,
      [fields['事项编号']]: caseId,
    };
    const mailId = randomUUID();
    mailIds.push(mailId);
    await run((ctx) =>
      ctx.tx.query(
        `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason,received_after_connection)
       VALUES($1,$2,$3,'studio@typha-demo.invalid',$4,$5,$2::uuid::text,$6,$7::jsonb,$8::jsonb,'[]','[]',$9,'inbound',$10,'明确关联到本客户的示例来信',true)`,
        [
          workspaceId,
          mailId,
          accountId,
          customers[customerIndex].id,
          projects[customerIndex].id,
          `${product} ${size}码${stage}反馈：${issue}`,
          JSON.stringify([
            { address: people[customerIndex].email, name: people[customerIndex].name },
          ]),
          JSON.stringify([{ address: 'studio@typha-demo.invalid', name: 'Typha 客户服务' }]),
          `2026-11-${String(1 + (key % 10)).padStart(2, '0')}T08:00:00+08:00`,
          body,
        ],
      ),
    );
    await run((ctx) =>
      ctx.tx.query(
        'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
        [workspaceId, customers[customerIndex].id, mailId, people[customerIndex].id],
      ),
    );
    const source = (
      await run((ctx) =>
        activities.sources(ctx, { customer_id: customers[customerIndex].id, mail_id: mailId }),
      )
    )[0];
    assert(source, 'A mail must produce an accessible source Record');
    feedback.push(
      ...(
        await activities.generateActivities(
          db,
          actorId,
          workspaceId,
          {
            customer_id: customers[customerIndex].id,
            project_id: projects[customerIndex].id,
            linked_person_ids: [people[customerIndex].id],
            handler_id: actorId,
            type_id: type.id,
            source_ids: [source.id],
            request_id: randomUUID(),
          },
          activityModel,
        )
      ).activities,
    );
  }

  const tasks: ActivityTask[] = [];
  for (const [index, activityIndex] of [0, 2, 5].entries()) {
    const result = await run((ctx) =>
      activities.comment(ctx, feedback[activityIndex].id, {
        body: [
          '请先联系客户补充肩带平铺尺寸和试穿照片，再交给打版同事核对。',
          '请核对这次试穿的尺码与产品修订，保留客户原话中的待确认项。',
          '请整理这条正面试穿感受，确认可以在内部产品复盘中引用的范围。',
        ][index],
        assignee_id: actorId,
        task_title: [
          '补齐 A214 肩带反馈的测量信息',
          '核对试穿尺码与产品修订',
          '整理面料试穿的正面反馈',
        ][index],
        due_date: '2026-11-18',
        request_id: randomUUID(),
      }),
    );
    assert(result.task);
    tasks.push(result.task);
  }
  tasks[1] = await run((ctx) =>
    activities.updateTask(ctx, tasks[1].id, { version: tasks[1].version, status: 'in_progress' }),
  );

  const board = await run((ctx) =>
    createDashboard(ctx, {
      name: '售后反馈与产品改进',
      description: '按款式、版本和问题回看已记录反馈，再回到客户原话核对。',
      widgets: [],
      activity_analysis: analysisConfig,
    }),
  );
  const summaryChat = await run((ctx) =>
    createChat(ctx, {
      id: randomUUID(),
      title: '样衣与售后反馈总结 · 准备好的示例',
      customer_id: customers[0].id,
    }),
  );
  let workflow = await run((ctx) => workflows.create(ctx, summaryChat.id, { kind: 'summary' }));
  assert(workflow);
  workflow = await run((ctx) =>
    workflows.configure(ctx, summaryChat.id, {
      version: workflow!.version,
      config: {
        ...workflow!.config,
        customer_id: customers[0].id,
        source_kinds: ['mail'],
        date_start: '2026-11-01',
        date_end: '2026-11-10',
        instruction: '区分样衣与售后意见，列出缺少版本或测量依据的事项。',
      },
    }),
  );
  assert(workflow);
  let preparedSummaryCalls = 0;
  const summaryModel: AgentModelOptions = {
    transport: {
      async generate(input) {
        preparedSummaryCalls++;
        if (input.phase === 'classify')
          return {
            intent: '分析建议',
            action: 'respond',
            target: null,
            entity_type: 'company',
            match_mode: null,
            candidate_index: null,
            data_source: 'records',
            ownership: null,
            missing: [],
            reply: '按已配置范围总结客户反馈。',
            mail_action: null,
            turn_action: 'continue',
            slot_updates: [],
          };
        return {
          answer: JSON.stringify({
            body: '以下为提前准备的示例总结，用于体验真实产品界面，并非本次实时模型运行。\n\n本轮客户沟通\n\n- Northstar 对 A214 的反馈涉及肩带在动作中滑动，需要先核对平铺尺寸和试穿照片。\n- 同一事项的两条记录应合并回看，不作为两份独立反馈。\n- 没有明确产品修订的来信保持待核实；样衣意见与售后反馈分开查看。\n\n下一步\n\n1. 补齐客户的测量信息。\n2. 在反馈报告按款式、版本和阶段筛选，再回到每条活动的原文。\n3. 经双方核对后再决定是否调整版型，当前没有生产修改或交期承诺。',
            decisions: [],
            draft_body: null,
            changes: [],
          }),
          source_ids: input.snapshot.sources
            .filter((source) => source.ref)
            .slice(0, 3)
            .map((source) => source.id),
        };
      },
    },
  };
  await workflows.run(
    db,
    actorId,
    workspaceId,
    summaryChat.id,
    {
      version: workflow.version,
      request_id: randomUUID(),
      body: '打开准备好的客户反馈总结示例，列出还需要核对的事项。',
    },
    summaryModel,
  );

  const memoryChat = await run((ctx) =>
    createChat(ctx, {
      id: randomUUID(),
      title: '个人偏好 · 准备好的示例',
      customer_id: null,
    }),
  );
  for (const question of ['请记住：回答简短', '请记住：写英文邮件时语气简短直接']) {
    await run(async (ctx) => {
      const requestId = randomUUID();
      const plan = await preparePreference(ctx, { question });
      assert.equal(plan.action, 'save');
      await append(ctx, memoryChat.id, requestId, 'user', question);
      const result = await applyPreference(ctx, plan, {
        chat_id: memoryChat.id,
        request_id: requestId,
      });
      assert.equal(result.status, 'saved');
      await append(
        ctx,
        memoryChat.id,
        requestId,
        'assistant',
        `${result.instruction}\n\n这是提前准备的示例偏好，只影响本人回答与邮件文风，不是客户事实或发送授权。`,
      );
    });
  }

  const updateChat = await run((ctx) =>
    createChat(ctx, {
      id: randomUUID(),
      title: '整理客户资料建议 · 准备好的示例',
      customer_id: customers[0].id,
    }),
  );
  let updateWorkflow = await run((ctx) => workflows.create(ctx, updateChat.id, { kind: 'update' }));
  assert(updateWorkflow);
  updateWorkflow = await run((ctx) =>
    workflows.configure(ctx, updateChat.id, {
      version: updateWorkflow!.version,
      config: {
        ...updateWorkflow!.config,
        customer_id: customers[0].id,
        source_kinds: ['mail'],
        date_start: '2026-11-01',
        date_end: '2026-11-10',
        field_ids: ['contact_name'],
        instruction: '先列出主要联系人字段的修改建议，由本人确认后再保存。',
      },
    }),
  );
  assert(updateWorkflow);
  let preparedUpdateCalls = 0;
  const updateModel: AgentModelOptions = {
    transport: {
      async generate(input) {
        preparedUpdateCalls++;
        if (input.phase === 'classify')
          return {
            intent: '整理录入',
            action: 'respond',
            target: null,
            entity_type: 'company',
            match_mode: null,
            candidate_index: null,
            data_source: 'records',
            ownership: null,
            missing: [],
            reply: '先提出客户字段修改建议，等待本人确认。',
            mail_action: null,
            turn_action: 'continue',
            slot_updates: [],
          };
        return {
          answer: JSON.stringify({
            body: '以下为提前准备的示例建议，并非本次实时模型运行。\n\n根据本人本轮要求，建议将 Northstar 的主要联系人由 Alex Morgan 补充为 Alex Morgan（采购）。\n\n只提出这一项修改，保留原客户资料；请核对后再决定是否保存。',
            decisions: [
              '主要联系人称谓按本人明确要求整理；客户来信中的试穿反馈不会改写客户基础资料。',
            ],
            draft_body: null,
            changes: [
              {
                key: 'contact_name',
                value: 'Alex Morgan（采购）',
                reason: '本人明确要求补充主要联系人称谓，当前仅生成待确认建议。',
                source_ids: ['user:instruction'],
                quote: '主要联系人改为 Alex Morgan（采购）',
              },
            ],
          }),
          source_ids: input.snapshot.sources
            .filter((source) => source.ref)
            .slice(0, 1)
            .map((source) => source.id),
        };
      },
    },
  };
  const updateResult = await workflows.run(
    db,
    actorId,
    workspaceId,
    updateChat.id,
    {
      version: updateWorkflow.version,
      request_id: randomUUID(),
      body: '请把 Northstar 的主要联系人改为 Alex Morgan（采购），先给我变更建议，不要直接保存。',
    },
    updateModel,
  );
  assert.equal(updateResult.workflow.result?.changes.length, 1);
  assert.deepEqual(updateResult.workflow.result?.applied_keys, []);
  assert.equal(
    (await run((ctx) => service.customer(ctx, customers[0].id))).contact_name,
    'Alex Morgan',
  );

  let preparedKnowledgeRuns = 0;
  for (const customer of customers) {
    await run((ctx) => enqueueKnowledge(ctx, customer.id));
    await syncKnowledgeOnce(
      db,
      {
        async sync(snapshot) {
          preparedKnowledgeRuns++;
          return preparedProjection(snapshot);
        },
        async discard() {},
      },
      { workspace_id: workspaceId, customer_id: customer.id },
    );
    assert.equal((await run((ctx) => knowledgeView(ctx, customer.id))).state, 'ready');
  }
  const graph = await run((ctx) => knowledgeGraphView(ctx, customers[0].id));
  assert(graph.nodes.some((node) => node.origin === 'candidate'));
  assert(graph.edges.some((edge) => edge.kind === 'relation_candidate'));
  assert(graph.sources.length > 0);

  const origin = 'http://127.0.0.1:4173';
  const app = createApp(db, {
    origin,
    localActorId: actorId,
    development: true,
    knowledgeEnabled: true,
  });
  const snapshots: Record<string, unknown> = {};
  async function response(path: string, body?: object) {
    const test =
      body === undefined
        ? request(app).get(`/api${path}`)
        : request(app).post(`/api${path}`).send(body);
    const result = await test
      .set('host', new URL(origin).host)
      .set('origin', origin)
      .set('x-workspace-id', workspaceId);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  async function snapshot(path: string, body?: object) {
    const value = await response(path, body);
    snapshots[snapshotKey(path)] = value;
    return value;
  }
  const startup = [
    '/session',
    '/members',
    '/views',
    '/lists',
    '/custom-objects',
    '/attributes',
    '/attributes/model',
    '/agent/capabilities',
    '/agent/preferences',
    '/mail/tracking/summary',
    '/chats/page?limit=10',
    '/chats',
    '/home/overview',
    '/customers',
    '/projects',
    '/people',
    '/notes',
    '/note-templates',
    '/documents',
    '/mail/accounts',
    '/mail/messages',
    '/mail/notifications',
    '/relationships',
    '/entity-schema',
    '/reports/catalog',
    '/reports/dashboards',
    '/reports/activity-analysis/catalog',
    '/activity-types',
    '/activity-schemas',
    '/tasks',
    '/prospects/tasks',
    '/prospects',
  ];
  for (const path of startup) await snapshot(path);
  await snapshot('/attributes/customer-values', {
    customer_ids: customers.map((customer) => customer.id),
  });
  for (const customer of customers) {
    const id = customer.id;
    for (const path of [
      `/customers/${id}`,
      `/customers/${id}/projects`,
      `/customers/${id}/records`,
      `/customers/${id}/audit`,
      `/customers/${id}/knowledge`,
      `/customers/${id}/knowledge/graph`,
      `/customers/${id}/activity-status`,
      `/customers/${id}/outgoing`,
      `/activity-members?customer_id=${id}`,
      `/activities?customer_id=${id}`,
      `/activity-sources?customer_id=${id}`,
      `/people?customer_id=${id}`,
      `/mail/messages?customer_id=${id}`,
      `/notes?customer_id=${id}`,
      `/documents?customer_id=${id}`,
      `/relationships/records/customers/${id}`,
      `/relationships/records/customers/${id}/projects`,
    ])
      await snapshot(path);
    const records = snapshots[`/customers/${id}/records`] as CustomerRecord[];
    for (const record of records) await snapshot(`/customers/${id}/records/${record.id}/evidence`);
  }
  for (const [index, person] of people.entries()) {
    const customerId = person.customer_id,
      projectId = projects[index].id;
    for (const path of [
      `/people/${person.id}`,
      `/people/${person.id}/outgoing`,
      `/customers/${customerId}/projects/${projectId}`,
      `/activities?customer_id=${customerId}&person_id=${person.id}`,
      `/activities?customer_id=${customerId}&project_id=${projectId}`,
      `/mail/messages?customer_id=${customerId}&person_id=${person.id}`,
      `/mail/messages?customer_id=${customerId}&project_id=${projectId}`,
      `/relationships/records/people/${person.id}`,
      `/relationships/records/projects/${projectId}`,
      `/relationships/records/people/${person.id}/projects`,
      `/customers/${customerId}/knowledge/graph?project_id=${projectId}`,
      ...['knowledge', 'activity-status'].flatMap((endpoint) => [
        `/customers/${customerId}/${endpoint}?project_id=${projectId}`,
        `/customers/${customerId}/${endpoint}?person_id=${person.id}`,
        `/customers/${customerId}/${endpoint}?project_id=${projectId}&person_id=${person.id}`,
      ]),
    ])
      await snapshot(path);
  }
  for (const id of noteIds) {
    await snapshot(`/notes/${id}`);
    await snapshot(`/notes/${id}/versions`);
  }
  for (const id of mailIds) await snapshot(`/mail/messages/${id}`);
  for (const activity of feedback) await snapshot(`/activities/${activity.id}`);
  await snapshot(`/chats/${summaryChat.id}`);
  await snapshot(`/chats/${summaryChat.id}/workflow`);
  for (const chat of [memoryChat, updateChat]) {
    await snapshot(`/chats/${chat.id}`);
    await snapshot(`/chats/${chat.id}/workflow`);
  }
  assert.equal((snapshots['/agent/preferences'] as unknown[]).length, 2);

  const analysisAll = (await response('/reports/activity-analysis/query', {
    config: analysisConfig,
    limit: 100,
  })) as ActivityAnalysisResult;
  assert.equal(analysisAll.summary.activity_count, 23);
  assert.equal(analysisAll.summary.feedback_count, 22);
  assert.equal(analysisAll.coverage.duplicate_activity_count, 1);
  assert.equal(analysisAll.coverage.invalid_source_count, 0);
  const goldenInputs: ActivityAnalysisInput[] = [
    { config: analysisConfig, offset: 0, limit: 20 },
    { config: analysisConfig, offset: 20, limit: 20 },
    { config: analysisConfig, product: 'A214', offset: 0, limit: 20 },
    { config: analysisConfig, product: 'B700', version: 'v2', offset: 0, limit: 20 },
    { config: analysisConfig, issue: '胸围偏紧', stage: '售后', offset: 0, limit: 20 },
    { config: analysisConfig, stage: '样衣', offset: 0, limit: 20 },
    { config: analysisConfig, customerId: customers[0].id, offset: 0, limit: 20 },
    {
      config: analysisConfig,
      customerType: 'group',
      startDate: '2026-11-03',
      endDate: '2026-11-08',
      offset: 0,
      limit: 20,
    },
    { config: analysisConfig, size: 'S', color: '黑色', offset: 0, limit: 20 },
  ];
  const analysisGolden: DemoFixture['analysisGolden'] = [];
  for (const input of goldenInputs)
    analysisGolden.push({
      input,
      result: (await response('/reports/activity-analysis/query', input)) as ActivityAnalysisResult,
    });
  const sourceKeysByActivity: DemoFixture['sourceKeysByActivity'] = {};
  for (const customer of customers)
    await run(async (ctx) => {
      const materials = await sourceMaterials(ctx, customer.id);
      const rows = (
        await ctx.tx.query<
          Parameters<typeof activities.activityAnalysisSources>[0] & { id: string }
        >(
          'SELECT id,source_versions,field_provenance FROM business_activities WHERE workspace_id=$1 AND customer_id=$2',
          [workspaceId, customer.id],
        )
      ).rows;
      for (const activity of rows)
        sourceKeysByActivity[activity.id] = activities.activityAnalysisSources(
          activity,
          materials,
          [
            ...new Set([
              ...Object.values(analysisConfig.fields).filter((id): id is string => Boolean(id)),
              ...Object.keys(activity.field_provenance),
              base.title,
              base.occurred,
            ]),
          ],
        ).source_keys;
    });
  const fixture: DemoFixture = {
    version: 1,
    workspaceId,
    actorId,
    feedbackBoardId: board.id,
    summaryChatId: summaryChat.id,
    memoryChatId: memoryChat.id,
    updateChatId: updateChat.id,
    knowledgeCustomerId: customers[0].id,
    analysisConfig,
    snapshots,
    analysisAll,
    analysisGolden,
    sourceKeysByActivity,
  };
  function assertPublic(value: unknown) {
    if (typeof value === 'string')
      assert(
        !/(?:\/Users\/|\/private\/|[A-Z]:\\Users\\)/.test(value),
        'A private path must never enter the public fixture',
      );
    else if (Array.isArray(value)) value.forEach(assertPublic);
    else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        assert(
          !/^(?:password|password_hash|secret|encrypted_key|token_hash|access_token|refresh_token)$/i.test(
            key,
          ),
          `Private field ${key} must never enter the public fixture`,
        );
        assertPublic(child);
      }
  }
  assertPublic(fixture);
  const destination = new URL('./fixture.json', import.meta.url);
  await writeFile(
    destination,
    await format(JSON.stringify(fixture, null, 2) + '\n', {
      ...(await resolveConfig(destination.pathname)),
      parser: 'json',
    }),
  );
  console.log(
    JSON.stringify({
      customers: customers.length,
      people: people.length,
      projects: projects.length,
      notes: noteIds.length,
      mail: mailIds.length,
      activities: feedback.length,
      tasks: tasks.length,
      feedback: analysisAll.summary.feedback_count,
      snapshots: Object.keys(snapshots).length,
      golden_queries: analysisGolden.length,
      preparedActivityCalls,
      preparedSummaryCalls,
      preparedUpdateCalls,
      preparedKnowledgeRuns,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      externalProviderCalls: 0,
      realCommunication: false,
      persistentDatabase: false,
    }),
  );
} finally {
  await db.close();
}
