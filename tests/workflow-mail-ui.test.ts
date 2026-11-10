import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type {
  HomeWorkflow,
  WorkflowMailTemplate,
  WorkflowReplyResponse,
} from '../shared/home-workflows.js';
import { WorkflowMailDraftCard, WorkflowMailTemplateCard } from '../src/WorkflowMailCards.js';
import { HomeWorkflow as HomeWorkflowCard } from '../src/HomeWorkflow.js';
import {
  WorkflowMailTemplatePreview,
  workflowTemplateKey,
  workflowTemplatePreviewSelection,
} from '../src/WorkflowMailTemplatePreview.js';
import {
  workflowEditorInitiallyOpen,
  workflowDraftsAfterTemplateChoice,
  workflowMailComposerState,
  workflowNeedsTemplate,
} from '../src/workflow-mail-ui.js';
import { MailTemplateLibrary } from '../src/MailTemplateLibrary.js';
import { outgoingLabels, type OutgoingMail, type OutgoingStatus } from '../shared/outgoing.js';
import type { WorkflowMailReadState } from '../src/workflow-mail-status.js';

const workflow: HomeWorkflow = {
  id: 'workflow-a',
  chat_id: 'chat-a',
  kind: 'compose',
  step: 'template',
  version: 1,
  config: {
    customer_id: 'customer-a',
    person_id: 'person-a',
    project_id: null,
    source_kinds: ['mail'],
    date_start: null,
    date_end: null,
    mail_id: null,
    document_id: null,
    material: null,
    instruction: '介绍商品',
    field_ids: [],
    template_choice: null,
  },
  result: null,
  customer_name: '示例公司',
  person_name: '示例联系人',
  project_name: null,
  draft_id: null,
  updated_at: '2026-10-29T00:00:00Z',
};

const templateCatalog: WorkflowMailTemplate[] = Array.from({ length: 4 }, (_, index) => ({
  id: `template-${index}`,
  kind: index === 0 ? 'saved' : 'starter',
  name: `真实目录模板${index + 1}`,
  description: `目录说明${index + 1}`,
  keywords: [`主题${index + 1}`],
  subject: `主题${index + 1}`,
  body: `模板${index + 1}完整正文<unsafe>\n${'仅预览，未确认。'.repeat(100)}正文末尾${index + 1}`,
}));

it('requires an explicit template choice before drafting while preserving legacy capability behavior', () => {
  expect(workflowNeedsTemplate(workflow, true)).toBe(true);
  expect(workflowNeedsTemplate(workflow, false)).toBe(false);
  expect(workflowEditorInitiallyOpen(workflow)).toBe(false);
  for (const choice of [{ kind: 'none' }, { kind: 'starter', id: 'template-a' }] as const) {
    const ready = {
      ...workflow,
      step: 'ready' as const,
      config: { ...workflow.config, template_choice: choice },
    };
    expect(workflowNeedsTemplate(ready, true)).toBe(false);
    expect(workflowEditorInitiallyOpen(ready)).toBe(false);
  }
  expect(workflowEditorInitiallyOpen({ ...workflow, step: 'configure' })).toBe(true);
});

it('automatically prepares a new-mail draft only after an explicit saved template choice and resolved customer', () => {
  expect(workflowDraftsAfterTemplateChoice(workflow)).toBe(false);
  for (const choice of [{ kind: 'none' }, { kind: 'saved', id: 'template-a' }] as const) {
    const chosen = {
      ...workflow,
      version: 2,
      config: { ...workflow.config, template_choice: choice },
    };
    expect(workflowDraftsAfterTemplateChoice(chosen)).toBe(true);
    expect(workflowDraftsAfterTemplateChoice({ ...chosen, kind: 'reply', step: 'decision' })).toBe(
      false,
    );
    expect(
      workflowDraftsAfterTemplateChoice({
        ...chosen,
        config: { ...chosen.config, customer_id: null },
      }),
    ).toBe(false);
  }
});

