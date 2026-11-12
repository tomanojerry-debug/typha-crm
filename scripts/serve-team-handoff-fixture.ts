// Password-based walkthrough. Only synthetic data enters an in-memory database.
// The app receives a local-only outbound transport and no inbound/provider keys.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { createSchema, createType } from '../server/business-activities.js';
import { migrate, openDatabase } from '../server/db.js';
import { requireLocalRequest } from '../server/local-access.js';
import { seal } from '../server/mail-secrets.js';
import { setSenderGrant, startOutgoingWorker } from '../server/outgoing.js';
import { createPerson } from '../server/people.js';
import { ApiError, hashPassword, scoped } from '../server/security.js';
import { insert } from '../server/service.js';
import { SubmissionError, type SendTransport } from '../server/smtp-transport.js';
import { activityBaseField as field } from '../shared/business-activities.js';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '::1' },
    port: { type: 'string', default: '3100' },
    dist: { type: 'string' },
    artifacts: { type: 'string' },
  },
});
const host = values.host;
const port = Number(values.port);
assert(host === '::1' || host === '127.0.0.1', '验收服务必须绑定明确的本机回环地址');
assert(Number.isInteger(port) && port >= 1024 && port <= 65535, '端口无效');
assert(port !== 3100 || host === '::1', '3100 验收服务使用 IPv6 回环，日常 IPv4 实例独立');
assert(values.dist && isAbsolute(values.dist), '请用 --dist 指定已构建前端的绝对目录');
const dist = await realpath(values.dist);
assert((await stat(resolve(dist, 'index.html'))).isFile(), '前端构建缺少 index.html');
assert((await stat(resolve(dist, 'assets'))).isDirectory(), '前端构建缺少 assets');
const origin = `http://${host === '::1' ? '[::1]' : host}:${port}`;

const verificationRoot = resolve('.local/verification');
const artifacts = resolve(
  values.artifacts || resolve(verificationRoot, `team-handoff-fixture-${port}`),
);
assert(
  artifacts.startsWith(`${verificationRoot}${sep}`),
  '验收产物须放在 .local/verification 子目录',
);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
assert(
  (await realpath(artifacts)).startsWith(`${await realpath(verificationRoot)}${sep}`),
  '验收产物目录不能指向 .local/verification 之外',
);

const newPassword = () => randomBytes(20).toString('base64url');
const admin = {
  displayName: '验收老板',
  email: 'admin@handoff.invalid',
  password: newPassword(),
};
const seller = {
  displayName: '验收国内业务员',
  email: 'sales@handoff.invalid',
  password: newPassword(),
};
const overseas = {
  displayName: '验收外贸业务员',
  email: 'overseas@handoff.invalid',
  password: newPassword(),
};
const designer = {
  displayName: '验收设计师',
  email: 'design@handoff.invalid',
  password: newPassword(),
};
const loginAccounts = [
  { label: '老板', email: admin.email },
  { label: '外贸业务员', email: overseas.email },
  { label: '国内业务员', email: seller.email },
  { label: '设计师', email: designer.email },
];
const customerName = '星河舞团（虚构）';
const customerEmail = 'customer@handoff.invalid';
const overseasCustomerName = 'Aurora 舞蹈用品（虚构）';
const overseasCustomerEmail = 'aurora@handoff.invalid';
const projectName = '秋季演出服尺码验收（虚构）';
const activityTitle = '团体定制尺码核对（虚构）';
const senderEmail = 'sample-sender@handoff.invalid';
const brief = '请核对款式 YF-02 的三位队员尺码，整理尺码表并将特殊尺寸单列。';
const sourceText =
  '虚构客户请求确认 YF-02 团体演出服尺码：队员 A 选 S 码，队员 B 选 M 码，队员 C 需核对特殊尺寸。请先提供尺码汇总，客户确认后再安排生产。';
const csv =
  '\uFEFF队员,款式,尺码,备注\r\n队员A,YF-02,S,虚构样例\r\n队员B,YF-02,M,虚构样例\r\n队员C,YF-02,待核对,特殊尺寸单列\r\n';

const db = await openDatabase();
const key = randomBytes(32);
const mailIds = new Set<string>();
const transport: SendTransport = {
  async send({ mail, email }) {
    if (
      email !== senderEmail ||
      [...mail.to, ...mail.cc, ...mail.bcc].some((address) => !address.endsWith('@handoff.invalid'))
    )
      throw new SubmissionError('验收邮箱仅接受 handoff.invalid 测试地址', true);
    if (!mail.message_id) throw new SubmissionError('模拟邮件缺少发送标识', true);
    mailIds.add(mail.message_id);
  },
  async checkSent({ mail }) {
    return !!mail.message_id && mailIds.has(mail.message_id);
  },
};

