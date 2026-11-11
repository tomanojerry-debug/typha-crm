import { entitySchema } from './entity-schema.js';
import * as businessActivities from './business-activities.js';
import type { ActivityModelOptions } from './activity-model.js';
import * as customObjects from './custom-objects.js';
import * as wechat from './wechat.js';
import {
  knowledgeView,
  knowledgeGraphView,
  enqueueKnowledge,
  recordEvidence,
} from './knowledge.js';
import { createWeChatConnector } from './wechat-connector.js';
import * as mailNotifications from './mail-notifications.js';
import * as workflow from './list-workflow.js';
import { validateListConfig } from './list-validation.js';
import * as people from './people.js';
import * as chats from './chats.js';
import * as homeWorkflows from './home-workflows.js';
import { overview as homeOverview } from './home-overview.js';
import * as reports from './reports.js';
import * as activityAnalysis from './activity-analysis.js';
import * as ask from './ask.js';
import {
  listUserPreferenceSettings,
  editUserPreference,
  removeUserPreference,
} from './user-preferences.js';
import { agentStatus, testAgent, type AgentModelOptions } from './agent-model.js';
import type { KnowledgeSearchTransport } from '../shared/knowledge-search.js';
import * as attributes from './attributes.js';
import * as customAttributeAi from './custom-attribute-ai.js';
import type { LocalEmbeddingTransport } from '../shared/source-search.js';
import { sourceIndexStatus } from './source-index.js';
import { modelStatus, testModel, type AttributeModelOptions } from './attribute-model.js';
import * as relationships from './relationships.js';
import * as mail from './mail.js';
import * as outgoing from './outgoing.js';
import * as mailTemplates from './mail-templates.js';
import * as documents from './documents.js';
import * as notes from './notes.js';
import { importShopifyInboxMessage } from './shopify-inbox.js';
import * as prospects from './prospects.js';
import * as prospectIntake from './prospect-intake.js';
import { noteSourceCandidates } from './note-sources.js';
import { prepareNoteDraft, saveAgentAnswerAsNoteDraft } from './note-agent.js';
import { listDocumentAttributeFields, organizeDocumentAttributes } from './document-attributes.js';
import * as mailSettings from './mail-settings.js';
import type { Customer } from '../shared/domain.js';
import * as lists from './lists.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Database, Sql } from './db.js';
import {
  ApiError,
  hashPassword,
  requireAdmin,
  scoped,
  tokenHash,
  verifyPassword,
  type Context,
} from './security.js';
import * as v from './validation.js';
import * as service from './service.js';
import * as browse from './browse.js';
import { requireLocalRequest, validateLocalAccess } from './local-access.js';
import { agentResponse } from './agent-stream.js';
import { createAgentRuns } from './agent-runs.js';
import { legacyExecution } from './agent-run-store.js';