it('keeps the template gate free of draft or send actions and preserves the explicit skip choice', () => {
  const html = renderToStaticMarkup(
    createElement(WorkflowMailTemplateCard, {
      templates: [],
      loading: false,
      error: '',
      disabled: false,
      onChoose() {},
      onReload() {},
    }),
  );
  expect(html).toContain('这封邮件要使用模板吗');
  expect(html).toContain('查看全部模板');
  expect(html).toContain('不使用模板');
  expect(html).not.toContain('打开写信窗口');
  expect(html).not.toContain('确认发送');
});

it('shows real template entries directly without committing a choice or exposing complete template bodies', () => {
  const choose = vi.fn();
  const html = renderToStaticMarkup(
    createElement(WorkflowMailTemplateCard, {
      templates: templateCatalog,
      loading: false,
      error: '',
      disabled: false,
      onChoose: choose,
      onReload() {},
    }),
  );
  expect(html).toContain('查看模板：真实目录模板1');
  expect(html).toContain('查看模板：真实目录模板2');
  expect(html).toContain('查看模板：真实目录模板3');
  expect(html).not.toContain('真实目录模板4');
  expect(html.indexOf('真实目录模板1')).toBeLessThan(html.indexOf('真实目录模板2'));
  expect(html).toContain('查看全部模板');
  expect(html).not.toContain('正文末尾');
  expect(choose).not.toHaveBeenCalled();
});