let stopOutgoing: (() => Promise<void>) | undefined;
try {
  await migrate(db);
  const owner = await createWorkspace(db, { name: 'Typha 尺码交接验收 · 全部虚构', ...admin });
  const members = [seller, overseas, designer];
  const passwordHashes = await Promise.all(members.map((member) => hashPassword(member.password)));
  const memberIds = members.map(() => randomUUID());
  await db.transaction(async (tx) => {
    for (const [index, member] of members.entries()) {
      await tx.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
        memberIds[index],
        member.email,
        member.displayName,
        passwordHashes[index],
      ]);
      await tx.query(
        "INSERT INTO memberships(workspace_id,actor_id,role,workspace_mode) VALUES($1,$2,'member',$3)",
        [owner.workspaceId, memberIds[index], member === designer ? 'tasks' : 'crm'],
      );
    }
  });
  const seed = await scoped(db, owner.actorId, owner.workspaceId, async (ctx) => {
    const workspace = ctx.workspaceId;
    const ownerId = ctx.actorId;
    const salesperson = memberIds[0];
    const overseasSalesperson = memberIds[1];
    const company = await insert(ctx, 'customers', {
      name: customerName,
      type: 'group',
      source: 'email',
      status: 'active',
      email: customerEmail,
      owner_id: salesperson,
    });
    const customer = company.id as string;
    await ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [workspace, customer, salesperson],
    );
    const overseasCompany = await insert(ctx, 'customers', {
      name: overseasCustomerName,
      type: 'distributor',
      source: 'email',
      status: 'active',
      email: overseasCustomerEmail,
      owner_id: overseasSalesperson,
    });
    const overseasCustomer = overseasCompany.id as string;
    await ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [workspace, overseasCustomer, overseasSalesperson],
    );
    await insert(ctx, 'projects', {
      customer_id: overseasCustomer,
      name: '海外经销款询盘（虚构）',
      type: 'inquiry',
      stage: 'in_progress',
      owner_id: overseasSalesperson,
    });
    await createPerson(ctx, {
      customer_id: overseasCustomer,
      name: 'Alex（虚构）',
      email: overseasCustomerEmail,
      job_title: '经销商联系人',
    });
    const projectRow = await insert(ctx, 'projects', {
      customer_id: customer,
      name: projectName,
      type: 'custom',
      stage: 'in_progress',
      owner_id: salesperson,
    });
    const project = projectRow.id as string;
    const person = await createPerson(ctx, {
      customer_id: customer,
      name: '王老师（虚构）',
      email: customerEmail,
      job_title: '舞团领队',
    });
    const schema = await createSchema(ctx, { name: '尺码交接验收表单' });
    const type = await createType(ctx, { name: '团体定制交接（虚构）', schema_id: schema.id });
    const run = randomUUID(),
      activity = randomUUID(),
      mailbox = randomUUID();
    const summary = `上游要求（虚构）：${brief} 收到尺码表后，由业务员核对，再发给王老师确认。如需默认抄送「${overseas.displayName}」，请先让老板给该业务员授予此客户的只读权限。`;
    const occurred = new Date().toISOString();
    const activityValues = {
      [field.customer]: customer,
      [field.project]: project,
      [field.title]: activityTitle,
      [field.summary]: summary,
      [field.occurred]: occurred,
      [field.handler]: salesperson,
      'system:id': activity,
      'system:created_by': ownerId,
      'system:created_at': occurred,
      'system:updated_at': occurred,
    };
    await ctx.tx.query(
      `INSERT INTO activity_runs(workspace_id,customer_id,id,actor_id,request_id,input_digest,config_digest,type_id,state,lease_token,source_ids,snapshot)
       VALUES($1,$2,$3,$4,$5,'fixture-input','fixture-config',$6,'running',$7,'[]','{}')`,
      [workspace, customer, run, ownerId, randomUUID(), type.id, randomUUID()],
    );
    await ctx.tx.query(
      `INSERT INTO business_activities(workspace_id,customer_id,id,project_id,type_id,run_id,event_key,type_name,title,summary,occurred_at,handler_id,fields,values,ai_values,field_provenance,source_versions,created_by)
       VALUES($1,$2,$3,$4,$5,$6,'fixture',$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,'{}','{}','{}',$14)`,
      [
        workspace,
        customer,
        activity,
        project,
        type.id,
        run,
        type.name,
        activityTitle,
        summary,
        occurred,
        salesperson,
        JSON.stringify(type.effective_fields),
        JSON.stringify(activityValues),
        ownerId,
      ],
    );
    await ctx.tx.query(
      "UPDATE activity_runs SET state='completed' WHERE workspace_id=$1 AND id=$2",
      [workspace, run],
    );
    await ctx.tx.query(
      'INSERT INTO activity_people(workspace_id,customer_id,activity_id,person_id) VALUES($1,$2,$3,$4)',
      [workspace, customer, activity, person.id],
    );
    const original = await insert(ctx, 'customer_records', {
      customer_id: customer,
      project_id: project,
      kind: 'customer_quote',
      body: sourceText,
      created_by: ownerId,
      source_kind: 'manual',
      occurred_at: occurred,
    });
    await ctx.tx.query(
      'INSERT INTO activity_record_sources(workspace_id,customer_id,activity_id,record_id) VALUES($1,$2,$3,$4)',
      [workspace, customer, activity, original.id],
    );
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [
        workspace,
        mailbox,
        senderEmail,
        seal('synthetic-only', key, `${workspace}:${mailbox}`),
        ownerId,
      ],
    );
    await setSenderGrant(ctx, mailbox, salesperson, { allowed: true });
    await setSenderGrant(ctx, mailbox, overseasSalesperson, { allowed: true });
    return {
      workspace_id: workspace,
      customer_id: customer,
      overseas_customer_id: overseasCustomer,
      project_id: project,
      activity_id: activity,
      mailbox_id: mailbox,
    };
  });

  const outgoing = { key, transport };
  const app = createApp(db, { origin, development: true, outgoing });
  const outer = express();
  outer.disable('x-powered-by');
  outer.use((request, response, next) => {
    requireLocalRequest(request, origin);
    response.set('Cache-Control', 'no-store');
    response.set('X-Typha-Synthetic', 'true');
    response.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    );
    next();
  });
  outer.post('/api/mail/accounts/:id/test-smtp', (_request, response) => {
    response.status(503).json({ error: '验收环境使用模拟发信，不探测真实邮箱' });
  });
  outer.get('/fixture-meta', (_request, response) =>
    response.json({ synthetic: true, origin, ...seed, mock_submissions: mailIds.size }),
  );
  outer.get('/api/fixture-login-accounts', (_request, response) => response.json(loginAccounts));
  outer.get('/fixtures/size-sheet.csv', (_request, response) => {
    response.attachment('fixture-size-sheet.csv').type('text/csv').send(csv);
  });
  outer.use(app);
  outer.use(
    '/assets',
    express.static(resolve(dist, 'assets'), { index: false, dotfiles: 'deny', fallthrough: false }),
  );
  outer.get('/', (_request, response) => response.sendFile('index.html', { root: dist }));
  outer.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ApiError) response.status(error.status).json({ error: error.message });
    else response.status(404).end();
  });
  const server = await new Promise<ReturnType<typeof outer.listen>>((accept, reject) => {
    const listener = outer.listen({ host, port, ipv6Only: host === '::1' }, () => accept(listener));
    listener.once('error', reject);
  });

  async function stop() {
    await stopOutgoing?.();
    await new Promise<void>((accept) => {
      server.close(() => accept());
      server.closeAllConnections();
    });
    await db.close();
  }
  try {
    const accountFile = resolve(artifacts, 'accounts.txt');
    const sizeSheet = resolve(artifacts, 'fixture-size-sheet.csv');
    const accounts = [admin, overseas, seller, designer]
      .map((member) => `${member.displayName}\n邮箱 ${member.email}\n密码 ${member.password}`)
      .join('\n\n');
    await writeFile(
      accountFile,
      `Typha 尺码交接验收 · 全部虚构\n入口 ${origin}/\n\n${accounts}\n\n国内客户 ${customerName}\n外贸客户 ${overseasCustomerName}\n尺码交接项目 ${projectName}\n活动 ${activityTitle}\n交接要求 ${brief}\n尺码表 ${origin}/fixtures/size-sheet.csv\n\n每个账号独立登录。到「确认邮件内容」即可完成验收，继续发送也只走模拟发信。\n`,
      { mode: 0o600 },
    );
    await chmod(accountFile, 0o600);
    await writeFile(sizeSheet, csv, { mode: 0o600 });
    stopOutgoing = startOutgoingWorker(db, outgoing);
    console.log(
      JSON.stringify({
        serving: true,
        synthetic: true,
        origin,
        account_file: accountFile,
        size_sheet: sizeSheet,
        ...seed,
      }),
    );
  } catch (error) {
    await stop();
    throw error;
  }
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
} catch (error) {
  await db.close().catch(() => {});
  throw error;
}
