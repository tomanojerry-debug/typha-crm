import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { migrate, openDatabase } from '../server/db.js';
import { createWorkspace, seedDemo } from '../server/bootstrap.js';

const db = await openDatabase({
  url: process.env.DATABASE_URL,
  dataDir: process.env.DATA_DIR ?? '.local/postgres',
});
try {
  await migrate(db);
  const users = await db.query('SELECT id FROM users LIMIT 1');
  if (users.rows.length) {
    console.log('数据库已初始化，未覆盖任何账号或资料。请使用现有账号登录。');
  } else {
    const demo = process.argv.includes('--demo');
    const password = randomBytes(18).toString('base64url');
    const email = process.env.BOOTSTRAP_EMAIL ?? 'admin@example.com';
    await mkdir('.local', { recursive: true, mode: 0o700 });
    // Write with exclusive creation before committing the account, so an old
    // credential file cannot leave a new database with an unrecoverable password.
    await writeFile(
      '.local/initial-login.txt',
      `登录邮箱：${email}\n初始密码：${password}\n${demo ? '本空间仅含虚构演示资料。' : '空白工作空间。'}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    const { workspaceId, actorId } = await createWorkspace(db, {
      name: demo ? '芭蕾工作室 · 演示空间' : '我的工作空间',
      email,
      displayName: '工作空间管理员',
      password,
    });
    if (demo) await seedDemo(db, workspaceId, actorId);
    console.log(
      '初始化完成。随机登录凭据保存在 .local/initial-login.txt（仅本机用户可读，已忽略 Git）。',
    );
    console.log(
      demo
        ? '已添加 5 个虚构客户及示例项目。运行 npm run dev 启动。'
        : '工作空间为空。运行 npm run dev 启动。',
    );
  }
} finally {
  await db.close();
}
