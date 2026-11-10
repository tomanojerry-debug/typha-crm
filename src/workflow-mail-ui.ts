import type { HomeWorkflow, WorkflowReplyResponse } from '../shared/home-workflows';
import { outgoingLabels, type OutgoingStatus } from '../shared/outgoing';
import type { WorkflowMailReadState } from './workflow-mail-status';

export const isMailWorkflow = (workflow: Pick<HomeWorkflow, 'kind'>) =>
  workflow.kind === 'compose' || workflow.kind === 'reply';

export function workflowNeedsTemplate(workflow: HomeWorkflow, enabled: boolean) {
  return enabled && isMailWorkflow(workflow) && !workflow.config.template_choice;
}

export function workflowDraftsAfterTemplateChoice(workflow: HomeWorkflow) {
  return (
    workflow.kind === 'compose' &&
    Boolean(workflow.config.customer_id && workflow.config.template_choice)
  );
}

export function workflowEditorInitiallyOpen(workflow: HomeWorkflow) {
  if (workflow.step === 'configure') return true;
  if (workflow.step === 'template' || workflow.kind === 'compose') return false;
  if (workflow.kind === 'reply' && workflow.config.template_choice) return false;
  return !workflow.result;
}

export function workflowDraftPreview(body: string, limit = 240) {
  const text = body.trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

const mailStatusDescriptions: Record<OutgoingStatus, string> = {
  draft: '邮件草稿已保存，尚未确认发送。',
  approved: '当前内容已确认，尚未排期发送。',
  scheduled: '邮件已排期，等待后台执行；请勿重复发送。',
  sending: '后台正在发送这封邮件；请勿重复发送。',
  submitted: '发件服务器已接受，不代表对方已经收到或阅读。',
  sent_confirmed: '发件箱已找到相符记录，不代表对方已经收到或阅读。',
  uncertain: '发送结果尚不确定，请先在发件详情核对记录，不要直接重发。',
  partial: '群发中已有部分邮件发送，请在详情逐封核对。',
  failed: '发送未完成，请在发件详情核对原因后处理。',
  cancelled: '本次发送已取消，可以打开原邮件核对。',
  needs_review: '邮件需要重新核对内容和发送设置。',
};

export function workflowMailPresentation(workflow: HomeWorkflow, read?: WorkflowMailReadState) {
  const initial = {
    title: workflow.result?.draft_subject || '邮件草稿',
    body: workflow.result?.draft_body || '',
    footer: '待你审核 · 尚未发送',
    headingLabel: '邮件草稿已生成',
    actionLabel: '打开写信窗口',
    canOpen: Boolean(workflow.config.customer_id),
    canReload: false,
    state: undefined as { label: string; description: string } | undefined,
    fields: [
      { label: '收件对象', value: workflow.person_name || workflow.customer_name || '待选择' },
      ...(workflow.project_name ? [{ label: '关联项目', value: workflow.project_name }] : []),
    ],
  };
  // No outgoing exists until the user first opens the editable model result.
  if (!workflow.draft_id) return initial;
  if (!read || read.phase !== 'ready') {
    const loading = !read || read.phase === 'loading';
    return {
      ...initial,
      title: loading ? '正在核对邮件状态' : '邮件状态待核对',
      body: '',
      fields: [],
      footer: loading ? '正在读取当前发件记录…' : read.error,
      headingLabel: loading ? '正在核对发件状态' : '发件状态待核对',
      actionLabel: loading ? '正在核对状态' : '重新核对状态',
      canOpen: false,
      canReload: !loading,
    };
  }
  const mail = read.mail;
  const snapshot =
    mail.approved_version === mail.version &&
    mail.variable_snapshot?.messages.length === 1 &&
    (!mail.mass_sending || mail.to.length === 1)
      ? mail.variable_snapshot.messages[0]
      : undefined;
  const multi = Boolean(mail.mass_sending && mail.to.length > 1);
  const detail = ['scheduled', 'sending', 'submitted', 'sent_confirmed', 'uncertain', 'partial'];
  return {
    ...initial,
    title: (snapshot?.subject ?? mail.subject) || '（无主题）',
    body: snapshot?.body ?? mail.body,
    footer: `来自发件记录 · 第 ${mail.version} 版${multi ? ' · 群发逐人内容请在详情核对' : ''}`,
    headingLabel: outgoingLabels[mail.status],
    actionLabel: detail.includes(mail.status) ? '查看发件详情' : '打开写信窗口',
    canOpen: true,
    state: { label: outgoingLabels[mail.status], description: mailStatusDescriptions[mail.status] },
    fields: [
      { label: multi ? '群发收件人' : '收件人', value: mail.to.join('、') || '待填写' },
      { label: '归属客户', value: workflow.customer_name || '当前公司' },
    ],
  };
}

/** New mail must enter the normal composer without reply/thread metadata. */
export function workflowMailComposerState(response: WorkflowReplyResponse) {
  return {
    person: response.plan.target,
    kind: response.plan.kind,
    draftId: response.draft.id,
    ...(response.workflow.kind === 'reply' ? { reply: response } : {}),
  };
}
