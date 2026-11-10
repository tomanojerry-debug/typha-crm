// Isolated product collection: no .env, daily database, server entry point,
// network connector, listener, worker, or provider credential discovery.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import request, { type Agent, type Response } from 'supertest';
import { createApp } from '../../server/app.js';
import { openDatabase, type Database, type Sql } from '../../server/db.js';
import type { AgentModelOptions } from '../../server/agent-model.js';
import type { MailTransport } from '../../server/mail-transport.js';
import type { SendTransport } from '../../server/smtp-transport.js';
import type { WeChatTransport } from '../../server/wechat-transport.js';
import { runOutgoing } from '../../server/outgoing.js';
import {
  outgoingEvaluationClock,
  selectEvaluationClock,
  type EvaluationClockMetadata,
} from './evaluation-clock.js';
import {
  evaluationFixture,
  evaluationIds,
  evaluationMailKey,
  evaluationPassword,
  seedEvaluationFixtures,
  sha256,
  mailByRecordId,
  type EvaluationActorKey,
} from './fixtures.js';

export type EvaluationRow = Record<string, unknown>;
export interface EvaluationJournalEntry {
  sequence: number;
  table: string;
  operation: 'insert' | 'update' | 'delete';
  before: EvaluationRow | null;
  after: EvaluationRow | null;
}
export interface EvaluationSnapshot {
  tables: Record<string, EvaluationRow[]>;
  tableHashes: Record<string, string>;
  tableCounts: Record<string, number>;
  counters: Record<string, number>;
  journal: EvaluationJournalEntry[];
  sha256: string;
  migrations: { name: string; sha256: string }[];
  primaryKeys: Record<string, string[]>;
}
export type EvaluationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface EvaluationAuthenticationEvidence {
  before: EvaluationRow;
  after: EvaluationRow;
  actor_id: string;
  workspace_id: string;
  before_status: number;
  after_status: number;
}
export type EvaluationResponse = Response & {
  authenticationEvidence: EvaluationAuthenticationEvidence;
};
export interface EvaluationFakeTransportEvent {
  sequence: number;
  synthetic_only: true;
  transport: 'fake_smtp';
  draft_id: string;
  version: number;
  workspace_id: string;
  actor_id: string;
  customer_id: string;
  person_id: string | null;
  project_id: string | null;
  account_id: string | null;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  message_id: string | null;
  attachments: { name: string; size: number; sha256: string }[];
  scheduled_at: string | null;
}
export interface EvaluationSchedulerTick {
  now: string;
  before_submissions: number;
  after_submissions: number;
  events: EvaluationFakeTransportEvent[];
  counters: Record<string, number>;
  clock: {
    scheduler_sql: 'parameterized_virtual_now';
    javascript: 'injected_outgoing_clock';
    global_date_and_timers: 'native_unchanged';
    authentication_and_sessions: 'native_unchanged';
    triggers: 'real_database_transaction_time';
  };
}
export interface EvaluationActor {
  key: EvaluationActorKey;
  id: string;
  email: string;
  role: 'admin' | 'member';
  client: Agent;
  /** Actual initial /api/session body, never a fixture assertion or cookie. */
  authenticationEvidence: EvaluationRow;
  headers: { origin: string; 'x-workspace-id': string };
  request(method: string, path: string, body?: unknown): Promise<EvaluationResponse>;
}
export interface EvaluationEnvironment {
  db: Database;
  app: ReturnType<typeof createApp>;
  fixture: typeof evaluationFixture;
  ids: Record<string, string>;
  mailByRecordId: Record<string, string>;
  actors: Record<EvaluationActorKey, EvaluationActor>;
  authenticationEvidence: Record<EvaluationActorKey, EvaluationRow>;
  fakeTransportEvents: EvaluationFakeTransportEvent[];
  fakeSubmissions: EvaluationFakeTransportEvent[];
  counters: Record<string, number>;
  origin: string;
  clock: EvaluationClockMetadata;
  snapshot(): Promise<EvaluationSnapshot>;
  actorFetch(
    actor: EvaluationActorKey,
    route: string,
    input?: { method?: string; body?: unknown },
  ): Promise<EvaluationResponse>;
  cleanup(): Promise<void>;
  /** One explicit fixture worker tick; never creates a timer or recurring job. */
  tickScheduled(now: Date): Promise<EvaluationSchedulerTick>;
  tickOutgoing(now: Date): Promise<EvaluationSchedulerTick>;
}