it('previews a complete subject and body with an explicit use action and a separate cancel action', () => {
  const confirm = vi.fn(),
    close = vi.fn();
  const html = renderToStaticMarkup(
    createElement(WorkflowMailTemplatePreview, {
      templates: templateCatalog,
      initialKey: workflowTemplateKey(templateCatalog[0]),
      draftOnChoose: true,
      disabled: false,
      loading: false,
      error: '',
      onReload() {},
      onClose: close,
      onConfirm: confirm,
    }),
  );
  expect(html).toContain('搜索全部邮件模板');
  expect(html).toContain('主题1');
  expect(html).toContain('正文末尾1');
  expect(html).not.toContain('正文末尾2');
  expect(html).toContain('&lt;unsafe&gt;');
  expect(html).toContain('使用此模板并拟稿');
  expect(html).toContain('取消');
  expect(html).not.toContain('新建模板');
  expect(html).not.toContain('保存模板');
  expect(confirm).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('previews unbound template references without resolving customer values or committing a choice', () => {
  const selected: WorkflowMailTemplate = {
    ...templateCatalog[0],
    subject: '{当前公司 › 公司名称}',
    body: '{收件人 › 姓名}您好。',
    variable_document: {
      version: 1,
      subject: [
        {
          type: 'variable',
          id: 'company',
          root: 'customer',
          field: 'customers:name',
          label: '当前公司 › 公司名称',
        },
      ],
      body: [
        {
          type: 'variable',
          id: 'person',
          root: 'recipient',
          field: 'people:name',
          label: '收件人 › 姓名',
          fallback: '客户',
        },
        { type: 'text', text: '您好。' },
      ],
    },
  };
  const confirm = vi.fn();
  const html = renderToStaticMarkup(
    createElement(WorkflowMailTemplatePreview, {
      templates: [selected],
      initialKey: workflowTemplateKey(selected),
      draftOnChoose: true,
      disabled: false,
      loading: false,
      error: '',
      onReload() {},
      onClose() {},
      onConfirm: confirm,
    }),
  );
  expect(html).toContain('{当前公司 › 公司名称}');
  expect(html).toContain('{收件人 › 姓名}您好。');
  expect(html).toContain('变量尚未绑定');
  expect(html).not.toContain('客户您好。');
  expect(confirm).not.toHaveBeenCalled();
  const library = renderToStaticMarkup(
    createElement(MailTemplateLibrary, {
      workspace: 'workspace-a',
      customerName: '不可代入的客户名',
      endpoint: '/unused',
      initialView: 'browse',
      templates: [selected],
      onClose() {},
      onSelect: confirm,
      onCreated() {},
    }),
  );
  expect(library).toContain('{收件人 › 姓名}您好。');
  expect(library).toContain('变量尚未绑定');
  expect(library).not.toContain('不可代入的客户名');
  expect(confirm).not.toHaveBeenCalled();
});

it('browses only the supplied authorized catalog and never silently replaces an unavailable preview', () => {
  const first = templateCatalog[0];
  expect(
    workflowTemplatePreviewSelection(templateCatalog, workflowTemplateKey(first), '').selected,
  ).toBe(first);
  const searched = workflowTemplatePreviewSelection(templateCatalog, '', '主题3');
  expect(searched.matches).toEqual([templateCatalog[2]]);
  expect(searched.selected).toBe(templateCatalog[2]);
  const removed = workflowTemplatePreviewSelection(
    templateCatalog.slice(1),
    workflowTemplateKey(first),
    '',
  );
  expect(removed.selected).toBeUndefined();
  expect(removed.matches).toHaveLength(3);
  const html = renderToStaticMarkup(
    createElement(WorkflowMailTemplatePreview, {
      templates: templateCatalog.slice(1),
      initialKey: workflowTemplateKey(first),
      draftOnChoose: false,
      disabled: false,
      loading: false,
      error: '',
      onReload() {},
      onClose() {},
      onConfirm() {},
    }),
  );
  expect(html).toContain('此模板当前不可用');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>使用此模板<\/button>/);
});

it('marks a previously selected template unavailable instead of implying it can still be used', () => {
  const html = renderToStaticMarkup(
    createElement(WorkflowMailTemplateCard, {
      choice: { kind: 'saved', id: 'removed-template' },
      selectedName: '原有模板',
      templates: [],
      loading: false,
      error: '',
      disabled: false,
      onChoose() {},
      onReload() {},
    }),
  );
  expect(html).toContain('原有模板');
  expect(html).toContain('所选模板当前不可用');
  expect(html).toContain('需重新选择');
  expect(html).toContain('不使用模板');
  expect(html).not.toContain('已保存本次选择');
});

it('restores a template-stage task without the setup form and exposes drafting only after a saved choice', () => {
  const render = (value: HomeWorkflow) =>
    renderToStaticMarkup(
      createElement(HomeWorkflowCard, {
        workspace: 'workspace-a',
        workflow: value,
        templateWorkflows: true,
        onWorkflow() {},
        async onRun() {},
        onOpenMail() {},
      }),
    );
  const pending = render(workflow);
  expect(pending).toContain('这封邮件要使用模板吗');
  expect(pending).not.toMatch(/<button[^>]*>生成邮件草稿/);
  expect(pending).not.toContain('来信来源');
  expect(pending).not.toContain('<form');
  const chosen = render({
    ...workflow,
    step: 'ready',
    config: { ...workflow.config, template_choice: { kind: 'none' } },
  });
  expect(chosen).toContain('本次不使用模板');
  expect(chosen).toContain('生成邮件草稿');
  expect(chosen).not.toContain('确认发送');
});

it('shows one escaped compact draft card and leaves the full draft for the existing composer', () => {
  const draft = {
    ...workflow,
    result: {
      body: '已生成草稿',
      sources: [],
      decisions: [],
      changes: [],
      applied_keys: [],
      message_id: 'message-a',
      generated_at: workflow.updated_at,
      draft_subject: '<img src=x>',
      draft_body: `正文<unsafe>${'很长的内容。'.repeat(100)}末尾完整正文`,
    },
  };
  const html = renderToStaticMarkup(
    createElement(WorkflowMailDraftCard, {
      workflow: draft,
      disabled: false,
      onOpen() {},
    }),
  );
  expect(html).toContain('&lt;img src=x&gt;');
  expect(html).toContain('&lt;unsafe&gt;');
  expect(html).toContain('打开写信窗口');
  expect(html).toContain('尚未发送');
  expect(html).not.toContain('末尾完整正文');
  expect(html).not.toContain('<details');
  expect(html).not.toContain('查看原回复');
});

it('preserves the old reply action when the backend has no template-workflow capability', () => {
  const reply: HomeWorkflow = {
    ...workflow,
    kind: 'reply',
    step: 'decision',
    result: {
      body: '请确认答复口径',
      sources: [],
      decisions: ['是否提供资料'],
      changes: [],
      applied_keys: [],
      message_id: 'message-a',
      generated_at: workflow.updated_at,
      draft_body: null,
    },
  };
  const render = (enabled: boolean) =>
    renderToStaticMarkup(
      createElement(HomeWorkflowCard, {
        workspace: 'workspace-a',
        workflow: reply,
        templateWorkflows: enabled,
        onWorkflow() {},
        async onRun() {},
        onOpenMail() {},
      }),
    );
  expect(render(false)).toContain('生成回复草稿');
  expect(render(false)).not.toContain('查看全部模板');
  expect(render(true)).toContain('查看全部模板');
  expect(render(true)).not.toContain('生成回复草稿');
});

it('opens a new-mail draft without reply metadata even if a response includes a source', () => {
  const response = {
    workflow,
    draft: { id: 'draft-a' },
    plan: {
      kind: 'people',
      target: {
        id: 'person-a',
        name: '示例联系人',
        email: 'person@fixture.invalid',
        customer_id: 'customer-a',
        customer_name: '示例公司',
      },
    },
    source: { id: 'mail-a' },
  } as WorkflowReplyResponse;
  expect(workflowMailComposerState(response)).not.toHaveProperty('reply');
  expect(workflowMailComposerState(response).draftId).toBe('draft-a');
  expect(
    workflowMailComposerState({ ...response, workflow: { ...workflow, kind: 'reply' } }).reply,
  ).toBeDefined();
});

const linkedWorkflow: HomeWorkflow = {
  ...workflow,
  draft_id: 'draft-a',
  result: {
    body: '原有模型结果',
    sources: [],
    decisions: [],
    changes: [],
    applied_keys: [],
    message_id: 'message-a',
    generated_at: workflow.updated_at,
    draft_subject: '旧模型主题',
    draft_body: '旧模型正文，不应冒充实际已发送内容',
  },
};
const outgoing = (status: OutgoingStatus, patch: Partial<OutgoingMail> = {}): OutgoingMail =>
  ({
    id: 'draft-a',
    workspace_id: 'workspace-a',
    customer_id: 'customer-a',
    person_id: 'person-a',
    created_by: 'actor-a',
    version: 2,
    approved_version: null,
    status,
    subject: '当前保存主题',
    body: '当前保存正文',
    to: ['recipient@fixture.invalid'],
    ...patch,
  }) as OutgoingMail;
const renderLinkedMail = (state?: WorkflowMailReadState) =>
  renderToStaticMarkup(
    createElement(WorkflowMailDraftCard, {
      workflow: linkedWorkflow,
      mailState: state,
      disabled: false,
      onOpen() {},
      onReload() {},
    }),
  );

it('shows the actual outgoing phase instead of the old model draft for every mail state', () => {
  for (const status of Object.keys(outgoingLabels) as OutgoingStatus[]) {
    const html = renderLinkedMail({ phase: 'ready', mail: outgoing(status), error: '' });
    expect(html).toContain(outgoingLabels[status]);
    expect(html).toContain('来自发件记录 · 第 2 版');
    expect(html).toContain('recipient@fixture.invalid');
    expect(html).toContain('当前保存主题');
    expect(html).toContain('当前保存正文');
    expect(html).not.toContain('旧模型主题');
    expect(html).not.toContain('旧模型正文');
    expect(html).not.toContain('尚未发送');
    expect(html).not.toContain('重新发送');
    expect(html).not.toContain('确认立即发送');
    if (['submitted', 'sent_confirmed', 'uncertain', 'partial'].includes(status))
      expect(html).toContain('查看发件详情');
    if (['submitted', 'sent_confirmed'].includes(status))
      expect(html).toContain('不代表对方已经收到或阅读');
  }
});

it('uses confirmed real variable text for a single message and follows the current saved version', () => {
  const mail = outgoing('sent_confirmed', {
    approved_version: 2,
    subject: '{收件人所属公司}模板主题',
    body: '{收件人姓名}模板正文',
    variable_snapshot: {
      version: 1,
      preview_digest: 'synthetic-digest',
      recipient_bindings: [],
      messages: [
        {
          recipient: 'recipient@fixture.invalid',
          subject: '真实公司（虚构）已确认主题',
          body: '真实联系人（虚构）已确认正文',
          values: [],
          issues: [],
        },
      ],
    },
  });
  const html = renderLinkedMail({ phase: 'ready', mail, error: '' });
  expect(html).toContain('真实公司（虚构）已确认主题');
  expect(html).toContain('真实联系人（虚构）已确认正文');
  expect(html).not.toContain('{收件人姓名}');
  expect(html).not.toContain('尚未发送');
  const edited = renderLinkedMail({
    phase: 'ready',
    mail: { ...mail, version: 3, status: 'draft', subject: '保存后的第三版', body: '第三版正文' },
    error: '',
  });
  expect(edited).toContain('保存后的第三版');
  expect(edited).toContain('第 3 版');
  expect(edited).not.toContain('真实公司（虚构）已确认主题');
});

it('does not label unknown, disconnected or unauthorized mail as unsent or reveal old content', () => {
  for (const state of [
    undefined,
    { phase: 'loading', mail: null, error: '' },
    { phase: 'error', mail: null, error: '暂时无法核对发件状态' },
    { phase: 'unavailable', mail: null, error: '邮件已失效或无权访问' },
  ] as (WorkflowMailReadState | undefined)[]) {
    const html = renderLinkedMail(state);
    expect(html).not.toContain('尚未发送');
    expect(html).not.toContain('旧模型主题');
    expect(html).not.toContain('旧模型正文');
    expect(html).not.toContain('示例联系人');
    expect(html).not.toContain('示例公司');
    expect(html).not.toContain('打开写信窗口');
    if (state?.phase === 'error' || state?.phase === 'unavailable')
      expect(html).toContain('重新核对状态');
    else expect(html).toMatch(/<button[^>]*disabled=""[^>]*>正在核对状态/);
  }
});

it('keeps personalized mass messages separate instead of presenting the first recipient as everyone', () => {
  const mail = outgoing('partial', {
    mass_sending: true,
    to: ['one@fixture.invalid', 'two@fixture.invalid'],
    approved_version: 2,
    body: '{收件人姓名}的群发正文',
    variable_snapshot: {
      version: 1,
      preview_digest: 'synthetic-digest',
      recipient_bindings: [],
      messages: [
        {
          recipient: 'one@fixture.invalid',
          subject: '只属于第一位的主题',
          body: '只属于第一位的正文',
          values: [],
          issues: [],
        },
        {
          recipient: 'two@fixture.invalid',
          subject: '只属于第二位的主题',
          body: '只属于第二位的正文',
          values: [],
          issues: [],
        },
      ],
    },
  });
  const html = renderLinkedMail({ phase: 'ready', mail, error: '' });
  expect(html).toContain('部分已发送');
  expect(html).toContain('群发逐人内容请在详情核对');
  expect(html).toContain('one@fixture.invalid、two@fixture.invalid');
  expect(html).not.toContain('只属于第一位的正文');
  expect(html).not.toContain('只属于第二位的正文');
});
