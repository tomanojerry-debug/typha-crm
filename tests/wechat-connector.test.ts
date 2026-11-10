import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { unseal } from '../server/mail-secrets.js';
import { createWeChatConnector } from '../server/wechat-connector.js';
import { createILinkProvider, ilinkBase, type ILinkProvider } from '../server/wechat-ilink.js';
import type { WeChatOptions } from '../server/wechat.js';

const origin = 'http://localhost:3100',
  password = 'fixture-connector-password';
const key = randomBytes(32);
let db: Database,
  admin: Agent,
  workspace: string,
  actor: string,
  foreignWorkspace: string,
  foreignActor: string;
let polls = 0,
  localChecks = 0,
  historyReads = 0;
let result: Awaited<ReturnType<ILinkProvider['poll']>> = { state: 'wait' };
const provider: ILinkProvider = {
  async create() {
    return { code: 'private-qr-ticket', content: 'https://weixin.qq.com/fixture-login-only' };
  },
  async poll(_code, _base, _signal, verifyCode) {
    polls++;
    if (verifyCode) expect(verifyCode).toBe('2468');
    return result;
  },
};
const credentials = {
  token: 'private-bot-token',
  bot: 'fixture@im.bot',
  user: 'fixture@im.wechat',
  base: 'https://ilinkai.weixin.qq.com',
};
const options: WeChatOptions = {
  actorId: '',
  connectorRequired: true,
  connectorBindingEnabled: true,
  credentialKey: key,
  connectorProvider: provider,
  transport: {
    async status() {
      localChecks++;
      return {
        state: 'ready',
        message: 'fixture local ready',
        account_key: 'private-local-account',
      };
    },
    async resolve() {
      throw new Error('Binding must never enumerate contacts');
    },
    async history() {
      historyReads++;
      throw new Error('Binding must never read chat');
    },
    async openApp() {},
  },
};
const h = () => ({ origin, 'x-workspace-id': workspace });
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Connector test',
    email: 'connector@example.invalid',
    displayName: 'Admin',
    password,
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  options.actorId = actor;
  const foreign = await createWorkspace(db, {
    name: 'Foreign',
    email: 'foreign-connector@example.invalid',
    displayName: 'Other',
    password,
  });
  foreignWorkspace = foreign.workspaceId;
  foreignActor = foreign.actorId;
  admin = request.agent(createApp(db, { origin, wechat: options }));
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'connector@example.invalid', password })
    .expect(200);
});
afterAll(async () => {
  await db.close();
});

it('requires existing Typha authentication, workspace membership and the local actor', async () => {
  const app = createApp(db, { origin, wechat: options });
  await request(app).get('/api/wechat/connector').set(h()).expect(401);
  await admin
    .get('/api/wechat/connector')
    .set({ ...h(), 'x-workspace-id': foreignWorkspace })
    .expect(404);
  await expect(
    createWeChatConnector(db, { wechat: options, key }).status(foreignActor, foreignWorkspace),
  ).rejects.toThrow();
});

it('defaults to pausing bot binding and blocks new QR, polling and history without provider calls', async () => {
  let upstreamCalls = 0;
  const previousChecks = localChecks;
  const paused = request.agent(
    createApp(db, {
      origin,
      wechat: {
        ...options,
        connectorBindingEnabled: undefined,
        connectorProvider: {
          async create() {
            upstreamCalls++;
            return provider.create(new AbortController().signal);
          },
          async poll() {
            upstreamCalls++;
            return { state: 'wait' };
          },
        },
      },
    }),
  );
  await paused
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'connector@example.invalid', password })
    .expect(200);
  const status = (await paused.get('/api/wechat/connector').set(h()).expect(200)).body;
  expect(status).toMatchObject({ state: 'paused', account_verified: false });
  expect(status.qr_image).toBeUndefined();
  await paused.post('/api/wechat/connector/start').set(h()).send({}).expect(409);
  await paused
    .post('/api/wechat/connector/poll')
    .set(h())
    .send({ session_id: randomUUID() })
    .expect(409);
  const local = (await paused.get('/api/wechat/status').set(h()).expect(200)).body;
  expect(local.state).toBe('needs_setup');
  expect(local.message).toContain('请使用本机微信读取器');
  await paused
    .post('/api/wechat/queries')
    .set(h())
    .send({ identity: 'test', start: '2026-10-23', end: '2026-10-23', request_id: randomUUID() })
    .expect(409);
  expect(upstreamCalls).toBe(0);
  expect(localChecks).toBe(previousChecks);
  expect(historyReads).toBe(0);
});