function clockedEvaluationDatabase(db: Database, now: string): Database {
  const wrap = (sql: Sql): Sql => ({
    query<T>(statement: string, params: unknown[] = []) {
      const hasClock = /\bnow\s*\(\s*\)/i.test(statement);
      return sql.query<T>(
        hasClock
          ? statement.replace(/\bnow\s*\(\s*\)/gi, `($${params.length + 1}::timestamptz)`)
          : statement,
        hasClock ? [...params, now] : params,
      );
    },
    exec(statement: string) {
      if (/\bnow\s*\(\s*\)/i.test(statement)) return wrap(sql).query(statement);
      return sql.exec(statement);
    },
  });
  return {
    ...wrap(db),
    transaction<T>(fn: (tx: Sql) => Promise<T>) {
      return db.transaction((tx) => fn(wrap(tx)));
    },
    close() {
      throw new Error('The fixture scheduler cannot close its backing database');
    },
  };
}

/** Stable representation preserves every column while normalizing object key order. */
export function canonicalEvaluationValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalEvaluationValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalEvaluationValue(child)]),
    );
  return value;
}
const canonicalString = (value: unknown) => JSON.stringify(canonicalEvaluationValue(value));
const identifier = (name: string) => {
  assert(/^[a-z_][a-z0-9_]*$/.test(name));
  return `"${name}"`;
};

async function migrateEvaluation(db: Database, through: 43 | 44 | 46) {
  const directory = new URL('../../server/migrations/', import.meta.url);
  const migrations: { name: string; sha256: string }[] = [];
  await db.exec(
    'CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const name of (await readdir(directory))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= through)
    .sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations(name)VALUES($1)', [name]);
    });
    migrations.push({ name, sha256: sha256(sql) });
  }
  return migrations;
}

async function publicTables(tx: Sql) {
  return (
    await tx.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
    )
  ).rows.map((row) => row.table_name);
}

async function tablePrimaryKeys(tx: Sql) {
  const keys = await tx.query<{ table_name: string; columns: string[] }>(
    `SELECT t.relname AS table_name,array_agg(a.attname ORDER BY k.ordinality) AS columns
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
     CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
     WHERE i.indisprimary AND n.nspname='public' GROUP BY t.relname ORDER BY t.relname`,
  );
  return Object.fromEntries(keys.rows.map((row) => [row.table_name, row.columns]));
}

/** Fixture-only observer records actual committed writes, including update/revert. */
async function installMutationJournal(db: Database) {
  await db.exec(`CREATE SCHEMA evaluation_capture;
    CREATE TABLE evaluation_capture.row_changes(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,table_name text NOT NULL,operation text NOT NULL,before_row jsonb,after_row jsonb);
    CREATE FUNCTION evaluation_capture.record_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evaluation_capture AS $$ BEGIN
      INSERT INTO evaluation_capture.row_changes(table_name,operation,before_row,after_row) VALUES(TG_TABLE_NAME,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
      RETURN NULL;
    END $$;
    REVOKE ALL ON SCHEMA evaluation_capture FROM PUBLIC;
    REVOKE ALL ON FUNCTION evaluation_capture.record_change() FROM PUBLIC;`);
  for (const table of await publicTables(db))
    await db.exec(
      `CREATE TRIGGER evaluation_record_change AFTER INSERT OR UPDATE OR DELETE ON public.${identifier(table)} FOR EACH ROW EXECUTE FUNCTION evaluation_capture.record_change()`,
    );
}

