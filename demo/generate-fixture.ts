/** Capture startup API responses from a new, empty in-memory workspace. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase } from '../server/db.js';
import { snapshotKey, type DemoFixture } from './types.js';

const startupPaths = [
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

const db = await openDatabase();
try {
  await migrate(db);
  const { workspaceId, actorId } = await createWorkspace(db, {
    name: 'Typha 在线工作空间',
    email: 'admin@typha-demo.invalid',
    displayName: '管理员',
    password: randomBytes(32).toString('hex'),
  });
  const origin = 'http://127.0.0.1:4173';
  const app = createApp(db, { origin, localActorId: actorId, development: true });
  const snapshots: Record<string, unknown> = {};
  for (const path of startupPaths) {
    const result = await request(app)
      .get(`/api${path}`)
      .set('host', new URL(origin).host)
      .set('origin', origin)
      .set('x-workspace-id', workspaceId);
    assert.equal(result.status, 200, path);
    snapshots[snapshotKey(path)] = result.body;
  }
  const fixture: DemoFixture = {
    version: 1,
    workspaceId,
    actorId,
    feedbackBoardId: '',
    summaryChatId: '',
    memoryChatId: '',
    updateChatId: '',
    knowledgeCustomerId: '',
    analysisConfig: { typeId: '', fields: { product: '', issue: '' } },
    snapshots,
    analysisAll: {
      summary: { feedback_count: 0, customer_count: 0, activity_count: 0, source_count: 0 },
      groups: { product: [], issue: [], version: [], size: [], color: [], stage: [] },
      coverage: {
        scanned_count: 0,
        invalid_source_count: 0,
        unknown_date_count: 0,
        unknown_date_excluded_count: 0,
        pending_review_count: 0,
        duplicate_activity_count: 0,
        missing_values: {},
        deduplication: '',
        max_activities: 5000,
      },
      rows: [],
      total: 0,
      offset: 0,
      limit: 30,
    },
    analysisGolden: [],
    sourceKeysByActivity: {},
  };
  await writeFile(
    new URL('./fixture.json', import.meta.url),
    JSON.stringify(fixture, null, 2) + '\n',
  );
} finally {
  await db.close();
}