it('pausing a pending confirmation prevents credentials from being saved', async () => {
  let release!: (value: Awaited<ReturnType<ILinkProvider['poll']>>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const mutableOptions = { ...options };
  const service = createWeChatConnector(db, {
    wechat: mutableOptions,
    key,
    provider: {
      create: provider.create,
      async poll() {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const qr = await service.start(actor, workspace);
  const waiting = service.poll(actor, workspace, { session_id: qr.session_id });
  await started;
  mutableOptions.connectorBindingEnabled = false;
  release({ state: 'confirmed', credentials });
  await expect(waiting).rejects.toThrow('机器人扫码绑定已停用');
  expect(await service.status(actor, workspace)).toMatchObject({ state: 'paused' });
  expect((await db.query('SELECT * FROM wechat_connectors')).rows).toHaveLength(0);
});

it('creates a genuine provider QR and never checks local accounts or reads chats before the scan', async () => {
  const initial = await admin.get('/api/wechat/status').set(h()).expect(200);
  expect(initial.body.state).toBe('needs_setup');
  expect(localChecks).toBe(0);
  const response = await admin.post('/api/wechat/connector/start').set(h()).send({}).expect(200);
  expect(response.body).toMatchObject({ state: 'waiting', account_verified: false });
  expect(response.body.qr_image).toMatch(/^data:image\/png;base64,/);
  expect(JSON.stringify(response.body)).not.toMatch(
    /private-qr-ticket|private-bot-token|im\.wechat|im\.bot/,
  );
  await admin
    .post('/api/wechat/connector/poll')
    .set(h())
    .send({ session_id: response.body.session_id })
    .expect(200);
  expect(localChecks).toBe(0);
  expect(historyReads).toBe(0);
});

it('old QR tickets are invalidated, cancellation prevents later confirmation', async () => {
  const first = (await admin.post('/api/wechat/connector/start').set(h()).send({}).expect(200))
    .body;
  const second = (await admin.post('/api/wechat/connector/start').set(h()).send({}).expect(200))
    .body;
  await admin
    .post('/api/wechat/connector/poll')
    .set(h())
    .send({ session_id: first.session_id })
    .expect(404);
  await admin
    .post('/api/wechat/connector/cancel')
    .set(h())
    .send({ session_id: second.session_id })
    .expect(200);
  await admin
    .post('/api/wechat/connector/poll')
    .set(h())
    .send({ session_id: second.session_id })
    .expect(404);
  expect((await admin.get('/api/wechat/connector').set(h()).expect(200)).body.state).toBe(
    'unbound',
  );
});

it('handles phone verification numbers and expired tickets without granting account verification', async () => {
  const state = (await admin.post('/api/wechat/connector/start').set(h()).send({}).expect(200))
    .body;
  result = { state: 'need_code' };
  expect(
    (
      await admin
        .post('/api/wechat/connector/poll')
        .set(h())
        .send({ session_id: state.session_id })
        .expect(200)
    ).body.state,
  ).toBe('need_code');
  await admin
    .post('/api/wechat/connector/poll')
    .set(h())
    .send({ session_id: state.session_id, verify_code: 'not-numeric' })
    .expect(400);
  result = { state: 'scanned' };
  expect(
    (
      await admin
        .post('/api/wechat/connector/poll')
        .set(h())
        .send({ session_id: state.session_id, verify_code: '2468' })
        .expect(200)
    ).body.state,
  ).toBe('scanned');
  result = { state: 'expired' };
  const expired = (
    await admin
      .post('/api/wechat/connector/poll')
      .set(h())
      .send({ session_id: state.session_id })
      .expect(200)
  ).body;
  expect(expired).toMatchObject({ state: 'expired', account_verified: false });
  expect(expired.qr_image).toBeUndefined();
});

it('cancelling an in-flight confirmation discards its returned credentials', async () => {
  let release!: (value: Awaited<ReturnType<ILinkProvider['poll']>>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = createWeChatConnector(db, {
    wechat: options,
    key,
    provider: {
      create: provider.create,
      async poll() {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const qr = await service.start(actor, workspace);
  const waiting = service.poll(actor, workspace, { session_id: qr.session_id });
  await started;
  await service.cancel(actor, workspace, { session_id: qr.session_id });
  release({ state: 'confirmed', credentials });
  await expect(waiting).rejects.toThrow('已取消');
  expect((await db.query('SELECT * FROM wechat_connectors')).rows).toHaveLength(0);
});

it('expires abandoned tickets without another upstream request', async () => {
  let now = Date.now(),
    calls = 0;
  const service = createWeChatConnector(db, {
    wechat: options,
    key,
    now: () => now,
    provider: {
      create: provider.create,
      async poll() {
        calls++;
        return { state: 'wait' };
      },
    },
  });
  const qr = await service.start(actor, workspace);
  now += 5 * 60000 + 1;
  expect(await service.poll(actor, workspace, { session_id: qr.session_id })).toMatchObject({
    state: 'expired',
    account_verified: false,
  });
  expect(calls).toBe(0);
});

it('membership revocation during phone confirmation prevents the binding from being saved', async () => {
  let release!: (value: Awaited<ReturnType<ILinkProvider['poll']>>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = createWeChatConnector(db, {
    wechat: options,
    key,
    provider: {
      create: provider.create,
      async poll() {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const qr = await service.start(actor, workspace);
  const waiting = service.poll(actor, workspace, { session_id: qr.session_id });
  await started;
  await db.query('UPDATE memberships SET active=false WHERE workspace_id=$1 AND actor_id=$2', [
    workspace,
    actor,
  ]);
  release({ state: 'confirmed', credentials });
  try {
    await expect(waiting).rejects.toThrow('无权访问');
  } finally {
    await db.query('UPDATE memberships SET active=true WHERE workspace_id=$1 AND actor_id=$2', [
      workspace,
      actor,
    ]);
  }
  expect((await db.query('SELECT * FROM wechat_connectors')).rows).toHaveLength(0);
});

it('stores encrypted credentials, persists the binding, and blocks CLI history until same-account proof exists', async () => {
  const state = (await admin.post('/api/wechat/connector/start').set(h()).send({}).expect(200))
    .body;
  result = { state: 'confirmed', credentials };
  const confirmed = (
    await admin
      .post('/api/wechat/connector/poll')
      .set(h())
      .send({ session_id: state.session_id })
      .expect(200)
  ).body;
  expect(confirmed).toMatchObject({ state: 'bound', account_verified: false });
  expect(JSON.stringify(confirmed)).not.toMatch(/private-|im\.wechat|im\.bot/);
  const row = (
    await db.query<{ encrypted_credentials: string; verified_account_key: null }>(
      'SELECT encrypted_credentials,verified_account_key FROM wechat_connectors',
    )
  ).rows[0];
  expect(row.encrypted_credentials).not.toContain(credentials.token);
  expect(
    JSON.parse(unseal(row.encrypted_credentials, key, `wechat-connector:${workspace}:${actor}`)),
  ).toEqual(credentials);
  expect(() =>
    unseal(row.encrypted_credentials, key, `wechat-connector:${foreignWorkspace}:${foreignActor}`),
  ).toThrow();
  expect(row.verified_account_key).toBeNull();
  const freshService = createWeChatConnector(db, { wechat: options, key, provider });
  expect((await freshService.status(actor, workspace)).state).toBe('bound');
  const local = (await admin.get('/api/wechat/status').set(h()).expect(200)).body;
  expect(local.state).toBe('needs_setup');
  expect(local.message).toContain('同一微信');
  await admin
    .post('/api/wechat/queries')
    .set(h())
    .send({ identity: 'test', start: '2026-10-23', end: '2026-10-23', request_id: randomUUID() })
    .expect(409);
  await admin
    .post('/api/wechat/connector/poll')
    .set(h())
    .send({ session_id: state.session_id, account_verified: true })
    .expect(400);
  expect(historyReads).toBe(0);
});

it('RLS protects encrypted credentials from another workspace and another actor', async () => {
  expect(
    (
      await scoped(db, foreignActor, foreignWorkspace, (ctx) =>
        ctx.tx.query('SELECT * FROM wechat_connectors'),
      )
    ).rows,
  ).toHaveLength(0);
  await db.query('INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,$3)', [
    workspace,
    foreignActor,
    'admin',
  ]);
  expect(
    (
      await scoped(db, foreignActor, workspace, (ctx) =>
        ctx.tx.query('SELECT * FROM wechat_connectors'),
      )
    ).rows,
  ).toHaveLength(0);
  await expect(
    scoped(db, foreignActor, workspace, (ctx) =>
      ctx.tx.query(
        'INSERT INTO wechat_connectors(workspace_id,actor_id,encrypted_credentials,user_hash) VALUES($1,$2,$3,$4)',
        [workspace, actor, 'forged', 'a'.repeat(64)],
      ),
    ),
  ).rejects.toThrow();
});

it('provider uses only QR endpoints and rejects arbitrary API redirects and QR destinations', async () => {
  const calls: string[] = [];
  const client = createILinkProvider(async (url, init) => {
    calls.push(String(url));
    expect(init?.redirect).toBe('error');
    expect(init?.headers).not.toHaveProperty('Authorization');
    return new Response(
      JSON.stringify(
        calls.length === 1
          ? { qrcode: 'ticket', qrcode_img_content: 'https://weixin.qq.com/qr/fixture' }
          : { status: 'scaned_but_redirect', redirect_host: 'localhost:1234' },
      ),
    );
  });
  await client.create(new AbortController().signal);
  await expect(
    client.poll('ticket', 'https://ilinkai.weixin.qq.com', new AbortController().signal),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
  expect(calls.every((url) => !/getupdates|sendmessage/.test(url))).toBe(true);
  for (const value of [
    'http://ilinkai.weixin.qq.com',
    'https://evil.test',
    'https://ilinkai.weixin.qq.com@evil.test',
    'https://ilinkai.weixin.qq.com/path',
  ])
    expect(() => ilinkBase(value)).toThrow();
  const invalid = createILinkProvider(
    async () =>
      new Response(
        JSON.stringify({ qrcode: 'ticket', qrcode_img_content: 'https://evil.test/phish' }),
      ),
  );
  await expect(invalid.create(new AbortController().signal)).rejects.toThrow();
});

it('provider errors never expose upstream response bodies or tokens', async () => {
  const client = createILinkProvider(
    async () => new Response(JSON.stringify({ errcode: 500, errmsg: 'private-upstream-secret' })),
  );
  await expect(client.create(new AbortController().signal)).rejects.toThrow(
    '暂时无法连接微信扫码服务',
  );
  expect(polls).toBeGreaterThan(0);
});