function countEffects(journal: EvaluationJournalEntry[], transport: Record<string, number>) {
  const counters: Record<string, number> = {
    customer_creates: 0,
    field_writes: 0,
    notes_published: 0,
    draft_writes: 0,
    draft_cancellations: 0,
    approvals: 0,
    schedules: 0,
    fake_transport_submissions: transport.fake_transport_submissions,
    activity_creates: 0,
    task_writes: 0,
    preference_writes: 0,
    source_associations: 0,
    note_draft_writes: 0,
    field_revisions: 0,
    draft_transitions: 0,
    ...transport,
  };
  for (const event of journal) {
    const { table, operation, before, after } = event;
    if (table === 'customers' && operation === 'insert') counters.customer_creates++;
    if (
      ['customer_attribute_values', 'custom_object_records'].includes(table) &&
      operation !== 'delete'
    ) {
      const beforeValue = table === 'custom_object_records' ? before?.values : before?.value;
      const afterValue = table === 'custom_object_records' ? after?.values : after?.value;
      if (operation === 'insert' || canonicalString(beforeValue) !== canonicalString(afterValue)) {
        counters.field_writes++;
        counters.field_revisions++;
      }
    }
    if (
      table === 'notes' &&
      after?.current_revision_id &&
      before?.current_revision_id !== after.current_revision_id
    )
      counters.notes_published++;
    if (table === 'outgoing_mail') {
      if (
        operation === 'insert' ||
        (operation === 'update' &&
          (before?.version !== after?.version ||
            canonicalString(before?.content) !== canonicalString(after?.content)))
      )
        counters.draft_writes++;
      if (operation === 'insert' || before?.status !== after?.status) counters.draft_transitions++;
      if (after?.status === 'cancelled' && before?.status !== 'cancelled')
        counters.draft_cancellations++;
      if (
        after?.approved_version &&
        (before?.approved_version !== after.approved_version ||
          before?.approved_at !== after.approved_at)
      )
        counters.approvals++;
      if (
        after?.status === 'scheduled' &&
        (before?.status !== 'scheduled' || before?.scheduled_at !== after.scheduled_at)
      )
        counters.schedules++;
    }
    if (table === 'business_activities' && operation === 'insert') counters.activity_creates++;
    if (table === 'activity_tasks' && operation !== 'delete') counters.task_writes++;
    if (table === 'user_preferences') counters.preference_writes++;
    if (table === 'note_drafts' && operation !== 'delete') counters.note_draft_writes++;
    if (
      ['mail_messages', 'documents', 'wechat_queries'].includes(table) &&
      before &&
      after &&
      (before.customer_id !== after.customer_id || before.project_id !== after.project_id)
    )
      counters.source_associations++;
    if (table === 'wechat_source_bindings' && operation === 'insert')
      counters.source_associations++;
  }
  return counters;
}

export function diffEvaluationSnapshots(before: EvaluationSnapshot, after: EvaluationSnapshot) {
  return [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])]
    .sort()
    .flatMap((table) => {
      if (before.tableHashes[table] === after.tableHashes[table]) return [];
      const previous = before.tables[table] || [],
        current = after.tables[table] || [];
      // A mutable owner/project/other foreign key never becomes row identity.
      // For a table without a PK use the whole row as a multiset below rather
      // than guessing which application columns might be stable.
      const primaryKey = after.primaryKeys[table] ?? before.primaryKeys[table] ?? [];
      if (!primaryKey.length) {
        const counts = (rows: EvaluationRow[]) => {
          const result = new Map<string, number>();
          for (const row of rows) {
            const value = canonicalString(row);
            result.set(value, (result.get(value) ?? 0) + 1);
          }
          return result;
        };
        const oldCounts = counts(previous),
          newCounts = counts(current);
        return [
          {
            table,
            before_count: previous.length,
            after_count: current.length,
            before_sha256: before.tableHashes[table] || sha256('[]'),
            after_sha256: after.tableHashes[table] || sha256('[]'),
            inserted: [...newCounts].reduce(
              (sum, [key, count]) => sum + Math.max(0, count - (oldCounts.get(key) ?? 0)),
              0,
            ),
            deleted: [...oldCounts].reduce(
              (sum, [key, count]) => sum + Math.max(0, count - (newCounts.get(key) ?? 0)),
              0,
            ),
            updated: 0,
          },
        ];
      }
      const key = (row: EvaluationRow) => canonicalString(primaryKey.map((column) => row[column]));
      const oldMap = new Map(previous.map((row) => [key(row), canonicalString(row)])),
        newMap = new Map(current.map((row) => [key(row), canonicalString(row)]));
      return [
        {
          table,
          before_count: previous.length,
          after_count: current.length,
          before_sha256: before.tableHashes[table] || sha256('[]'),
          after_sha256: after.tableHashes[table] || sha256('[]'),
          inserted: [...newMap.keys()].filter((k) => !oldMap.has(k)).length,
          deleted: [...oldMap.keys()].filter((k) => !newMap.has(k)).length,
          updated: [...newMap.keys()].filter(
            (k) => oldMap.has(k) && oldMap.get(k) !== newMap.get(k),
          ).length,
        },
      ];
    });
}

