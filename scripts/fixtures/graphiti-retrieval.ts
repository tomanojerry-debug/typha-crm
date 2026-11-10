// Entirely invented messages. Shared by controlled integration tests and the
// opt-in live probe; never opens or imports rows into the user's CRM database.
import { randomUUID } from 'node:crypto';
import type { Database } from '../../server/db.js';
import { createWorkspace } from '../../server/bootstrap.js';
import { scoped } from '../../server/security.js';
import { insert } from '../../server/service.js';
import { createPerson } from '../../server/people.js';
import { knowledgeSnapshot } from '../../server/knowledge.js';
import type { CommunicationExtractionInput } from '../../server/communication-extraction.js';
import type { ExtractionGenerate } from '../../server/communication-pipeline.js';

export const retrievalFixture = {
  company: '晨汐芭蕾学院（虚构召回验收）',
  project: '晨汐冬演采购（虚构）',
  contact: '沈召回甲（虚构）',
  secondContact: '沈召回乙（虚构）',
  keyword: 'LUNAR-MESH-731',
  comfort: '贴身里料采用柔软亲肤无缝棉质层，避免活动时摩擦皮肤',
  semanticQuestion: '孩子跳舞时怕身上被磨红，衣服里面该怎么处理？',
  keywordQuestion: 'LUNAR-MESH-731 的要求是什么？',
  correctionQuestion: '晨汐冬演采购最初说多少件、后来纠正为多少件？是否公司已承诺？',
  sentinels: [
    'OTHER_PERSON_PRIVATE_999',
    'OTHER_PROJECT_PRIVATE_777',
    'OTHER_CUSTOMER_PRIVATE_555',
    'OTHER_WORKSPACE_PRIVATE_333',
  ],
} as const;

export async function seedRetrievalFixture(db: Database, noiseCount = 82) {
  const seed = await createWorkspace(db, {
    name: '完全虚构混合召回验收',
    email: `retrieval-${randomUUID()}@example.invalid`,
    displayName: '合成验收员',
    password: 'synthetic-retrieval-password',
  });
  const run = <T>(fn: Parameters<typeof scoped<T>>[3]) =>
    scoped(db, seed.actorId, seed.workspaceId, fn);
  const customer = String(
    (
      await run((ctx) =>
        insert(ctx, 'customers', {
          name: retrievalFixture.company,
          type: 'group',
          source: 'email',
        }),
      )
    ).id,
  );
  const project = String(
    (
      await run((ctx) =>
        insert(ctx, 'projects', {
          customer_id: customer,
          name: retrievalFixture.project,
          type: 'purchase',
        }),
      )
    ).id,
  );
  const otherProject = String(
    (
      await run((ctx) =>
        insert(ctx, 'projects', {
          customer_id: customer,
          name: '另一项目（虚构隔离哨兵）',
          type: 'sample',
        }),
      )
    ).id,
  );
  const person = (
    await run((ctx) =>
      createPerson(ctx, {
        customer_id: customer,
        name: retrievalFixture.contact,
        email: 'retrieval-a@example.invalid',
      }),
    )
  ).id;
  const secondPerson = (
    await run((ctx) =>
      createPerson(ctx, {
        customer_id: customer,
        name: retrievalFixture.secondContact,
        email: 'retrieval-b@example.invalid',
      }),
    )
  ).id;
  const otherCustomer = String(
    (
      await run((ctx) =>
        insert(ctx, 'customers', {
          name: '其他客户（虚构隔离哨兵）',
          type: 'group',
          source: 'email',
        }),
      )
    ).id,
  );
  const account = randomUUID();
  await run((ctx) =>
    ctx.tx.query(
      `INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by,enabled)
    VALUES($1,$2,'retrieval-disabled@example.invalid','synthetic-invalid-unused',$3,false)`,
      [seed.workspaceId, account, seed.actorId],
    ),
  );
  const mailIds: string[] = [];
  async function mail(
    body: string,
    day: number,
    c = customer,
    p: string | null = project,
    who = person,
  ) {
    const id = randomUUID();
    const occurred = new Date(Date.UTC(2026, 0, 1) + day * 86400000).toISOString();
    await run(async (ctx) => {
      await ctx.tx.query(
        `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,
      fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
      VALUES($1,$2,$3,'retrieval-disabled@example.invalid',$4,$5,$10,$6,$7,'[]','[]','[]',$8,'inbound',$9,'email')`,
        [
          seed.workspaceId,
          id,
          account,
          c,
          p,
          `完全虚构邮件第${day}封`,
          JSON.stringify([
            {
              name:
                who === secondPerson ? retrievalFixture.secondContact : retrievalFixture.contact,
              address:
                who === secondPerson
                  ? 'retrieval-b@example.invalid'
                  : 'retrieval-a@example.invalid',
            },
          ]),
          occurred,
          body,
          id,
        ],
      );
      if (c === customer)
        await ctx.tx.query(
          'INSERT INTO mail_people(workspace_id,message_id,person_id,customer_id) VALUES($1,$2,$3,$4)',
          [seed.workspaceId, id, who, c],
        );
    });
    mailIds.push(id);
    return id;
  }
  const oldMail = await mail(
    '晨汐冬演采购最初预计采购100件；这只是客户要求，尚未得到公司确认。',
    0,
  );
  const revisedMail = await mail(
    '纠正晨汐冬演采购的数量：原先100件改为80件；这只是客户请求，并非公司承诺。',
    1,
  );
  const comfortMail = await mail(
    `面料代码${retrievalFixture.keyword}；${retrievalFixture.comfort}。这是客户要求，待公司评估。`,
    2,
  );
  for (let i = 0; i < noiseCount; i++)
    await mail(
      `虚构日常往来${i + 1}：本周练习安排记录为日程编号N-${String(i + 1).padStart(3, '0')}；没有新增采购条件。`,
      3 + i,
    );
  await mail(
    `${retrievalFixture.keyword}：${retrievalFixture.sentinels[0]}，另一个联系人独有的报价信息。`,
    100,
    customer,
    project,
    secondPerson,
  );
  await mail(
    `${retrievalFixture.keyword}：${retrievalFixture.sentinels[1]}，另一个项目独有的打样条件。`,
    101,
    customer,
    otherProject,
    person,
  );
  await mail(
    `${retrievalFixture.keyword}：${retrievalFixture.sentinels[2]}，其他客户独有的优惠。`,
    102,
    otherCustomer,
    null,
  );
  const foreign = await createWorkspace(db, {
    name: '另一空间（完全虚构）',
    email: `retrieval-foreign-${randomUUID()}@example.invalid`,
    displayName: '另一个验收员',
    password: 'synthetic-retrieval-password',
  });
  const foreignCustomer = String(
    (
      await scoped(db, foreign.actorId, foreign.workspaceId, (ctx) =>
        insert(ctx, 'customers', { name: '另一空间客户（虚构）', type: 'group', source: 'other' }),
      )
    ).id,
  );
  await scoped(db, foreign.actorId, foreign.workspaceId, (ctx) =>
    insert(ctx, 'customer_records', {
      customer_id: foreignCustomer,
      kind: 'customer_quote',
      body: retrievalFixture.sentinels[3],
      created_by: foreign.actorId,
    }),
  );
  const snapshot = await run((ctx) => knowledgeSnapshot(ctx, customer));
  const recordFor = (id: string) =>
    snapshot.sources.find((s) => s.message_id === id || s.id === `mail:${id}`)?.record_id;
  const oldRecord = recordFor(oldMail),
    revisedRecord = recordFor(revisedMail),
    comfortRecord = recordFor(comfortMail);
  if (!oldRecord || !revisedRecord || !comfortRecord)
    throw new Error('Synthetic mail Record trigger unavailable');
  return {
    ...seed,
    customer,
    project,
    otherProject,
    person,
    secondPerson,
    otherCustomer,
    foreign,
    foreignCustomer,
    account,
    mailIds,
    oldRecord,
    revisedRecord,
    comfortRecord,
    recordCount: new Set(snapshot.sources.map((s) => s.record_id)).size,
  };
}

