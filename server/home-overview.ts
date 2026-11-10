import type { HomeOverview, HomeOverviewItem } from '../shared/home-overview.js';
import type { Context } from './security.js';

/** Only navigation metadata enters the overview. Existing table RLS remains
 * authoritative; no message or document body is returned or sent to a model. */
export async function overview(ctx: Context): Promise<HomeOverview> {
  const result = (
    await ctx.tx.query<{
      items: HomeOverviewItem[];
      total: number;
      mail: number;
      draft: number;
      outgoing_issue: number;
      document: number;
      wechat: number;
      workflow: number;
    }>(
      `WITH items AS (
    SELECT 'mail'::text AS kind,m.id,m.subject AS title,
      concat_ws(' · ',c.name,'新来信','未读') AS subtitle,m.occurred_at AS updated_at,
      m.customer_id,c.name AS customer_name,NULL::uuid AS person_id,m.project_id,
      'unread'::text AS status,'查看邮件'::text AS action_label,2 AS priority,
      NULL::uuid AS chat_id,NULL::text AS workflow_kind
    FROM mail_messages m
    LEFT JOIN customers c ON c.workspace_id=m.workspace_id AND c.id=m.customer_id
    LEFT JOIN projects p ON p.workspace_id=m.workspace_id AND p.customer_id=m.customer_id AND p.id=m.project_id
    LEFT JOIN mail_notification_reads r ON r.workspace_id=m.workspace_id AND r.message_id=m.id AND r.actor_id=$2
    WHERE m.workspace_id=$1 AND m.direction='inbound' AND m.received_after_connection
      AND m.notification_enabled AND r.message_id IS NULL
      AND (m.customer_id IS NULL OR (c.id IS NOT NULL AND c.archived_at IS NULL))
      AND (m.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))
    UNION ALL
    SELECT CASE WHEN o.status='draft' THEN 'draft' ELSE 'outgoing_issue' END,o.id,
      coalesce(nullif(trim(o.content->>'subject'),''),'未命名邮件'),
      concat_ws(' · ',c.name,CASE o.status
        WHEN 'draft' THEN '本人草稿' WHEN 'failed' THEN '发送失败'
        WHEN 'uncertain' THEN '发送结果待核对' WHEN 'partial' THEN '部分已发送'
        WHEN 'needs_review' THEN '需要重新确认' END),
      o.updated_at,o.customer_id,c.name,o.person_id,o.project_id,o.status,
      CASE WHEN o.status='draft' THEN '继续编辑' ELSE '查看并核对' END,
      CASE WHEN o.status='draft' THEN 4 ELSE 0 END,NULL::uuid,NULL::text
    FROM outgoing_mail o
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    LEFT JOIN people pe ON pe.workspace_id=o.workspace_id AND pe.customer_id=o.customer_id AND pe.id=o.person_id
    LEFT JOIN projects p ON p.workspace_id=o.workspace_id AND p.customer_id=o.customer_id AND p.id=o.project_id
    WHERE o.workspace_id=$1 AND o.created_by=$2
      AND o.status IN ('draft','failed','uncertain','partial','needs_review')
      AND c.archived_at IS NULL
      AND (o.person_id IS NULL OR (pe.id IS NOT NULL AND pe.archived_at IS NULL))
      AND (o.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))
    UNION ALL
    SELECT 'document',d.id,d.name,'文件 · 尚未关联公司',d.updated_at,
      NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,d.status,'关联客户',5,NULL::uuid,NULL::text
    FROM documents d WHERE d.workspace_id=$1 AND d.uploaded_by=$2 AND d.customer_id IS NULL
      AND d.status='pending_association'
      AND NOT EXISTS (SELECT 1 FROM documents child WHERE child.workspace_id=d.workspace_id
        AND child.supersedes_id=d.id AND child.status IN ('ready','pending_association'))
    UNION ALL
    SELECT 'wechat',q.id,
      concat(coalesce(nullif(q.identity->>'remark',''),nullif(q.identity->>'name',''),'微信联系人'),' · 微信资料'),
      '已读取 · 尚未关联公司',q.created_at,NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,
      q.state,'关联客户',5,NULL::uuid,NULL::text
    FROM wechat_queries q WHERE q.workspace_id=$1 AND q.actor_id=$2 AND q.state='pending'
      AND jsonb_array_length(q.messages)>0
    UNION ALL
    SELECT 'workflow',w.id,
      CASE w.kind WHEN 'summary' THEN '总结沟通信息' WHEN 'reply' THEN '处理客户来信' ELSE '更新客户资料' END,
      concat_ws(' · ',c.name,CASE w.step
        WHEN 'configure' THEN CASE WHEN w.customer_id IS NULL THEN '选择对象和资料' ELSE '设置资料范围' END
        WHEN 'decision' THEN '需要你决定'
        WHEN 'review' THEN CASE WHEN w.kind='reply' THEN '回复草稿待核对' ELSE '资料变更待保存' END
        WHEN 'ready' THEN '结果已生成，可继续处理' END),
      w.updated_at,w.customer_id,c.name,w.person_id,w.project_id,w.step,'继续处理',
      CASE WHEN w.step IN ('decision','review') THEN 1 ELSE 3 END,w.chat_id,w.kind
    FROM home_workflows w
    LEFT JOIN customers c ON c.workspace_id=w.workspace_id AND c.id=w.customer_id
    LEFT JOIN people pe ON pe.workspace_id=w.workspace_id AND pe.customer_id=w.customer_id AND pe.id=w.person_id
    LEFT JOIN projects p ON p.workspace_id=w.workspace_id AND p.customer_id=w.customer_id AND p.id=w.project_id
    WHERE w.workspace_id=$1 AND w.actor_id=$2 AND w.step IN ('configure','ready','decision','review')
      AND NOT (w.kind='summary' AND w.step='ready' AND w.result IS NOT NULL)
      AND (w.kind<>'reply' OR w.draft_id IS NULL)
      AND (w.customer_id IS NULL OR (c.id IS NOT NULL AND c.archived_at IS NULL))
      AND (w.person_id IS NULL OR (pe.id IS NOT NULL AND pe.archived_at IS NULL))
      AND (w.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))
      AND (w.config->>'mail_id' IS NULL OR EXISTS (
        SELECT 1 FROM mail_messages m WHERE m.workspace_id=w.workspace_id AND m.id=(w.config->>'mail_id')::uuid
          AND m.customer_id=w.customer_id AND (w.project_id IS NULL OR m.project_id=w.project_id)
          AND (w.person_id IS NULL OR EXISTS (
            SELECT 1 FROM mail_people mp WHERE mp.workspace_id=m.workspace_id AND mp.customer_id=m.customer_id
              AND mp.message_id=m.id AND mp.person_id=w.person_id))))
      AND (w.config->>'document_id' IS NULL OR EXISTS (
        SELECT 1 FROM documents d WHERE d.workspace_id=w.workspace_id AND d.id=(w.config->>'document_id')::uuid
          AND d.status IN ('ready','pending_association')
          AND d.customer_id IS NOT DISTINCT FROM w.customer_id
          AND (w.project_id IS NULL OR d.project_id=w.project_id)))
  ), preview AS (
    SELECT kind,id,title,subtitle,updated_at,customer_id,customer_name,person_id,project_id,status,action_label,chat_id,workflow_kind
    FROM items ORDER BY priority,updated_at DESC,kind,id LIMIT 6
  )
  SELECT (SELECT coalesce(jsonb_agg(to_jsonb(preview)),'[]'::jsonb) FROM preview) AS items,
    count(*)::int AS total,
    count(*) FILTER (WHERE kind='mail')::int AS mail,
    count(*) FILTER (WHERE kind='draft')::int AS draft,
    count(*) FILTER (WHERE kind='outgoing_issue')::int AS outgoing_issue,
    count(*) FILTER (WHERE kind='document')::int AS document,
    count(*) FILTER (WHERE kind='wechat')::int AS wechat,
    count(*) FILTER (WHERE kind='workflow')::int AS workflow
  FROM items`,
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows[0];
  return {
    items: result.items,
    total: Number(result.total),
    counts: {
      mail: Number(result.mail),
      draft: Number(result.draft),
      outgoing_issue: Number(result.outgoing_issue),
      document: Number(result.document),
      wechat: Number(result.wechat),
      workflow: Number(result.workflow),
    },
  };
}
