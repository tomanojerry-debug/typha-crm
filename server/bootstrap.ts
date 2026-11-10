import { syncPrimary } from './people.js';
import type { Customer } from '../shared/domain.js';
import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { hashPassword, scoped } from './security.js';
import { insert } from './service.js';

export async function createWorkspace(
  db: Database,
  input: { name: string; email: string; displayName: string; password: string },
) {
  const workspaceId = randomUUID(),
    actorId = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO users(id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
      [actorId, input.email.toLowerCase(), input.displayName, passwordHash],
    );
    await tx.query('INSERT INTO workspaces(id, name) VALUES ($1, $2)', [workspaceId, input.name]);
    await tx.query(
      "INSERT INTO memberships(workspace_id, actor_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, actorId],
    );
  });
  return { workspaceId, actorId };
}

export async function seedDemo(db: Database, workspaceId: string, actorId: string) {
  return scoped(db, actorId, workspaceId, async (ctx) => {
    const examples = [
      {
        name: 'Étoile 舞蹈用品 · 示例',
        type: 'distributor',
        source: 'email',
        region: '法国 · 巴黎',
        contact_name: 'Camille（虚构）',
        email: 'camille@example.com',
        status: 'active',
        projects: [
          {
            name: '春季系列样衣确认',
            type: 'sample',
            stage: 'waiting_customer',
            description: '虚构演示：确认样衣尺寸和面料手感，价格与产能待公司核实。',
          },
          {
            name: '基础练功服补货咨询',
            type: 'inquiry',
            stage: 'new',
            description: '虚构演示：收集款式与尺码需求。',
          },
        ],
      },
      {
        name: '青禾芭蕾工作室 · 示例',
        type: 'group',
        source: 'referral',
        region: '中国 · 上海',
        contact_name: '林老师（虚构）',
        email: '',
        status: 'active',
        projects: [
          {
            name: '冬季汇演团体定制',
            type: 'custom',
            stage: 'in_progress',
            description: '虚构演示：演出服需求收集中，交期尚未确认。',
          },
        ],
      },
      {
        name: 'Northline Dance · 示例',
        type: 'distributor',
        source: 'email',
        region: '英国 · 伦敦',
        contact_name: 'Alex（虚构）',
        email: 'alex@example.com',
        status: 'potential',
        projects: [
          {
            name: '经销合作初步询盘',
            type: 'inquiry',
            stage: 'new',
            description: '虚构演示：需要进一步了解客户的合作范围。',
          },
        ],
      },
      {
        name: '小夏 · 示例',
        type: 'retail',
        source: 'taobao',
        region: '中国 · 杭州',
        contact_name: '小夏（虚构）',
        email: '',
        status: 'potential',
        projects: [],
      },
      {
        name: '拾光舞蹈社 · 示例',
        type: 'group',
        source: 'douyin',
        region: '中国 · 苏州',
        contact_name: '周老师（虚构）',
        email: '',
        status: 'paused',
        projects: [],
      },
    ];
    for (const example of examples) {
      const { projects, ...fields } = example;
      const c = await insert(ctx, 'customers', { ...fields, phone: '', owner_id: actorId });
      await syncPrimary(ctx, c as unknown as Customer);
      for (const p of projects)
        await insert(ctx, 'projects', {
          ...p,
          customer_id: c.id,
          due_date: null,
          owner_id: actorId,
        });
      await insert(ctx, 'customer_records', {
        customer_id: c.id,
        project_id: null,
        kind: 'inference',
        created_by: actorId,
        body: '这是人工构造的演示资料，仅用于验证客户与项目管理。尚未接入真实邮件或平台记录。',
      });
    }
  });
}