export const deterministicRetrievalExtraction: ExtractionGenerate = async (
  input: CommunicationExtractionInput,
) => {
  const message = input.messages[0];
  const project = input.known_entities.find((e) => e.kind === 'project');
  const company = input.known_entities.find((e) => e.kind === 'company')!;
  const subject = project || company;
  const evidence = [{ message_id: message.id, quote: message.text }];
  const correction = message.text.startsWith('纠正');
  const quantity = correction ? 80 : message.text.includes('最初预计采购100件') ? 100 : null;
  const field =
    quantity !== null
      ? '采购数量'
      : message.text.includes(retrievalFixture.keyword)
        ? '面料与贴身里料要求'
        : '日常安排';
  const old = correction
    ? input.prior_claims.find(
        (p) => p.description.includes('采购数量') && p.description.includes('100'),
      )
    : null;
  if (correction && !old)
    throw new Error('Synthetic correction must refer to validated prior claim');
  return {
    version: input.version,
    record_id: input.record_id,
    trust: 'unconfirmed',
    entities: [
      {
        ref: 'subject',
        kind: subject.kind,
        object_id: subject.object_id,
        name: subject.name,
        canonical_id: subject.id,
        evidence,
      },
    ],
    attributes: [
      {
        id: 'claim',
        entity_ref: 'subject',
        field_id: null,
        field_label: field,
        value:
          quantity !== null
            ? { type: 'number', value: quantity, unit: '件' }
            : { type: 'text', value: message.text, unit: null },
        speaker_id: message.speaker_id,
        modality: quantity === 100 ? 'estimated' : 'requested',
        effective_at: null,
        evidence,
      },
    ],
    relations: [],
    changes: old
      ? [{ new_claim_id: 'claim', old_claim_id: old.id, kind: 'explicit_correction', evidence }]
      : [],
    uncertainties: [],
  };
};
