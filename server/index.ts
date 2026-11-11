import { createLocalWeChatTransport } from './wechat-transport.js';
import 'dotenv/config';
import { graphitiTransport } from './graphiti-transport.js';
import { graphitiSearchTransport } from './graphiti-search-transport.js';
import { localEmbeddingTransport } from './local-embedding-transport.js';
import { startSourceIndexWorker } from './source-index.js';
import { startKnowledgeWorker } from './knowledge.js';
import express from 'express';
import { z } from 'zod';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { migrate, openDatabase } from './db.js';
import { mountDevelopment } from './frontend.js';
import { validateLocalAccess } from './local-access.js';
import { mailKey } from './mail-secrets.js';
import { startMailWorker } from './mail.js';
import { startOutgoingWorker } from './outgoing.js';
import { startDocumentWorker } from './documents.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '127.0.0.1';
const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
if (production && !origin.startsWith('https://'))
  throw new Error('生产运行必须配置 HTTPS APP_ORIGIN');
const localAccessEmail = process.env.LOCAL_ACCESS_EMAIL?.trim().toLowerCase();
if (localAccessEmail) {
  validateLocalAccess({
    development: !production,
    origin,
    host,
    databaseUrl: process.env.DATABASE_URL,
  });
}
const whatsappSettings = {
  appSecret: process.env.WHATSAPP_APP_SECRET?.trim(),
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim(),
  wabaId: process.env.WHATSAPP_WABA_ID?.trim(),
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim(),
  workspaceId: process.env.WHATSAPP_WORKSPACE_ID?.trim().toLowerCase(),
  actorId: process.env.WHATSAPP_INTAKE_ACTOR_ID?.trim().toLowerCase(),
};
const whatsappConfigSchema = z.object({
  appSecret: z.string().min(1).max(512),
  verifyToken: z.string().min(1).max(512),
  wabaId: z.string().regex(/^\d{1,30}$/),
  phoneNumberId: z.string().regex(/^\d{1,30}$/),
  workspaceId: z.uuid(),
  actorId: z.uuid(),
});
const whatsapp = Object.values(whatsappSettings).some(Boolean)
  ? whatsappConfigSchema.safeParse(whatsappSettings)
  : undefined;
if (whatsapp && !whatsapp.success)
  throw new Error('请完整配置 WhatsApp 收件的凭据、账号及工作空间归属');
const db = await openDatabase({
  url: process.env.DATABASE_URL,
  dataDir: process.env.DATA_DIR ?? '.local/postgres',
});
let localActorId: string | undefined;
try {
  await migrate(db);
  if (whatsapp) {
    const membership = await db.query(
      'SELECT 1 FROM memberships WHERE workspace_id=$1 AND actor_id=$2 AND active',
      [whatsapp.data.workspaceId, whatsapp.data.actorId],
    );
    if (!membership.rows.length) throw new Error('WhatsApp 收件负责人必须是工作空间的有效成员');
  }
  if (localAccessEmail) {
    localActorId = (
      await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [localAccessEmail])
    ).rows[0]?.id;
    if (!localActorId) throw new Error('本地访问账号不存在，请检查 LOCAL_ACCESS_EMAIL');
  }
} catch (error) {
  await db.close();
  throw error;
}
const mail = { key: await mailKey({ production, key: process.env.MAIL_ENCRYPTION_KEY }) };
const stopMailWorker = startMailWorker(db, mail);
const stopOutgoingWorker = startOutgoingWorker(db, mail);
const knowledgeEnabled = process.env.GRAPHITI_ENABLED === 'true' && !!process.env.MINIMAX_API_KEY;
const stopDocumentWorker = startDocumentWorker(db, { knowledgeEnabled });
const embeddings =
  process.env.GRAPHITI_ENABLED === 'true'
    ? localEmbeddingTransport({
        python: process.env.GRAPHITI_PYTHON || '.local/graphiti-venv/bin/python',
        dataDir: process.env.GRAPHITI_DATA_DIR || '.local/graphiti',
      })
    : undefined;
const stopSourceIndexWorker = startSourceIndexWorker(db, embeddings);
const stopKnowledgeWorker = startKnowledgeWorker(
  db,
  knowledgeEnabled
    ? graphitiTransport({
        python: process.env.GRAPHITI_PYTHON || '.local/graphiti-venv/bin/python',
        dataDir: process.env.GRAPHITI_DATA_DIR || '.local/graphiti',
        apiKey: process.env.MINIMAX_API_KEY!,
        region: process.env.MINIMAX_API_REGION === 'global' ? 'global' : 'cn',
      })
    : undefined,
);
const app = createApp(db, {
  whatsapp: whatsapp?.data,
  embeddings,
  knowledgeEnabled,
  knowledgeSearch: knowledgeEnabled
    ? graphitiSearchTransport({
        python: process.env.GRAPHITI_PYTHON || '.local/graphiti-venv/bin/python',
        dataDir: process.env.GRAPHITI_DATA_DIR || '.local/graphiti',
      })
    : undefined,
  attributes: {
    apiKey: process.env.MINIMAX_API_KEY?.trim() || undefined,
    region: process.env.MINIMAX_API_REGION === 'global' ? 'global' : 'cn',
    key: mail.key,
  },
  wechat:
    !production && localActorId
      ? {
          transport: createLocalWeChatTransport(),
          actorId: localActorId,
          credentialKey: mail.key,
          connectorRequired: false,
          connectorBindingEnabled: false,
        }
      : undefined,
  mail,
  origin,
  secureCookies: production,
  development: !production,
  localActorId,
});
let vite: Awaited<ReturnType<(typeof import('vite'))['createServer']>> | undefined;
await app.locals.agentRuns.recover();
if (production) {
  app.use(express.static(resolve('dist'), { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  vite = await mountDevelopment(app, { dataDir: process.env.DATA_DIR ?? '.local/postgres' });
}
const server = app.listen(port, host, () => console.log(`light_crm 已启动：${origin}`));
server.once('error', async () => {
  console.error('监听失败，请检查端口是否已被占用。');
  await app.locals.agentRuns.stop();
  await vite?.close();
  await db.close();
  process.exit(1);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((done) => server.close(() => done()));
  await app.locals.agentRuns.stop();
  await vite?.close();
  const deadline = setTimeout(() => server.closeAllConnections(), 5000);
  deadline.unref();
  await closed;
  clearTimeout(deadline);
  await stopMailWorker();
  await stopOutgoingWorker();
  await stopKnowledgeWorker();
  await stopSourceIndexWorker();
  await stopDocumentWorker();
  await db.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
