// This module only prepares fictional fixtures in a supplied disposable database.
// It never reads configuration, opens storage, connects transports, or runs models.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fixtureData from '../../evals/light-crm-v1/fixtures.json' with { type: 'json' };
import type { Database, Sql } from '../../server/db.js';
import { hashPassword } from '../../server/security.js';
import { seal } from '../../server/mail-secrets.js';

export const evaluationFixture = fixtureData;
export type EvaluationFixture = typeof fixtureData;
export type EvaluationActorKey = 'boss' | 'export' | 'domestic';
export const evaluationPassword = 'disposable-fictional-evaluation-password';
export const evaluationMailKey = Buffer.alloc(32, 0x65);
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function fixtureId(label: string) {
  const h = sha256(`light-crm-v1:${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const evaluationIds: Record<string, string> = {
  ...fixtureData.ids,
  document: fixtureData.documents[0].id,
  custom_object: fixtureData.custom_objects[0].id,
  custom_record: fixtureData.custom_records[0].id,
  activity_schema: fixtureData.activities.schema_id,
  activity_type: fixtureData.activities.type_id,
  activity_task: fixtureData.activities.task_id,
};
export const mailByRecordId = Object.fromEntries(
  fixtureData.records
    .filter((r) => r.source_kind === 'email')
    .map((r) => [r.id, fixtureId(`mail:${r.id}`)]),
);
evaluationIds.mail_latest = mailByRecordId[fixtureData.ids.export_latest_record];
evaluationIds.mail_old = mailByRecordId[fixtureData.ids.export_old_record];
evaluationIds.mail_injection = mailByRecordId[fixtureData.ids.injection_record];

// Identifiers are code-owned constants; all fixture values remain SQL parameters.
async function insert(tx: Sql, table: string, data: Record<string, unknown>) {
  assert(/^[a-z_]+$/.test(table));
  const columns = Object.keys(data);
  assert(columns.every((key) => /^[a-z_][a-z0-9_]*$/.test(key)));
  await tx.query(
    `INSERT INTO ${table}(${columns.map((key) => `"${key}"`).join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(data).map((value) =>
      value && typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value,
    ),
  );
}

/** A deterministic valid, uncompressed DOCX; its stored bytes and hash are real. */
export function fictionalDocx(text: string) {
  const xml = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const entries = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${xml}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    ],
  ];
  let offset = 0;
  const local: Buffer[] = [],
    central: Buffer[] = [];
  for (const [name, value] of entries) {
    const filename = Buffer.from(name),
      body = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, body);
    central.push(directory, filename);
    offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function seedEvaluationFixtures(db: Database) {
  const f = fixtureData,
    w = f.ids.workspace,
    boss = f.ids.boss,
    stamp = f.clock;
  assert.equal(f.synthetic_only, true);
  for (const record of f.records)
    assert.equal(sha256(record.body), record.source_hash, `Fixture body hash: ${record.id}`);
  const passwordHash = await hashPassword(evaluationPassword);
  await db.transaction(async (tx) => {
    await insert(tx, 'workspaces', { ...f.workspace, created_at: stamp });
    await insert(tx, 'workspaces', {
      id: f.ids.other_workspace,
      name: '独立虚构隔离空间',
      created_at: stamp,
    });
    for (const actor of f.actors) {
      await insert(tx, 'users', {
        id: actor.id,
        email: actor.email,
        display_name: { boss: '虚构老板', export: '虚构外贸', domestic: '虚构国内' }[actor.key],
        password_hash: passwordHash,
        created_at: stamp,
      });
      await insert(tx, 'memberships', { workspace_id: w, actor_id: actor.id, role: actor.role });
    }
    await tx.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [w, boss],
    );
    for (const customer of f.customers) {
      await insert(tx, 'customers', {
        workspace_id: w,
        id: customer.id,
        name: customer.name,
        type: customer.type,
        source: 'other',
        region: customer.region,
        owner_id: customer.owner_id,
        created_at: stamp,
        updated_at: stamp,
      });
      for (const [actor_id, access] of Object.entries(customer.acl))
        await insert(tx, 'customer_access', {
          workspace_id: w,
          customer_id: customer.id,
          actor_id,
          access,
        });
    }
    for (const person of f.people)
      await insert(tx, 'people', {
        workspace_id: w,
        ...person,
        created_at: stamp,
        updated_at: stamp,
      });
    for (const project of f.projects)
      await insert(tx, 'projects', {
        workspace_id: w,
        ...project,
        created_at: stamp,
        updated_at: stamp,
      });
    for (const object of f.custom_objects)
      await insert(tx, 'custom_objects', {
        workspace_id: w,
        id: object.id,
        name: object.name,
        singular_name: object.name,
        slug: object.key,
        icon: 'table',
        color: 'gray',
        created_at: stamp,
      });
    for (const field of f.manual_field_definitions) {
      const common = {
        workspace_id: w,
        id: field.id,
        name: field.name,
        kind: field.kind,
        ai_enabled: field.ai_enabled,
        guidance: field.guidance,
        created_at: stamp,
      };
      if (field.object === 'customers') await insert(tx, 'customer_attributes', common);
      else
        await insert(tx, 'custom_object_attributes', {
          ...common,
          object_id: f.custom_objects.find((o) => o.key === field.object)!.id,
        });
    }
    for (const value of f.field_values) {
      if (
        value.provenance === null ||
        f.manual_field_definitions.find((field) => field.id === value.field_id)?.object !==
          'customers'
      )
        continue;
      await insert(tx, 'customer_attribute_values', {
        workspace_id: w,
        customer_id: value.customer_id,
        attribute_id: value.field_id,
        id: fixtureId(`value:${value.customer_id}:${value.field_id}`),
        value: JSON.stringify(value.value),
        origin: value.provenance,
        updated_at: stamp,
      });
    }
    for (const record of f.custom_records)
      await insert(tx, 'custom_object_records', {
        workspace_id: w,
        id: record.id,
        object_id: record.object_id,
        customer_id: record.customer_id,
        project_id: record.project_id,
        name: record.name,
        values: record.values,
        field_provenance: Object.fromEntries(
          Object.keys(record.provenance).map((key) => [key, { origin: 'manual' }]),
        ),
        created_by: f.ids.domestic,
        created_at: stamp,
        updated_at: stamp,
      });
    await insert(tx, 'mail_accounts', {
      workspace_id: w,
      id: f.mail.account.id,
      email: f.mail.account.email,
      connected_by: f.mail.account.connected_by,
      secret: seal('fictional-unused-code', evaluationMailKey, `${w}:${f.mail.account.id}`),
      created_at: stamp,
    });
    // This disposable seed owns fixed Record identities. Pause only the automatic
    // mail Record creator inside this transaction; audit and all constraints stay
    // active, and the trigger is restored before the seed can commit.
    await tx.exec('ALTER TABLE mail_messages DISABLE TRIGGER record_from_mail');
    for (const record of f.records.filter((r) => r.source_kind === 'email')) {
      const person = f.people.find((p) => p.id === record.person_ids[0])!;
      await insert(tx, 'mail_messages', {
        workspace_id: w,
        id: mailByRecordId[record.id],
        account_id: f.mail.account.id,
        account_email: f.mail.account.email,
        customer_id: record.customer_id,
        project_id: record.project_id,
        fingerprint: record.source_hash,
        subject: record.id === f.ids.injection_record ? '虚构恶意指令来信' : '虚构样衣询盘',
        sender: [{ name: person.name, address: person.email }],
        recipients: [{ name: '虚构发件账号', address: f.mail.account.email }],
        cc: [],
        participants: [person.email, f.mail.account.email],
        occurred_at: record.occurred_at,
        direction: 'inbound',
        body: record.body,
        match_reason: 'fictional evaluation fixture',
        created_at: stamp,
      });
    }
    await tx.exec('ALTER TABLE mail_messages ENABLE TRIGGER record_from_mail');
    for (const record of f.records) {
      await insert(tx, 'customer_records', {
        workspace_id: w,
        id: record.id,
        customer_id: record.customer_id,
        project_id: record.project_id,
        kind: record.kind,
        body: record.body,
        source_kind: record.source_kind,
        source_mail_id: mailByRecordId[record.id] || null,
        occurred_at: record.occurred_at,
        created_by: boss,
        created_at: record.occurred_at,
      });
      if (record.source_kind === 'email')
        for (const person_id of record.person_ids)
          await insert(tx, 'mail_people', {
            workspace_id: w,
            customer_id: record.customer_id,
            message_id: mailByRecordId[record.id],
            person_id,
          });
      if (record.source_kind === 'wechat')
        await insert(tx, 'knowledge_wechat_evidence', {
          workspace_id: w,
          customer_id: record.customer_id,
          id: fixtureId(`wechat:${record.id}`),
          source_key: `fixture:${record.id}`,
          record_id: record.id,
          project_id: record.project_id,
          person_id: record.person_ids[0] || null,
          occurred_at: record.occurred_at,
          speaker: f.people.find((p) => p.id === record.person_ids[0])?.name || '虚构客户',
          body: record.body,
          created_by: boss,
          message_id: record.id,
          from_me: false,
        });
    }
    for (const document of f.documents) {
      const body = f.records.find((r) => r.id === document.record_id)!.body,
        bytes = fictionalDocx(body);
      await insert(tx, 'documents', {
        workspace_id: w,
        id: document.id,
        uploaded_by: boss,
        task_actor_id: boss,
        request_id: fixtureId(`document-request:${document.id}`),
        customer_id: document.customer_id,
        project_id: document.project_id,
        record_id: document.record_id,
        name: document.filename,
        format: 'docx',
        size: bytes.length,
        content_hash: sha256(bytes),
        original_base64: bytes.toString('base64'),
        status: 'ready',
        sections: [{ label: '第 1 段', text: body }],
        created_at: stamp,
        updated_at: stamp,
      });
    }
    await insert(tx, 'mail_templates', {
      workspace_id: w,
      actor_id: f.mail.template.actor_id,
      id: f.mail.template.id,
      request_id: fixtureId('template-request'),
      scope: f.mail.template.scope,
      customer_id: f.mail.template.customer_id,
      name: '虚构样衣询盘模板',
      subject: f.mail.template.subject,
      body: f.mail.template.body,
      created_at: stamp,
    });
    const draft = f.mail.draft;
    await insert(tx, 'outgoing_mail', {
      workspace_id: w,
      id: draft.id,
      customer_id: draft.customer_id,
      person_id: draft.person_id,
      project_id: draft.project_id,
      created_by: draft.created_by,
      account_id: f.mail.account.id,
      version: draft.version,
      status: draft.status,
      content: {
        to: draft.to,
        cc: [],
        bcc: [],
        subject: draft.subject,
        body: draft.body,
        attachments: [],
      },
      created_at: stamp,
      updated_at: stamp,
    });
    for (const note of f.notes) {
      const refs = [];
      for (const record_id of note.source_ids) {
        const source_hash = (
          await tx.query<{ hash: string }>('SELECT crm_note_source_hash($1,$2) AS hash', [
            w,
            record_id,
          ])
        ).rows[0].hash;
        assert.match(source_hash, /^[a-f0-9]{64}$/);
        refs.push({
          record_id,
          source_hash,
          quote: f.records.find((r) => r.id === record_id)!.body,
        });
      }
      const content = {
        title: '虚构样衣沟通笔记',
        customer_id: note.customer_id,
        project_id: note.project_id,
        person_ids: [],
        blocks: [
          {
            id: 'fixture-note-block',
            type: 'paragraph',
            text: note.body,
            origin: 'derived',
            sources: refs,
          },
        ],
      };
      const revisionId = fixtureId(`note-revision:${note.id}`);
      await insert(tx, 'notes', {
        workspace_id: w,
        id: note.id,
        customer_id: note.customer_id,
        created_by: note.created_by,
        created_at: stamp,
        updated_at: stamp,
      });
      await insert(tx, 'note_revisions', {
        workspace_id: w,
        customer_id: note.customer_id,
        note_id: note.id,
        id: revisionId,
        version: note.revision,
        title: content.title,
        project_id: note.project_id,
        blocks: content.blocks,
        title_sources: [],
        content_hash: sha256(JSON.stringify({ ...content, title_sources: [] })),
        created_by: note.created_by,
        created_at: stamp,
      });
      for (const ref of refs)
        await insert(tx, 'note_source_refs', {
          workspace_id: w,
          customer_id: note.customer_id,
          revision_id: revisionId,
          record_id: ref.record_id,
          source_hash: ref.source_hash,
        });
      await tx.query(
        'UPDATE notes SET current_revision_id=$3,version=1 WHERE workspace_id=$1 AND id=$2',
        [w, note.id, revisionId],
      );
    }
    const a = f.activities,
      activityId = fixtureId('activity'),
      runId = fixtureId('activity-run'),
      commentId = fixtureId('activity-comment');
    await insert(tx, 'activity_schemas', {
      workspace_id: w,
      id: a.schema_id,
      name: '客户业务沟通',
      fields: [],
      created_at: stamp,
      updated_at: stamp,
    });
    await insert(tx, 'activity_types', {
      workspace_id: w,
      id: a.type_id,
      name: '售后沟通',
      schema_id: a.schema_id,
      fields: [],
      created_at: stamp,
      updated_at: stamp,
    });
    await insert(tx, 'activity_runs', {
      workspace_id: w,
      customer_id: a.task_customer_id,
      id: runId,
      actor_id: boss,
      request_id: fixtureId('activity-request'),
      input_digest: sha256('fictional activity input'),
      config_digest: sha256('fictional activity config'),
      type_id: a.type_id,
      state: 'completed',
      lease_token: fixtureId('activity-lease'),
      source_ids: [f.ids.domestic_record],
      snapshot: { synthetic_only: true },
      created_at: stamp,
      updated_at: stamp,
    });
    await insert(tx, 'business_activities', {
      workspace_id: w,
      customer_id: a.task_customer_id,
      id: activityId,
      project_id: f.ids.domestic_project,
      type_id: a.type_id,
      run_id: runId,
      event_key: 'fictional-after-sales',
      type_name: '售后沟通',
      title: '虚构袖口试穿反馈',
      summary: f.records.find((r) => r.id === f.ids.domestic_record)!.body,
      occurred_at: stamp,
      handler_id: a.task_assignee,
      fields: [],
      values: {},
      ai_values: {},
      field_provenance: {},
      source_versions: [],
      created_by: boss,
      created_at: stamp,
      updated_at: stamp,
    });
    await insert(tx, 'activity_comments', {
      workspace_id: w,
      customer_id: a.task_customer_id,
      id: commentId,
      activity_id: activityId,
      body: '请核对袖口反馈，退款尚未批准（全虚构）',
      created_by: boss,
      request_id: fixtureId('activity-comment-request'),
      created_at: stamp,
    });
    await insert(tx, 'activity_tasks', {
      workspace_id: w,
      customer_id: a.task_customer_id,
      id: a.task_id,
      activity_id: activityId,
      comment_id: commentId,
      project_id: f.ids.domestic_project,
      title: '核对虚构袖口反馈',
      assignee_id: a.task_assignee,
      created_by: boss,
      created_at: stamp,
      updated_at: stamp,
    });
  });
}