export async function createEvaluationEnvironment(options: {
  agent: AgentModelOptions;
  migrateThrough?: 43 | 44 | 46;
  clock?: EvaluationClockMetadata;
}): Promise<EvaluationEnvironment> {
  assert(
    options.agent.transport,
    'An explicitly supplied real/stub model transport is required; credential fallback is forbidden',
  );
  assert(
    !options.agent.apiKey && !options.agent.key,
    'Model credentials must remain in the explicitly supplied transport, never the fixture environment',
  );
  const copiedClock = structuredClone(options.clock ?? selectEvaluationClock({}, null));
  const clock = Object.freeze({ ...copiedClock, scope: Object.freeze(copiedClock.scope) });
  const outgoingClock = outgoingEvaluationClock(clock);
  const db = await openDatabase(); // Explicitly no URL and no directory, regardless of process.env.
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const migrations = await migrateEvaluation(db, options.migrateThrough ?? 46);
    await installMutationJournal(db);
    await seedEvaluationFixtures(db);
    const counters: Record<string, number> = {
      fake_transport_submissions: 0,
      fake_transport_attempts: 0,
      fake_transport_checks: 0,
      fake_mail_syncs: 0,
      fixture_wechat_reads: 0,
      fixture_wechat_resolves: 0,
      fixture_wechat_status: 0,
      fixture_wechat_open_attempts: 0,
      blocked_graph_requests: 0,
      blocked_embedding_requests: 0,
    };
    const fakeTransportEvents: EvaluationFakeTransportEvent[] = [];
    const mail: MailTransport = {
      async run() {
        counters.fake_mail_syncs++;
        throw new Error('Evaluation IMAP is fail-closed; fixture messages are already seeded');
      },
    };
    const sent = new Set<string>();
    const outgoing: SendTransport = {
      async send({ mail, email, password }) {
        counters.fake_transport_attempts++;
        assert.equal(
          password,
          'fictional-unused-code',
          'Fake SMTP rejects non-fixture credentials',
        );
        assert.equal(
          email,
          evaluationFixture.mail.account.email,
          'Fake SMTP rejects non-fixture sender accounts',
        );
        assert.equal(
          mail.workspace_id,
          evaluationIds.workspace,
          'Fake SMTP rejects foreign fixture workspaces',
        );
        assert.equal(
          mail.account_id,
          evaluationIds.mail_account,
          'Fake SMTP rejects foreign fixture account IDs',
        );
        assert(
          [...mail.to, ...mail.cc, ...mail.bcc].every((address) => address.endsWith('.invalid')),
          'Non-fictional recipient rejected by fake transport',
        );
        counters.fake_transport_submissions++;
        fakeTransportEvents.push({
          sequence: counters.fake_transport_submissions,
          synthetic_only: true,
          transport: 'fake_smtp',
          draft_id: mail.id,
          version: mail.version,
          workspace_id: mail.workspace_id,
          actor_id: mail.created_by,
          customer_id: mail.customer_id,
          person_id: mail.person_id,
          project_id: mail.project_id,
          account_id: mail.account_id,
          from: email,
          to: [...mail.to],
          cc: [...mail.cc],
          bcc: [...mail.bcc],
          subject: mail.subject,
          body: mail.body,
          message_id: mail.message_id,
          scheduled_at: mail.scheduled_at ? new Date(mail.scheduled_at).toISOString() : null,
          attachments: mail.attachments.map((attachment) => ({
            name: attachment.name,
            size: Buffer.from(attachment.content, 'base64').length,
            sha256: sha256(Buffer.from(attachment.content, 'base64')),
          })),
        });
        sent.add(mail.message_id || mail.id);
      },
      async checkSent({ mail }) {
        counters.fake_transport_checks++;
        return sent.has(mail.message_id || mail.id);
      },
    };
    const modelTransport = options.agent.transport!;
    const wechat: WeChatTransport = {
      async status() {
        counters.fixture_wechat_status++;
        return {
          state: 'ready',
          message: '隔离虚构微信fixture',
          account_key: 'fictional-evaluation-account',
        };
      },
      async resolve(identity) {
        counters.fixture_wechat_resolves++;
        return evaluationFixture.people
          .filter((person) => [person.name, person.email, person.id].includes(identity))
          .map((person) => ({
            id: person.id,
            name: person.name,
            remark: person.name,
            wechat_id: `fixture-${person.id}`,
          }));
      },
      async history(talker, start, end) {
        counters.fixture_wechat_reads++;
        assert(
          evaluationFixture.people.some((person) => person.id === talker),
          'Unknown fixture talker',
        );
        return {
          messages: evaluationFixture.records
            .filter(
              (record) =>
                record.source_kind === 'wechat' &&
                record.person_ids.includes(talker) &&
                record.occurred_at >= start &&
                record.occurred_at <= end,
            )
            .map((record) => ({
              id: record.id,
              at: record.occurred_at,
              speaker: evaluationFixture.people.find((person) => person.id === talker)!.name,
              from_me: false,
              text: record.body,
            })),
          warnings: [],
        };
      },
      async openApp() {
        counters.fixture_wechat_open_attempts++;
        throw new Error('Opening a real desktop application is forbidden in the fixture');
      },
    };
    const knowledgeSearch = {
      async search(): Promise<never> {
        counters.blocked_graph_requests++;
        throw new Error('External Graphiti is disabled in isolated product collection');
      },
    };
    const embeddings = {
      async embed(): Promise<never> {
        counters.blocked_embedding_requests++;
        throw new Error('External embedding execution is disabled in isolated product collection');
      },
    };
    const origin = 'http://127.0.0.1:3199'; // CSRF origin only; no listening application is created.
    app = createApp(db, {
      origin,
      knowledgeEnabled: false,
      knowledgeSearch,
      embeddings,
      agent: {
        transport: modelTransport,
        knowledgeSearch,
        embeddings,
        executionLimits: options.agent.executionLimits,
      },
      attributes: {
        transport: {
          async generate() {
            throw new Error('No attribute model transport supplied for this evaluation profile');
          },
        },
      },
      activities: {
        transport: {
          async generate() {
            throw new Error('No activity model transport supplied for this evaluation profile');
          },
        },
      },
      mail: { key: evaluationMailKey, transport: mail },
      outgoing: {
        key: evaluationMailKey,
        transport: outgoing,
        ...(outgoingClock ? { clock: outgoingClock } : {}),
      },
      wechat: {
        actorId: evaluationIds.boss,
        transport: wechat,
        connectorRequired: false,
        connectorBindingEnabled: false,
      },
    });
    const actors = {} as Record<EvaluationActorKey, EvaluationActor>;
    const authenticationEvidence = {} as Record<EvaluationActorKey, EvaluationRow>;
    for (const fixture of evaluationFixture.actors) {
      const key = fixture.key as EvaluationActorKey;
      const client: Agent = request.agent(app);
      const headers = { origin, 'x-workspace-id': evaluationIds.workspace };
      await client
        .post('/api/auth/login')
        .set({ origin })
        .send({ email: fixture.email, password: evaluationPassword })
        .expect(200);
      const authenticated = (await client.get('/api/session').expect(200)).body;
      assert.equal(authenticated.actor.id, fixture.id);
      assert.equal(authenticated.auth_mode, 'password');
      assert(
        authenticated.workspaces.some(
          (workspace: { id: string; role: string }) =>
            workspace.id === evaluationIds.workspace && workspace.role === fixture.role,
        ),
      );
      authenticationEvidence[key] = structuredClone(authenticated);
      actors[key] = {
        key,
        id: fixture.id,
        email: fixture.email,
        role: fixture.role as 'admin' | 'member',
        client,
        authenticationEvidence: structuredClone(authenticated),
        headers,
        async request(method, path, body) {
          assert(path.startsWith('/api/'), 'Only isolated application API paths are permitted');
          const verb = method.toLowerCase() as Lowercase<EvaluationMethod>;
          assert(
            ['get', 'post', 'put', 'patch', 'delete'].includes(verb),
            'Unsupported evaluation request method',
          );
          const before = await client.get('/api/session');
          assert.equal(
            before.status,
            200,
            'Evaluation request has no authenticated password session',
          );
          assert.equal(
            before.body.actor?.id,
            fixture.id,
            'Evaluation cookie session actor changed',
          );
          assert.equal(before.body.auth_mode, 'password');
          const pending = client[verb](path).set(headers);
          if (body !== undefined)
            pending.set('Content-Type', 'application/json').send(JSON.stringify(body));
          else if (verb !== 'get') pending.set('Content-Type', 'application/json').send({});
          const result = await pending;
          const after = await client.get('/api/session');
          return Object.assign(result, {
            authenticationEvidence: {
              before: structuredClone(before.body) as EvaluationRow,
              after: structuredClone(after.body) as EvaluationRow,
              actor_id: before.body.actor.id as string,
              workspace_id: headers['x-workspace-id'],
              before_status: before.status,
              after_status: after.status,
            },
          });
        },
      };
    }
    const baseline = Number(
      (
        await db.query<{ sequence: string }>(
          'SELECT coalesce(max(sequence),0)::text AS sequence FROM evaluation_capture.row_changes',
        )
      ).rows[0].sequence,
    );
    let closed = false;
    let schedulerTickActive = false;
    const tickScheduled = async (now: Date): Promise<EvaluationSchedulerTick> => {
      assert(!closed, 'Evaluation environment has been closed');
      assert(
        now instanceof Date && Number.isFinite(now.getTime()),
        'An explicit valid fixture scheduler time is required',
      );
      assert(!schedulerTickActive, 'Only one fixture scheduler tick may run in this environment');
      const clock = now.toISOString(),
        before = counters.fake_transport_submissions,
        tickMilliseconds = now.getTime();
      schedulerTickActive = true;
      try {
        await runOutgoing(clockedEvaluationDatabase(db, clock), {
          key: evaluationMailKey,
          transport: outgoing,
          clock: () => tickMilliseconds,
        });
      } finally {
        schedulerTickActive = false;
      }
      return {
        now: clock,
        before_submissions: before,
        after_submissions: counters.fake_transport_submissions,
        events: structuredClone(fakeTransportEvents.slice(before)),
        counters: { ...counters },
        clock: {
          scheduler_sql: 'parameterized_virtual_now',
          javascript: 'injected_outgoing_clock',
          global_date_and_timers: 'native_unchanged',
          authentication_and_sessions: 'native_unchanged',
          triggers: 'real_database_transaction_time',
        },
      };
    };
    return {
      db,
      app,
      fixture: evaluationFixture,
      ids: { ...evaluationIds },
      mailByRecordId,
      actors,
      authenticationEvidence,
      fakeTransportEvents,
      fakeSubmissions: fakeTransportEvents,
      counters,
      origin,
      clock,
      tickScheduled,
      tickOutgoing: tickScheduled,
      actorFetch(actor, route, input = {}) {
        return actors[actor].request(input.method || 'GET', route, input.body);
      },
      async snapshot() {
        assert(!closed, 'Evaluation environment has been closed');
        return db.transaction(async (tx) => {
          const tables: Record<string, EvaluationRow[]> = {},
            tableHashes: Record<string, string> = {},
            tableCounts: Record<string, number> = {};
          for (const table of await publicTables(tx)) {
            const rows = (await tx.query(`SELECT * FROM public.${identifier(table)}`)).rows
              .map((row) => canonicalEvaluationValue(row) as EvaluationRow)
              .sort((a, b) => canonicalString(a).localeCompare(canonicalString(b)));
            tables[table] = rows;
            tableCounts[table] = rows.length;
            tableHashes[table] = sha256(canonicalString(rows));
          }
          const journal = (
            await tx.query<{
              sequence: string;
              table: string;
              operation: EvaluationJournalEntry['operation'];
              before: EvaluationRow | null;
              after: EvaluationRow | null;
            }>(
              'SELECT sequence::text,table_name AS table,operation,before_row AS before,after_row AS after FROM evaluation_capture.row_changes WHERE sequence>$1 ORDER BY sequence',
              [baseline],
            )
          ).rows.map((row) => ({
            ...row,
            sequence: Number(row.sequence),
            before: canonicalEvaluationValue(row.before) as EvaluationRow | null,
            after: canonicalEvaluationValue(row.after) as EvaluationRow | null,
          }));
          const effects = countEffects(journal, counters);
          const primaryKeys = await tablePrimaryKeys(tx);
          return {
            tables,
            tableHashes,
            tableCounts,
            counters: effects,
            journal,
            sha256: sha256(canonicalString({ tables, primaryKeys, counters: effects, journal })),
            migrations,
            primaryKeys,
          };
        });
      },
      async cleanup() {
        if (closed) return;
        closed = true;
        await app!.locals.agentRuns.stop();
        await db.close();
      },
    };
  } catch (error) {
    if (app) await app.locals.agentRuns.stop().catch(() => {});
    await db.close();
    throw error;
  }
}