const cookieName = 'light_crm_session';
const expiresMs = 12 * 60 * 60 * 1000;
interface AppOptions {
  activities?: ActivityModelOptions;
  documents?: documents.DocumentOptions;
  knowledgeEnabled?: boolean;
  knowledgeSearch?: KnowledgeSearchTransport;
  embeddings?: LocalEmbeddingTransport;
  agent?: AgentModelOptions;
  attributes?: AttributeModelOptions;
  wechat?: wechat.WeChatOptions;
  outgoing?: outgoing.OutgoingOptions;
  mail?: mail.MailOptions;
  origin: string;
  secureCookies?: boolean;
  development?: boolean;
  localActorId?: string;
}
export function createApp(db: Database, options: AppOptions) {
  if (options.localActorId) {
    validateLocalAccess(options);
    v.uuid.parse(options.localActorId);
  }
  const app = express();
  const wechatConnector = createWeChatConnector(db, {
    wechat: options.wechat,
    key: options.wechat?.credentialKey,
    provider: options.wechat?.connectorProvider,
  });
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: options.development ? false : undefined }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, _res, next) => {
    if (options.localActorId) requireLocalRequest(req, options.origin);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== options.origin) throw new ApiError(403, '请求来源无效');
      if (!req.is('application/json')) throw new ApiError(415, '请使用 JSON 请求');
    }
    next();
  });
  app.use('/api/people/:personId/outgoing', express.json({ limit: '8mb' }));
  app.use('/api/customers/:customerId/outgoing', express.json({ limit: '8mb' }));
  app.use('/api/documents', express.json({ limit: '15mb' }));
  app.use('/api/ask/query', express.json({ limit: '1mb' }));
  app.use('/api/prospect-intakes', express.json({ limit: '1mb' }));
  app.use('/api/prospects', express.json({ limit: '2mb' }));
  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: !!options.secureCookies,
    path: '/',
  };
  const fallbackHash = hashPassword(randomBytes(32).toString('hex'));
  app.post(
    '/api/auth/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: '登录尝试过多，请稍后重试' },
    }),
    async (req, res) => {
      if (options.localActorId) throw new ApiError(409, '本地工作台已启用直接访问');
      const input = v.loginInput.parse(req.body);
      const user = (
        await db.query<{ id: string; password_hash: string }>(
          'SELECT id, password_hash FROM users WHERE email = $1',
          [input.email],
        )
      ).rows[0];
      const valid = await verifyPassword(
        input.password,
        user?.password_hash ?? (await fallbackHash),
      );
      if (!user || !valid) throw new ApiError(401, '邮箱或密码不正确');
      const token = randomBytes(32).toString('base64url');
      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM sessions WHERE expires_at <= now()');
        if (req.cookies[cookieName])
          await tx.query('DELETE FROM sessions WHERE token_hash = $1', [
            tokenHash(req.cookies[cookieName]),
          ]);
        await tx.query(
          'INSERT INTO sessions(token_hash, actor_id, expires_at) VALUES ($1, $2, $3)',
          [tokenHash(token), user.id, new Date(Date.now() + expiresMs)],
        );
      });
      res.cookie(cookieName, token, { ...cookieOptions, maxAge: expiresMs }).json({ ok: true });
    },
  );
  app.use('/api', async (req, res, next) => {
    if (options.localActorId) {
      // Identity comes only from explicit server configuration. Every business
      // request still validates current membership, customer access and RLS.
      const user = (
        await db.query<{ id: string; display_name: string; email: string }>(
          'SELECT id, display_name, email FROM users WHERE id = $1',
          [options.localActorId],
        )
      ).rows[0];
      if (!user) throw new ApiError(503, '本地访问账号不可用，请检查服务端配置');
      res.locals.actor = user;
      next();
      return;
    }
    const token = req.cookies[cookieName];
    if (typeof token !== 'string' || token.length > 200) throw new ApiError(401, '请先登录');
    const user = (
      await db.query<{ id: string; display_name: string; email: string }>(
        `SELECT u.id, u.display_name, u.email FROM sessions s JOIN users u ON u.id = s.actor_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash(token)],
      )
    ).rows[0];
    if (!user) throw new ApiError(401, '登录已过期，请重新登录');
    res.locals.actor = user;
    next();
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (options.localActorId) throw new ApiError(409, '本地工作台无需退出登录');
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash(req.cookies[cookieName]),
    ]);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  app.get('/api/session', async (_req, res) => {
    const workspaces = (
      await db.query(
        `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.actor_id = $1 AND m.active ORDER BY w.name, w.id`,
        [res.locals.actor.id],
      )
    ).rows;
    res.json({
      actor: res.locals.actor,
      workspaces,
      auth_mode: options.localActorId ? 'local' : 'password',
    });
  });
  const business =
    (fn: (ctx: Context, req: Request) => Promise<unknown>, status = 200) =>
    async (req: Request, res: Response) => {
      const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
      const result = await scoped(db, res.locals.actor.id, workspaceId, (ctx) => fn(ctx, req));
      res.status(status).json(result);
    };
  const attributeOptions: AttributeModelOptions = {
    ...(options.attributes ?? { key: options.mail?.key }),
    knowledgeSearch: options.knowledgeSearch ?? options.attributes?.knowledgeSearch,
    embeddings: options.embeddings ?? options.attributes?.embeddings,
  };
  const agentOptions: AgentModelOptions = {
    ...(options.agent ?? {
      apiKey: options.attributes?.apiKey,
      region: options.attributes?.region,
      key: options.mail?.key ?? options.attributes?.key,
      fetch: options.attributes?.fetch,
    }),
    knowledgeSearch: options.knowledgeSearch ?? options.agent?.knowledgeSearch,
    embeddings: options.embeddings ?? options.agent?.embeddings ?? options.attributes?.embeddings,
  };
  const agentRuns = createAgentRuns(db, { agent: agentOptions, wechat: options.wechat });
  app.locals.agentRuns = agentRuns;
  const modelLimit = rateLimit({
    windowMs: 60000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '模型请求过于频繁，请稍后重试' },
  });
  app.get(
    '/api/prospects',
    business((ctx, req) => prospects.list(ctx, req.query)),
  );
  app.get(
    '/api/prospects/tasks',
    business((ctx, req) => prospects.tasks(ctx, req.query)),
  );
  app.post(
    '/api/prospects',
    business((ctx, req) => prospects.create(ctx, req.body), 201),
  );
  app.get(
    '/api/prospects/:id',
    business((ctx, req) => prospects.detail(ctx, v.uuid.parse(req.params.id))),
  );
  app.patch(
    '/api/prospects/:id',
    business((ctx, req) => prospects.update(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/prospect-intakes/sources',
    business((ctx, req) => prospectIntake.sources(ctx, req.query)),
  );
  app.post('/api/prospect-intakes/generate', modelLimit, async (req, res) => {
    const workspace = v.uuid.parse(req.get('x-workspace-id'));
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', disconnect);
    try {
      const result = await prospectIntake.generate(
        db,
        res.locals.actor.id,
        workspace,
        req.body,
        agentOptions,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      res.json(result);
    } finally {
      res.off('close', disconnect);
    }
  });
  app.get(
    '/api/prospect-intakes/:id',
    business((ctx, req) => prospectIntake.detail(ctx, v.uuid.parse(req.params.id))),
  );
  app.post(
    '/api/prospect-intakes/:id/accept',
    business((ctx, req) => prospectIntake.accept(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  const activityOptions: ActivityModelOptions = options.activities ?? {
    apiKey: agentOptions.apiKey,
    region: agentOptions.region,
    key: agentOptions.key,
    fetch: agentOptions.fetch,
  };
  app.get(
    '/api/activity-schemas',
    business((ctx) => businessActivities.schemas(ctx)),
  );
  app.post(
    '/api/activity-schemas',
    business((ctx, req) => businessActivities.createSchema(ctx, req.body), 201),
  );
  app.patch(
    '/api/activity-schemas/:id',
    business((ctx, req) =>
      businessActivities.updateSchema(ctx, v.uuid.parse(req.params.id), req.body),
    ),
  );
  app.get(
    '/api/activity-types',
    business((ctx) => businessActivities.types(ctx)),
  );
  app.post(
    '/api/activity-types',
    business((ctx, req) => businessActivities.createType(ctx, req.body), 201),
  );
  app.patch(
    '/api/activity-types/:id',
    business((ctx, req) =>
      businessActivities.updateType(ctx, v.uuid.parse(req.params.id), req.body),
    ),
  );
  app.get(
    '/api/activity-sources',
    business((ctx, req) => businessActivities.sources(ctx, req.query)),
  );
  app.get(
    '/api/activity-members',
    business((ctx, req) => businessActivities.members(ctx, v.uuid.parse(req.query.customer_id))),
  );
  app.get(
    '/api/activities',
    business((ctx, req) => businessActivities.browse(ctx, req.query)),
  );
  app.post('/api/activities/generate', modelLimit, async (req, res) => {
    res
      .status(201)
      .json(
        await businessActivities.generateActivities(
          db,
          res.locals.actor.id,
          v.uuid.parse(req.get('x-workspace-id')),
          req.body,
          activityOptions,
        ),
      );
  });
  app.get(
    '/api/activities/:id',
    business((ctx, req) => businessActivities.detail(ctx, v.uuid.parse(req.params.id), req.query)),
  );
  app.patch(
    '/api/activities/:id',
    business((ctx, req) => businessActivities.update(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/activities/:id/comments',
    business(
      (ctx, req) => businessActivities.comment(ctx, v.uuid.parse(req.params.id), req.body),
      201,
    ),
  );
  app.get(
    '/api/tasks',
    business((ctx, req) => businessActivities.tasks(ctx, req.query)),
  );
  app.patch(
    '/api/tasks/:id',
    business((ctx, req) =>
      businessActivities.updateTask(ctx, v.uuid.parse(req.params.id), req.body),
    ),
  );
  app.get(
    '/api/customers/:id/activity-status',
    business(async (ctx, req) => {
      const customerId = v.uuid.parse(req.params.id);
      const filter = z
        .strictObject({ person_id: z.uuid().optional(), project_id: z.uuid().optional() })
        .parse(req.query);
      const [graph, vector] = await Promise.all([
        knowledgeView(ctx, customerId, filter, options.knowledgeEnabled === true),
        sourceIndexStatus(ctx, customerId, filter),
      ]);
      return {
        originals: {
          state: 'saved',
          record_count: vector.record_count,
          source_count: vector.source_count,
        },
        graph,
        vector:
          !options.embeddings && vector.state !== 'ready'
            ? { ...vector, state: 'disabled' }
            : vector,
      };
    }),
  );
  app.get(
    '/api/notes',
    business((ctx, req) => notes.listNotes(ctx, req.query)),
  );
  app.get(
    '/api/notes/sources',
    business((ctx, req) => noteSourceCandidates(ctx, req.query)),
  );
  app.get(
    '/api/notes/:id',
    business((ctx, req) => notes.noteDetail(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/notes/:id/versions',
    business((ctx, req) => notes.noteVersions(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/note-drafts/:id',
    business((ctx, req) => notes.noteDraft(ctx, v.uuid.parse(req.params.id))),
  );
  app.put(
    '/api/note-drafts/:id',
    business((ctx, req) => notes.saveNoteDraft(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.delete(
    '/api/note-drafts/:id',
    business((ctx, req) => notes.deleteNoteDraft(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/notes/publish',
    business((ctx, req) => notes.publishNote(ctx, req.body)),
  );
  app.post(
    '/api/notes/:id/archive',
    business((ctx, req) => notes.archiveNote(ctx, v.uuid.parse(req.params.id), req.body, true)),
  );
  app.post(
    '/api/notes/:id/restore',
    business((ctx, req) => notes.archiveNote(ctx, v.uuid.parse(req.params.id), req.body, false)),
  );
  app.get(
    '/api/note-templates',
    business((ctx) => notes.listNoteTemplates(ctx)),
  );
  app.post(
    '/api/note-templates',
    business((ctx, req) => notes.createNoteTemplate(ctx, req.body), 201),
  );
  app.post('/api/notes/agent-draft', modelLimit, async (req, res) => {
    const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
    res.json(await prepareNoteDraft(db, res.locals.actor.id, workspaceId, req.body, agentOptions));
  });
  app.post('/api/notes/from-answer', modelLimit, async (req, res) => {
    const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
    res.json(
      await saveAgentAnswerAsNoteDraft(
        db,
        res.locals.actor.id,
        workspaceId,
        req.body,
        agentOptions,
      ),
    );
  });
  const documentOptions = { ...options.documents, knowledgeEnabled: options.knowledgeEnabled };
  const documentAttributeOptions = {
    ...attributeOptions,
    loadDocument: (ctx: Context, id: string) => documents.documentDetail(ctx, id, documentOptions),
  };
  app.get(
    '/api/documents',
    business((ctx, req) => documents.listDocuments(ctx, req.query, documentOptions)),
  );
  app.post('/api/documents', async (req, res) => {
    const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
    const result = await scoped(db, res.locals.actor.id, workspaceId, (ctx) =>
      documents.uploadDocument(ctx, req.body, documentOptions),
    );
    res.status(201).json(result);
    void documents
      .processDocument(db, res.locals.actor.id, workspaceId, result.id, documentOptions)
      .catch(() => {});
  });
  app.get(
    '/api/documents/:id',
    business((ctx, req) =>
      documents.documentDetail(ctx, v.uuid.parse(req.params.id), documentOptions),
    ),
  );
  app.get(
    '/api/documents/:id/original',
    business((ctx, req) => documents.originalDocument(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/documents/:id/versions',
    business((ctx, req) =>
      documents.documentVersions(ctx, v.uuid.parse(req.params.id), documentOptions),
    ),
  );
  app.post(
    '/api/documents/:id/associate',
    business((ctx, req) =>
      documents.associateDocument(ctx, v.uuid.parse(req.params.id), req.body, documentOptions),
    ),
  );
  app.post('/api/documents/:id/retry', async (req, res) => {
    const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
    const result = await scoped(db, res.locals.actor.id, workspaceId, (ctx) =>
      documents.retryDocument(ctx, v.uuid.parse(req.params.id), req.body, documentOptions),
    );
    res.json(result);
    void documents
      .processDocument(db, res.locals.actor.id, workspaceId, result.id, documentOptions)
      .catch(() => {});
  });
  app.get(
    '/api/documents/:id/attributes',
    business((ctx, req) =>
      listDocumentAttributeFields(ctx, v.uuid.parse(req.params.id), documentAttributeOptions),
    ),
  );
  app.post('/api/documents/:id/attributes', modelLimit, async (req, res) => {
    const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
    res.json(
      await organizeDocumentAttributes(
        db,
        res.locals.actor.id,
        workspaceId,
        v.uuid.parse(req.params.id),
        req.body,
        documentAttributeOptions,
      ),
    );
  });
  app.post('/api/documents/:id/ask', modelLimit, async (req, res) => {
    const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
    res.json(
      await documents.askDocument(
        db,
        res.locals.actor.id,
        workspaceId,
        v.uuid.parse(req.params.id),
        req.body,
        agentOptions,
      ),
    );
  });
  app.get(
    '/api/agent/model',
    business((ctx) => agentStatus(ctx, agentOptions)),
  );
  app.post('/api/agent/model/test', modelLimit, async (req, res) => {
    z.strictObject({}).parse(req.body);
    res.json(
      await testAgent(
        db,
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        agentOptions,
      ),
    );
  });
  app.get(
    '/api/attributes/model',
    business((ctx) => modelStatus(ctx, attributeOptions)),
  );
  app.post(
    '/api/attributes/model/test',
    rateLimit({
      windowMs: 60000,
      limit: 3,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: '连接检查过于频繁，请稍后重试' },
    }),
    async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(
        await testModel(
          db,
          res.locals.actor.id,
          v.uuid.parse(req.get('x-workspace-id')),
          attributeOptions,
        ),
      );
    },
  );
  app.get('/api/entity-schema', business(entitySchema));
  app.get('/api/custom-objects', business(customObjects.objects));
  app.post(
    '/api/custom-objects/:objectId/records/:recordId/attribute-runs',
    modelLimit,
    async (req, res) => {
      const result = await customAttributeAi.generate(
        db,
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        v.uuid.parse(req.params.objectId),
        v.uuid.parse(req.params.recordId),
        req.body,
        attributeOptions,
      );
      res.status(201).json(result);
    },
  );
  app.post(
    '/api/custom-objects/:objectId/records/:recordId/attribute-runs/:runId/apply',
    business((ctx, req) => {
      z.strictObject({}).parse(req.body);
      return customAttributeAi.applyRun(
        ctx,
        v.uuid.parse(req.params.objectId),
        v.uuid.parse(req.params.recordId),
        v.uuid.parse(req.params.runId),
      );
    }),
  );
  app.post(
    '/api/custom-objects',
    business((ctx, req) => customObjects.createObject(ctx, req.body), 201),
  );
  app.get(
    '/api/custom-objects/:objectId/attributes',
    business((ctx, req) => customObjects.fields(ctx, v.uuid.parse(req.params.objectId))),
  );
  app.post(
    '/api/custom-objects/:objectId/attributes',
    business(
      (ctx, req) => customObjects.saveField(ctx, v.uuid.parse(req.params.objectId), null, req.body),
      201,
    ),
  );
  app.put(
    '/api/custom-objects/:objectId/attributes/:id',
    business((ctx, req) =>
      customObjects.saveField(
        ctx,
        v.uuid.parse(req.params.objectId),
        v.uuid.parse(req.params.id),
        req.body,
      ),
    ),
  );
  app.get(
    '/api/custom-objects/:objectId/record-options',
    business((ctx, req) =>
      customObjects.recordOptions(ctx, v.uuid.parse(req.params.objectId), req.query),
    ),
  );
  app.get(
    '/api/custom-objects/:objectId/records',
    business((ctx, req) =>
      customObjects.records(ctx, v.uuid.parse(req.params.objectId), req.query),
    ),
  );
  app.get(
    '/api/custom-objects/:objectId/records/:id',
    business((ctx, req) =>
      customObjects.record(ctx, v.uuid.parse(req.params.objectId), v.uuid.parse(req.params.id)),
    ),
  );
  app.post(
    '/api/custom-objects/:objectId/records',
    business(
      (ctx, req) =>
        customObjects.saveRecord(ctx, v.uuid.parse(req.params.objectId), null, req.body),
      201,
    ),
  );
  app.put(
    '/api/custom-objects/:objectId/records/:id',
    business((ctx, req) =>
      customObjects.saveRecord(
        ctx,
        v.uuid.parse(req.params.objectId),
        v.uuid.parse(req.params.id),
        req.body,
      ),
    ),
  );
  app.get(
    '/api/customers/:id/records/:recordId/evidence',
    business((ctx, req) =>
      recordEvidence(ctx, v.uuid.parse(req.params.id), v.uuid.parse(req.params.recordId)),
    ),
  );
  app.get(
    '/api/customers/:id/knowledge/graph',
    business((ctx, req) =>
      knowledgeGraphView(
        ctx,
        v.uuid.parse(req.params.id),
        z.strictObject({ project_id: z.uuid().optional() }).parse(req.query),
        options.knowledgeEnabled === true,
      ),
    ),
  );
  app.get(
    '/api/customers/:id/knowledge',
    business((ctx, req) =>
      knowledgeView(
        ctx,
        v.uuid.parse(req.params.id),
        z
          .strictObject({ project_id: z.uuid().optional(), person_id: z.uuid().optional() })
          .parse(req.query),
        options.knowledgeEnabled === true,
      ),
    ),
  );
  app.post(
    '/api/customers/:id/knowledge/sync',
    business((ctx, req) => {
      if (!options.knowledgeEnabled) throw new ApiError(503, 'Graphiti 运行器尚未启用');
      return enqueueKnowledge(ctx, v.uuid.parse(req.params.id));
    }, 202),
  );
  app.get(
    '/api/attributes',
    business((ctx) => attributes.fields(ctx)),
  );
  app.post(
    '/api/attributes',
    business((ctx, req) => attributes.createField(ctx, req.body), 201),
  );
  app.patch(
    '/api/attributes/:id',
    business((ctx, req) => attributes.updateField(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/attributes/customer-values',
    business((ctx, req) => attributes.batchValues(ctx, req.body)),
  );
  app.get(
    '/api/customers/:id/attribute-values',
    business((ctx, req) => attributes.values(ctx, v.uuid.parse(req.params.id))),
  );
  app.patch(
    '/api/customers/:id/attribute-values/:attributeId',
    business((ctx, req) =>
      attributes.saveValue(
        ctx,
        v.uuid.parse(req.params.id),
        v.uuid.parse(req.params.attributeId),
        req.body,
      ),
    ),
  );
  app.post(
    '/api/customers/:id/attribute-runs',
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'AI 填充请求过于频繁，请稍后重试' },
    }),
    async (req, res) => {
      const result = await attributes.generate(
        db,
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        v.uuid.parse(req.params.id),
        req.body,
        attributeOptions,
      );
      res.status(201).json(result);
    },
  );
  app.post(
    '/api/customers/:id/attribute-runs/:runId/apply',
    business((ctx, req) => {
      z.strictObject({}).parse(req.body);
      return attributes.applyRun(ctx, v.uuid.parse(req.params.id), v.uuid.parse(req.params.runId));
    }),
  );
  app.post('/api/mail/accounts/:id/test-smtp', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(
      await outgoing.testSender(
        db,
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        v.uuid.parse(req.params.id),
        options.outgoing ?? { key: options.mail?.key },
      ),
    );
  });
  app.get(
    '/api/customers/:id/compose-options',
    business((ctx, req) => outgoing.composeOptions(ctx, v.uuid.parse(req.params.id), 'customers')),
  );
  app.get(
    '/api/customers/:id/mail-templates',
    business((ctx, req) =>
      mailTemplates.listMailTemplates(ctx, v.uuid.parse(req.params.id), 'customers'),
    ),
  );
  app.post(
    '/api/customers/:id/mail-templates',
    business(
      (ctx, req) =>
        mailTemplates.createMailTemplate(ctx, v.uuid.parse(req.params.id), req.body, 'customers'),
      201,
    ),
  );
  app.get(
    '/api/customers/:id/recipient-options',
    business((ctx, req) =>
      outgoing.recipientOptions(ctx, v.uuid.parse(req.params.id), req.query, 'customers'),
    ),
  );
  app.get(
    '/api/customers/:id/outgoing',
    business((ctx, req) => outgoing.listOutgoing(ctx, v.uuid.parse(req.params.id), 'customers')),
  );
  app.post(
    '/api/customers/:id/outgoing',
    business((ctx, req) =>
      outgoing.saveOutgoing(ctx, v.uuid.parse(req.params.id), req.body, 'customers'),
    ),
  );
  app.get(
    '/api/relationships',
    business((ctx) => relationships.definitions(ctx)),
  );
  app.post(
    '/api/relationships',
    business((ctx, req) => relationships.createDefinition(ctx, req.body), 201),
  );
  app.get(
    '/api/relationships/records/:object/:id',
    business((ctx, req) =>
      relationships.related(
        ctx,
        relationships.objectKind.parse(req.params.object),
        v.uuid.parse(req.params.id),
      ),
    ),
  );
  app.get(
    '/api/customers/:customerId/relationship-candidates',
    business((ctx, req) =>
      relationships.candidates(ctx, v.uuid.parse(req.params.customerId), req.query),
    ),
  );
  app.get(
    '/api/relationships/records/:object/:id/projects',
    business((ctx, req) =>
      relationships.associatedProjects(
        ctx,
        req.params.object,
        v.uuid.parse(req.params.id),
        req.query,
      ),
    ),
  );
  app.post(
    '/api/relationship-edges',
    business((ctx, req) => relationships.createEdge(ctx, req.body), 201),
  );
  app.delete(
    '/api/relationship-edges/:id',
    business((ctx, req) => relationships.removeEdge(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/mail/accounts',
    business((ctx) => mail.accounts(ctx)),
  );
  app.get(
    '/api/people/:personId/compose-options',
    business((ctx, req) => outgoing.composeOptions(ctx, v.uuid.parse(req.params.personId))),
  );
  app.get(
    '/api/people/:personId/mail-templates',
    business((ctx, req) => mailTemplates.listMailTemplates(ctx, v.uuid.parse(req.params.personId))),
  );
  app.post(
    '/api/people/:personId/mail-templates',
    business(
      (ctx, req) =>
        mailTemplates.createMailTemplate(ctx, v.uuid.parse(req.params.personId), req.body),
      201,
    ),
  );
  app.get(
    '/api/people/:personId/recipient-options',
    business((ctx, req) =>
      outgoing.recipientOptions(ctx, v.uuid.parse(req.params.personId), req.query),
    ),
  );
  app.get(
    '/api/people/:personId/outgoing',
    business((ctx, req) => outgoing.listOutgoing(ctx, v.uuid.parse(req.params.personId))),
  );
  app.post(
    '/api/people/:personId/outgoing',
    business((ctx, req) => outgoing.saveOutgoing(ctx, v.uuid.parse(req.params.personId), req.body)),
  );
  app.get(
    '/api/outgoing/:id',
    business((ctx, req) => outgoing.getOutgoing(ctx, v.uuid.parse(req.params.id))),
  );
  app.post(
    '/api/outgoing/:id/variable-preview',
    business((ctx, req) => outgoing.variablePreview(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/outgoing/:id/approve',
    business((ctx, req) => outgoing.approveOutgoing(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/outgoing/:id/schedule',
    business((ctx, req) =>
      outgoing.scheduleOutgoing(
        ctx,
        v.uuid.parse(req.params.id),
        req.body,
        options.outgoing ?? { key: options.mail?.key },
      ),
    ),
  );
  app.post(
    '/api/outgoing/:id/cancel',
    business((ctx, req) => outgoing.cancelOutgoing(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post('/api/outgoing/:id/reconcile', async (req, res) => {
    z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    res.json(
      await outgoing.reconcileOutgoing(
        db,
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        v.uuid.parse(req.params.id),
        options.outgoing ?? { key: options.mail?.key },
      ),
    );
  });
  app.post(
    '/api/mail/accounts',
    business((ctx, req) => mail.createAccount(ctx, req.body, options.mail ?? {}), 201),
  );
  app.patch(
    '/api/mail/accounts/:id',
    business((ctx, req) =>
      mail.editAccount(ctx, v.uuid.parse(req.params.id), req.body, options.mail ?? {}),
    ),
  );
  app.patch(
    '/api/mail/accounts/:id/processing',
    business((ctx, req) => mailSettings.saveProcessing(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/mail/exclusions',
    business((ctx) => mailSettings.exclusions(ctx)),
  );
  app.post(
    '/api/mail/exclusions/preview',
    business((ctx, req) => mailSettings.previewExclusions(ctx, req.body)),
  );
  app.put(
    '/api/mail/exclusions',
    business((ctx, req) => mailSettings.saveExclusions(ctx, req.body)),
  );
  app.post('/api/mail/accounts/:id/sync', async (req, res) => {
    res.json(
      await mail.syncAccount(
        db,
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        v.uuid.parse(req.params.id),
        options.mail ?? {},
      ),
    );
  });
  app.post(
    '/api/chats/:id/wechat',
    business((ctx, req) =>
      wechat.preview(ctx, req.body, options.wechat, v.uuid.parse(req.params.id)),
    ),
  );
  app.get(
    '/api/wechat/status',
    business((ctx) => wechat.status(ctx, options.wechat)),
  );
  app.get('/api/wechat/connector', async (req, res) => {
    res.json(
      await wechatConnector.status(res.locals.actor.id, v.uuid.parse(req.get('x-workspace-id'))),
    );
  });
  const connectorLimit = rateLimit({
    windowMs: 60000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '二维码操作过于频繁，请稍后重试。' },
  });
  app.post('/api/wechat/connector/start', connectorLimit, async (req, res) => {
    z.strictObject({}).parse(req.body);
    res.json(
      await wechatConnector.start(res.locals.actor.id, v.uuid.parse(req.get('x-workspace-id'))),
    );
  });
  app.post('/api/wechat/connector/poll', async (req, res) => {
    res.json(
      await wechatConnector.poll(
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        req.body,
      ),
    );
  });
  app.post('/api/wechat/connector/cancel', async (req, res) => {
    res.json(
      await wechatConnector.cancel(
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        req.body,
      ),
    );
  });
  app.post(
    '/api/wechat/open',
    business((ctx, req) => {
      z.strictObject({}).parse(req.body);
      return wechat.openApp(ctx, options.wechat);
    }),
  );
  app.post(
    '/api/wechat/queries',
    business((ctx, req) => wechat.preview(ctx, req.body, options.wechat)),
  );
  app.get(
    '/api/wechat/queries',
    business((ctx) => wechat.list(ctx)),
  );
  app.get(
    '/api/wechat/conversations',
    business((ctx) => wechat.conversations(ctx)),
  );
  app.get(
    '/api/wechat/conversations/:id/queries',
    business((ctx, req) => wechat.conversationQueries(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/wechat/queries/:id',
    business((ctx, req) => wechat.detail(ctx, v.uuid.parse(req.params.id))),
  );
  app.post(
    '/api/wechat/queries/:id/associate',
    business((ctx, req) => wechat.associate(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/mail/tracking/summary',
    business((ctx) => mail.mailTrackingSummary(ctx)),
  );
  app.post(
    '/api/mail/messages/:id/read',
    business((ctx, req) => {
      z.strictObject({}).parse(req.body);
      return mail.readMail(ctx, v.uuid.parse(req.params.id));
    }),
  );
  app.get(
    '/api/mail/notifications/summary',
    business((ctx) => mailNotifications.notificationSummary(ctx)),
  );
  app.get(
    '/api/mail/notifications',
    business((ctx, req) => mailNotifications.notifications(ctx, req.query)),
  );
  app.post(
    '/api/mail/notifications/:id/read',
    business((ctx, req) => {
      z.strictObject({}).parse(req.body);
      return mailNotifications.readNotification(ctx, v.uuid.parse(req.params.id));
    }),
  );
  app.post(
    '/api/mail/messages/:id/create-customer',
    business(
      (ctx, req) => mail.createMailCustomer(ctx, v.uuid.parse(req.params.id), req.body),
      201,
    ),
  );
  app.get(
    '/api/mail/messages',
    business((ctx, req) => mail.mailList(ctx, req.query)),
  );
  app.get(
    '/api/mail/messages/:id',
    business((ctx, req) => mail.mailDetail(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/mail/messages/:id/reply-options',
    business((ctx, req) => outgoing.replyOptions(ctx, v.uuid.parse(req.params.id), req.query)),
  );
  app.get(
    '/api/mail/messages/:id/replies',
    business((ctx, req) => outgoing.listReplies(ctx, v.uuid.parse(req.params.id))),
  );
  app.post(
    '/api/mail/messages/:id/assign',
    business((ctx, req) => mail.assignMail(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/agent/preferences',
    business((ctx) => listUserPreferenceSettings(ctx)),
  );
  app.patch(
    '/api/agent/preferences/:id',
    business((ctx, req) => editUserPreference(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.delete(
    '/api/agent/preferences/:id',
    business((ctx, req) => removeUserPreference(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/agent/capabilities',
    business(async (ctx) => ({
      ...(await chats.modelCapabilities(ctx, agentOptions)),
      prospects: true,
      prospect_intake: true,
    })),
  );
  app.get(
    '/api/chats/page',
    business((ctx, req) => chats.chatPage(ctx, req.query)),
  );
  app.get(
    '/api/chats',
    business((ctx) => chats.allChats(ctx)),
  );
  app.post(
    '/api/ask/context',
    business((ctx, req) => ask.contextWithModel(ctx, req.body, agentOptions)),
  );
  app.post('/api/ask/query', modelLimit, async (req, res) => {
    const workspace = v.uuid.parse(req.get('x-workspace-id'));
    const run = () =>
      agentResponse(req, res, (stream) =>
        ask.modelQuery(db, res.locals.actor.id, workspace, req.body, agentOptions, stream),
      );
    if (req.body.chat_id)
      await legacyExecution(
        db,
        workspace,
        res.locals.actor.id,
        v.uuid.parse(req.body.chat_id),
        run,
      );
    else await run();
  });
  app.post('/api/ask/runs', modelLimit, async (req, res) => {
    res
      .status(202)
      .json(
        await agentRuns.enqueueAsk(
          res.locals.actor.id,
          v.uuid.parse(req.get('x-workspace-id')),
          req.body,
        ),
      );
  });
  app.post('/api/chats/:id/runs', modelLimit, async (req, res) => {
    res
      .status(202)
      .json(
        await agentRuns.enqueueChat(
          res.locals.actor.id,
          v.uuid.parse(req.get('x-workspace-id')),
          v.uuid.parse(req.params.id),
          req.body,
        ),
      );
  });
  app.get('/api/chats/:chatId/runs/:runId', async (req, res) => {
    res.json(
      await agentRuns.get(
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        v.uuid.parse(req.params.chatId),
        v.uuid.parse(req.params.runId),
      ),
    );
  });
  app.get('/api/chats/:chatId/runs/:runId/events', async (req, res) => {
    await agentRuns.events(
      req,
      res,
      res.locals.actor.id,
      v.uuid.parse(req.get('x-workspace-id')),
      v.uuid.parse(req.params.chatId),
      v.uuid.parse(req.params.runId),
    );
  });
  app.post('/api/chats/:chatId/runs/:runId/cancel', async (req, res) => {
    res.json(
      await agentRuns.cancel(
        res.locals.actor.id,
        v.uuid.parse(req.get('x-workspace-id')),
        v.uuid.parse(req.params.chatId),
        v.uuid.parse(req.params.runId),
      ),
    );
  });
  app.post('/api/chats/:chatId/runs/:runId/retry', modelLimit, async (req, res) => {
    res
      .status(202)
      .json(
        await agentRuns.retry(
          res.locals.actor.id,
          v.uuid.parse(req.get('x-workspace-id')),
          v.uuid.parse(req.params.chatId),
          v.uuid.parse(req.params.runId),
        ),
      );
  });
  app.post(
    '/api/ask/source',
    business((ctx, req) => ask.evidence(ctx, req.body)),
  );
  app.post(
    '/api/chats',
    business((ctx, req) => chats.createChat(ctx, req.body), 201),
  );
  app.get(
    '/api/chats/:id',
    business((ctx, req) => chats.detail(ctx, v.uuid.parse(req.params.id))),
  );
  app.get(
    '/api/home-workflows/directory',
    business((ctx, req) => homeWorkflows.directory(ctx, req.query)),
  );
  app.get(
    '/api/home/overview',
    business((ctx) => homeOverview(ctx)),
  );
  app.get(
    '/api/reports/catalog',
    business((ctx) => reports.catalog(ctx)),
  );
  app.get(
    '/api/reports/activity-analysis/catalog',
    business((ctx) => activityAnalysis.catalog(ctx)),
  );
  app.post(
    '/api/reports/activity-analysis/query',
    business((ctx, req) => activityAnalysis.query(ctx, req.body)),
  );
  app.post(
    '/api/reports/query',
    business((ctx, req) => reports.query(ctx, req.body)),
  );
  app.get(
    '/api/reports/dashboards',
    business((ctx) => reports.dashboards(ctx)),
  );
  app.post(
    '/api/reports/dashboards',
    business((ctx, req) => reports.createDashboard(ctx, req.body), 201),
  );
  app.get(
    '/api/reports/dashboards/:id',
    business((ctx, req) => reports.dashboard(ctx, v.uuid.parse(req.params.id))),
  );
  app.patch(
    '/api/reports/dashboards/:id',
    business((ctx, req) => reports.updateDashboard(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.delete(
    '/api/reports/dashboards/:id',
    business((ctx, req) => reports.deleteDashboard(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/home-workflows/options',
    business((ctx, req) => homeWorkflows.options(ctx, req.query)),
  );
  app.get(
    '/api/chats/:id/workflow',
    business((ctx, req) => homeWorkflows.get(ctx, v.uuid.parse(req.params.id))),
  );
  app.post(
    '/api/chats/:id/workflow',
    business((ctx, req) => homeWorkflows.create(ctx, v.uuid.parse(req.params.id), req.body), 201),
  );
  app.patch(
    '/api/chats/:id/workflow',
    business((ctx, req) => homeWorkflows.configure(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/chats/:id/workflow/cancel',
    business((ctx, req) => homeWorkflows.cancel(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/chats/:id/workflow/wechat',
    business((ctx, req) =>
      homeWorkflows.readWeChat(ctx, v.uuid.parse(req.params.id), req.body, options.wechat),
    ),
  );
  app.post(
    '/api/chats/:id/workflow/apply',
    business((ctx, req) => homeWorkflows.apply(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/chats/:id/workflow/reply-draft',
    business((ctx, req) => homeWorkflows.replyDraft(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/chats/:id/workflow/templates',
    business((ctx, req) => homeWorkflows.templates(ctx, v.uuid.parse(req.params.id))),
  );
  app.post(
    '/api/chats/:id/workflow/template',
    business((ctx, req) =>
      homeWorkflows.chooseTemplate(ctx, v.uuid.parse(req.params.id), req.body),
    ),
  );
  app.post('/api/chats/:id/workflow/run', modelLimit, async (req, res) => {
    const workspace = v.uuid.parse(req.get('x-workspace-id')),
      id = v.uuid.parse(req.params.id);
    await legacyExecution(db, workspace, res.locals.actor.id, id, () =>
      agentResponse(req, res, (stream) =>
        homeWorkflows.run(db, res.locals.actor.id, workspace, id, req.body, agentOptions, stream),
      ),
    );
  });
  app.post('/api/chats/:id/workflow/fill', modelLimit, async (req, res) => {
    const workspace = v.uuid.parse(req.get('x-workspace-id')),
      id = v.uuid.parse(req.params.id);
    res.json(
      await legacyExecution(db, workspace, res.locals.actor.id, id, () =>
        homeWorkflows.fill(db, res.locals.actor.id, workspace, id, req.body, attributeOptions),
      ),
    );
  });
  app.post('/api/chats/:id/messages', modelLimit, async (req, res) => {
    const workspace = v.uuid.parse(req.get('x-workspace-id'));
    const id = v.uuid.parse(req.params.id);
    await legacyExecution(db, workspace, res.locals.actor.id, id, () =>
      agentResponse(req, res, (stream) =>
        chats.sendWithModel(
          db,
          res.locals.actor.id,
          workspace,
          id,
          req.body,
          agentOptions,
          options.wechat,
          stream,
        ),
      ),
    );
  });
  app.post(
    '/api/chats/:id/imports',
    business((ctx, req) => chats.preview(ctx, v.uuid.parse(req.params.id), req.body), 201),
  );
  app.post(
    '/api/chats/:id/imports/:planId/commit',
    business((ctx, req) => {
      z.strictObject({}).parse(req.body);
      return chats.commit(ctx, v.uuid.parse(req.params.id), v.uuid.parse(req.params.planId));
    }),
  );
  app.get(
    '/api/members',
    business(
      async (ctx) =>
        (
          await ctx.tx.query(
            'SELECT actor_id, display_name, email, role, active FROM workspace_people WHERE workspace_id = $1 ORDER BY display_name',
            [ctx.workspaceId],
          )
        ).rows,
    ),
  );
  // Account creation needs the authentication tables, so it uses an explicitly
  // admin-checked transaction rather than exposing them to the business role.
  async function adminTransaction<T>(
    req: Request,
    res: Response,
    fn: (tx: Sql, workspaceId: string) => Promise<T>,
  ) {
    const workspaceId = v.uuid.parse(req.get('x-workspace-id'));
    return db.transaction(async (tx) => {
      const member = (
        await tx.query<{ role: 'admin' | 'member' }>(
          'SELECT role FROM memberships WHERE workspace_id = $1 AND actor_id = $2 AND active FOR SHARE',
          [workspaceId, res.locals.actor.id],
        )
      ).rows[0];
      if (!member) throw new ApiError(404, '工作空间不存在或无权访问');
      requireAdmin(member);
      return fn(tx, workspaceId);
    });
  }
  app.post('/api/members', async (req, res) => {
    const input = v.memberCreate.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const result = await adminTransaction(req, res, async (tx, workspaceId) => {
      const id = randomUUID();
      await tx.query(
        'INSERT INTO users(id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
        [id, input.email, input.display_name, passwordHash],
      );
      await tx.query(
        "INSERT INTO memberships(workspace_id, actor_id, role) VALUES ($1, $2, 'member')",
        [workspaceId, id],
      );
      return {
        actor_id: id,
        display_name: input.display_name,
        email: input.email,
        role: 'member',
        active: true,
      };
    });
    res.status(201).json(result);
  });
  app.patch('/api/members/:id', async (req, res) => {
    const id = v.uuid.parse(req.params.id);
    const { active } = z.strictObject({ active: z.boolean() }).parse(req.body);
    await adminTransaction(req, res, async (tx, workspaceId) => {
      const rows = (
        await tx.query(
          "UPDATE memberships SET active = $1 WHERE workspace_id = $2 AND actor_id = $3 AND role = 'member' RETURNING actor_id",
          [active, workspaceId, id],
        )
      ).rows;
      if (!rows.length) throw new ApiError(404, '普通成员不存在');
    });
    res.json({ ok: true });
  });

  app.get(
    '/api/customers',
    business((ctx, req) => browse.customers(ctx, req.query)),
  );
  app.get(
    '/api/projects',
    business((ctx, req) => browse.projects(ctx, req.query)),
  );
  app.get(
    '/api/people',
    business((ctx, req) => people.browsePeople(ctx, req.query)),
  );
  app.post(
    '/api/people',
    business((ctx, req) => people.createPerson(ctx, req.body), 201),
  );
  app.get(
    '/api/people/:id',
    business((ctx, req) => people.person(ctx, v.uuid.parse(req.params.id))),
  );
  app.patch(
    '/api/people/:id',
    business((ctx, req) => people.updatePerson(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/lists',
    business((ctx) => lists.allLists(ctx)),
  );
  app.post(
    '/api/lists',
    business((ctx, req) => lists.createList(ctx, req.body), 201),
  );
  app.patch(
    '/api/lists/:id',
    business((ctx, req) => lists.renameList(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/lists/:id/entries',
    business((ctx, req) => lists.changeEntries(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.delete(
    '/api/lists/:id/entries',
    business((ctx, req) => lists.changeEntries(ctx, v.uuid.parse(req.params.id), req.body, true)),
  );
  app.get(
    '/api/lists/:id/fields',
    business((ctx, req) => workflow.fields(ctx, v.uuid.parse(req.params.id))),
  );
  app.post(
    '/api/lists/:id/fields',
    business((ctx, req) => workflow.createField(ctx, v.uuid.parse(req.params.id), req.body), 201),
  );
  app.patch(
    '/api/lists/:id/fields/:fieldId',
    business((ctx, req) =>
      workflow.updateField(
        ctx,
        v.uuid.parse(req.params.id),
        v.uuid.parse(req.params.fieldId),
        req.body,
      ),
    ),
  );
  app.post(
    '/api/lists/:id/browse',
    business((ctx, req) => workflow.browseEntries(ctx, v.uuid.parse(req.params.id), req.body)),
  );
  app.patch(
    '/api/lists/:id/entries/:entryId',
    business((ctx, req) =>
      workflow.updateEntry(
        ctx,
        v.uuid.parse(req.params.id),
        v.uuid.parse(req.params.entryId),
        req.body,
      ),
    ),
  );
  app.get(
    '/api/views',
    business(
      async (ctx) =>
        (
          await ctx.tx.query(
            'SELECT id, object, name, config, version, list_id FROM saved_views WHERE workspace_id = $1 AND actor_id = $2 ORDER BY created_at, id',
            [ctx.workspaceId, ctx.actorId],
          )
        ).rows,
    ),
  );
  app.post(
    '/api/views',
    business(async (ctx, req) => {
      const input = v.viewInput.parse(req.body);
      await attributes.validateViewColumns(ctx, input.object, input.config.columns);
      if (input.list_id) {
        await lists.getList(ctx, input.list_id, input.object);
        if (input.config.list_config)
          validateListConfig(input.config.list_config, await workflow.fields(ctx, input.list_id));
      }
      return (
        await ctx.tx.query(
          'INSERT INTO saved_views(workspace_id, actor_id, id, object, name, config, list_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, object, name, config, version, list_id',
          [
            ctx.workspaceId,
            ctx.actorId,
            randomUUID(),
            input.object,
            input.name,
            JSON.stringify(input.config),
            input.list_id || null,
          ],
        )
      ).rows[0];
    }, 201),
  );
  app.patch(
    '/api/views/:id',
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.id);
      const { version, ...fields } = v.viewUpdate.parse(req.body);
      const input = v.viewInput.parse(fields);
      await attributes.validateViewColumns(ctx, input.object, input.config.columns);
      const existing = (
        await ctx.tx.query<{ object: string; list_id: string | null }>(
          'SELECT object, list_id FROM saved_views WHERE workspace_id = $1 AND id = $2',
          [ctx.workspaceId, id],
        )
      ).rows[0];
      if (!existing) throw new ApiError(404, '视图不存在或无权访问');
      if (existing.list_id !== (input.list_id || null))
        throw new ApiError(400, '视图所属清单不可修改');
      if (existing.object !== input.object) throw new ApiError(400, '视图对象不可修改');
      if (input.list_id && input.config.list_config)
        validateListConfig(input.config.list_config, await workflow.fields(ctx, input.list_id));
      const row = (
        await ctx.tx.query(
          'UPDATE saved_views SET name = $1, config = $2 WHERE workspace_id = $3 AND id = $4 AND version = $5 RETURNING id, object, name, config, version, list_id',
          [input.name, JSON.stringify(input.config), ctx.workspaceId, id, version],
        )
      ).rows[0];
      if (!row) throw new ApiError(409, '视图已被修改，请重新载入或另存视图');
      return row;
    }),
  );
  app.delete(
    '/api/views/:id',
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.id);
      const { version } = z.strictObject({ version: z.number().int().positive() }).parse(req.body);
      const existing = (
        await ctx.tx.query('SELECT id FROM saved_views WHERE workspace_id = $1 AND id = $2', [
          ctx.workspaceId,
          id,
        ])
      ).rows[0];
      if (!existing) throw new ApiError(404, '视图不存在或无权访问');
      const deleted = (
        await ctx.tx.query(
          'DELETE FROM saved_views WHERE workspace_id = $1 AND id = $2 AND version = $3 RETURNING id',
          [ctx.workspaceId, id, version],
        )
      ).rows;
      if (!deleted.length) throw new ApiError(409, '视图已被修改，请重新载入');
      return { ok: true };
    }),
  );
  app.post(
    '/api/customers',
    business(async (ctx, req) => {
      requireAdmin(ctx);
      const input = v.customerCreate.parse(req.body);
      await service.validateOwner(ctx, input.owner_id);
      const created = await service.insert(ctx, 'customers', input);
      await people.syncPrimary(ctx, created as unknown as Customer);
      return created;
    }, 201),
  );
  app.get(
    '/api/customers/:id',
    business(async (ctx, req) => service.customer(ctx, v.uuid.parse(req.params.id))),
  );
  app.patch(
    '/api/customers/:id',
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.id);
      const input = v.customerUpdate.parse(req.body);
      const row = await service.customer(ctx, id, true);
      if (row.archived_at && (input.archived !== false || Object.keys(input).length !== 2))
        throw new ApiError(409, '请先恢复客户再编辑');
      await service.validateOwner(ctx, input.owner_id, id);
      const updated = await service.update(ctx, 'customers', id, input);
      if (['contact_name', 'email', 'phone'].some((k) => Object.hasOwn(input, k)))
        await people.syncPrimary(ctx, updated as unknown as Customer);
      return updated;
    }),
  );
  const customerPath = '/api/customers/:customerId';
  app.get(
    `${customerPath}/projects`,
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.customerId);
      await service.customer(ctx, id);
      return (
        await ctx.tx.query(
          "SELECT *, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM projects WHERE workspace_id = $1 AND customer_id = $2 ORDER BY archived_at NULLS FIRST, updated_at DESC, id",
          [ctx.workspaceId, id],
        )
      ).rows;
    }),
  );
  app.post(
    `${customerPath}/projects`,
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.customerId);
      service.activeCustomer(await service.customer(ctx, id, true));
      const input = v.projectCreate.parse(req.body);
      await service.validateOwner(ctx, input.owner_id, id);
      return service.insert(ctx, 'projects', { ...input, customer_id: id });
    }, 201),
  );
  app.get(
    `${customerPath}/projects/:id`,
    business(async (ctx, req) => {
      const customerId = v.uuid.parse(req.params.customerId);
      await service.customer(ctx, customerId);
      return service.project(ctx, customerId, v.uuid.parse(req.params.id));
    }),
  );
  app.patch(
    `${customerPath}/projects/:id`,
    business(async (ctx, req) => {
      const customerId = v.uuid.parse(req.params.customerId),
        id = v.uuid.parse(req.params.id);
      service.activeCustomer(await service.customer(ctx, customerId, true));
      const row = await service.project(ctx, customerId, id);
      const input = v.projectUpdate.parse(req.body);
      await prospects.validateProjectUpdate(ctx, customerId, id, input);
      if (row.archived_at && (input.archived !== false || Object.keys(input).length !== 2))
        throw new ApiError(409, '请先恢复项目再编辑');
      await service.validateOwner(ctx, input.owner_id, customerId);
      return service.update(ctx, 'projects', id, input, customerId);
    }),
  );
  app.get(
    `${customerPath}/records`,
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.customerId);
      await service.customer(ctx, id);
      const { project_id: projectId } = z
        .strictObject({ project_id: v.uuid.optional() })
        .parse(req.query);
      if (projectId) await service.project(ctx, id, projectId);
      return (
        await ctx.tx.query(
          `SELECT * FROM customer_records WHERE workspace_id = $1 AND customer_id = $2
       AND ($3::uuid IS NULL OR project_id = $3) ORDER BY created_at DESC, id LIMIT 100`,
          [ctx.workspaceId, id, projectId ?? null],
        )
      ).rows;
    }),
  );
  app.post(
    `${customerPath}/records`,
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.customerId);
      service.activeCustomer(await service.customer(ctx, id, true));
      const input = v.recordCreate.parse(req.body);
      if (input.project_id) {
        const p = await service.project(ctx, id, input.project_id);
        if (p.archived_at) throw new ApiError(409, '项目已归档');
      }
      return service.insert(ctx, 'customer_records', {
        ...input,
        customer_id: id,
        created_by: ctx.actorId,
      });
    }, 201),
  );
  app.post(
    `${customerPath}/shopify/messages`,
    business(
      (ctx, req) => importShopifyInboxMessage(ctx, v.uuid.parse(req.params.customerId), req.body),
      201,
    ),
  );
  app.get(
    `${customerPath}/audit`,
    business(async (ctx, req) => {
      const id = v.uuid.parse(req.params.customerId);
      await service.customer(ctx, id);
      return (
        await ctx.tx.query(
          'SELECT * FROM audit_events WHERE workspace_id = $1 AND customer_id = $2 ORDER BY created_at DESC, id LIMIT 100',
          [ctx.workspaceId, id],
        )
      ).rows;
    }),
  );
  app.get(
    `${customerPath}/access`,
    business(async (ctx, req) => {
      requireAdmin(ctx);
      const id = v.uuid.parse(req.params.customerId);
      await service.customer(ctx, id);
      return (
        await ctx.tx.query(
          'SELECT actor_id, access FROM customer_access WHERE workspace_id = $1 AND customer_id = $2',
          [ctx.workspaceId, id],
        )
      ).rows;
    }),
  );
  app.put(
    `${customerPath}/access/:actorId`,
    business(async (ctx, req) => {
      requireAdmin(ctx);
      const id = v.uuid.parse(req.params.customerId),
        actorId = v.uuid.parse(req.params.actorId);
      await service.customer(ctx, id);
      const { access } = z
        .strictObject({ access: z.enum(['viewer', 'editor']).nullable() })
        .parse(req.body);
      const member = (
        await ctx.tx.query<{ role: string; active: boolean }>(
          'SELECT role, active FROM workspace_people WHERE workspace_id = $1 AND actor_id = $2',
          [ctx.workspaceId, actorId],
        )
      ).rows[0];
      if (!member || member.role !== 'member' || (!member.active && access !== null))
        throw new ApiError(400, '请选择当前工作空间的有效普通成员');
      if (access === null) {
        await ctx.tx.query(
          'DELETE FROM customer_access WHERE workspace_id = $1 AND customer_id = $2 AND actor_id = $3',
          [ctx.workspaceId, id, actorId],
        );
      } else {
        await ctx.tx.query(
          `INSERT INTO customer_access(workspace_id, customer_id, actor_id, access) VALUES ($1, $2, $3, $4)
        ON CONFLICT (workspace_id, customer_id, actor_id) DO UPDATE SET access = EXCLUDED.access`,
          [ctx.workspaceId, id, actorId, access],
        );
      }
      return { ok: true };
    }),
  );
  app.use('/api', (_req, _res) => {
    throw new ApiError(404, '接口不存在');
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        error: '输入格式不正确',
        details: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const code = (error as { code?: string })?.code;
    if (code === '23505') {
      res.status(409).json({ error: '记录已存在，请检查输入' });
      return;
    }
    if (['23503', '23514', '42501', '22007', '22008'].includes(code ?? '')) {
      res.status(400).json({ error: '数据归属、权限或字段不符合约束' });
      return;
    }
    if ((error as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({ error: '请求内容过大' });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'JSON 格式不正确' });
      return;
    }
    // Never print SQL parameters, request bodies or customer material.
    console.error('API failure', {
      code: code ?? 'unknown',
      type: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: '服务暂时不可用，请稍后重试' });
  });
  return app;
}
