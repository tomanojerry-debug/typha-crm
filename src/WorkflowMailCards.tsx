import { useState } from 'react';
import { FileText, Mail } from 'lucide-react';
import type {
  HomeWorkflow,
  WorkflowMailTemplate,
  WorkflowTemplateChoice,
} from '../shared/home-workflows';
import { AgentReplyCard } from './AgentReplyCards';
import { WorkflowMailTemplatePreview, workflowTemplateKey } from './WorkflowMailTemplatePreview';
import { workflowDraftPreview, workflowMailPresentation } from './workflow-mail-ui';
import type { WorkflowMailReadState } from './workflow-mail-status';
import './workflow-mail-template-preview.css';

export function WorkflowMailTemplateCard({
  choice,
  selectedName,
  templates,
  loading,
  error,
  disabled,
  draftOnChoose = false,
  onChoose,
  onReload,
}: {
  choice?: WorkflowTemplateChoice | null;
  selectedName?: string | null;
  templates: WorkflowMailTemplate[];
  loading: boolean;
  error: string;
  disabled: boolean;
  draftOnChoose?: boolean;
  onChoose: (choice: WorkflowTemplateChoice) => void;
  onReload: () => void;
}) {
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const selected =
    choice && choice.kind !== 'none'
      ? templates.find((template) => template.id === choice.id && template.kind === choice.kind)
      : undefined;
  const unavailable = Boolean(choice && choice.kind !== 'none' && !loading && !error && !selected);
  const name = choice
    ? choice.kind === 'none'
      ? '本次不使用模板'
      : selected?.name || selectedName || '已选择邮件模板'
    : '这封邮件要使用模板吗？';
  return (
    <>
      <AgentReplyCard
        className="workflow-mail-template-card"
        title={name}
        typeLabel="邮件模板"
        icon={<FileText size={19} strokeWidth={1.6} />}
        description={
          unavailable
            ? '请重新选择可用模板，或明确不使用模板后继续。'
            : choice
              ? selected?.description || '可以继续拟稿，也可以更换本次使用的模板。'
              : '点击模板查看内容，确认选用后再拟稿；也可以不使用模板。'
        }
        footer={unavailable ? '所选模板当前不可用' : choice ? '已保存本次选择' : '等待你选择'}
        state={
          unavailable
            ? { label: '需重新选择', description: '请重新选择可用模板，或明确不使用模板。' }
            : undefined
        }
      >
        {!selected && !loading && !error && templates.length > 0 && (
          <div className="workflow-template-options" aria-label="可用邮件模板">
            {templates.slice(0, 3).map((template) => (
              <button
                key={workflowTemplateKey(template)}
                type="button"
                className="workflow-template-option"
                disabled={disabled}
                aria-haspopup="dialog"
                aria-label={`查看模板：${template.name}`}
                onClick={() => setPreviewKey(workflowTemplateKey(template))}
              >
                <FileText size={16} aria-hidden="true" />
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                </span>
                <span className="workflow-template-view">查看内容</span>
              </button>
            ))}
          </div>
        )}
        <div className="workflow-mail-template-actions">
          {selected && (
            <button
              type="button"
              disabled={disabled || loading || !!error}
              aria-haspopup="dialog"
              onClick={() => setPreviewKey(workflowTemplateKey(selected))}
            >
              查看所选模板
            </button>
          )}
          <button
            type="button"
            disabled={disabled || loading || !!error || !templates.length}
            aria-haspopup="dialog"
            onClick={() => setPreviewKey('')}
          >
            查看全部模板
          </button>
          {choice?.kind !== 'none' && (
            <button type="button" disabled={disabled} onClick={() => onChoose({ kind: 'none' })}>
              不使用模板
            </button>
          )}
          {loading && <span role="status">正在加载模板…</span>}
          {error && (
            <span className="error" role="alert">
              {error}
              <button type="button" className="text-button" disabled={disabled} onClick={onReload}>
                重试加载
              </button>
            </span>
          )}
        </div>
      </AgentReplyCard>
      {previewKey !== null && (
        <WorkflowMailTemplatePreview
          key={previewKey}
          templates={templates}
          initialKey={previewKey}
          draftOnChoose={draftOnChoose}
          disabled={disabled}
          loading={loading}
          error={error}
          onReload={onReload}
          onClose={() => setPreviewKey(null)}
          onConfirm={(template) => {
            setPreviewKey(null);
            onChoose(template);
          }}
        />
      )}
    </>
  );
}

export function WorkflowMailDraftCard({
  workflow,
  mailState,
  disabled,
  onOpen,
  onReload,
}: {
  workflow: HomeWorkflow;
  mailState?: WorkflowMailReadState;
  disabled: boolean;
  onOpen: () => void;
  onReload?: () => void;
}) {
  const draft = workflow.result?.draft_body;
  if (!draft) return null;
  const view = workflowMailPresentation(workflow, mailState);
  return (
    <AgentReplyCard
      className="workflow-mail-draft-card"
      title={view.title}
      typeLabel={
        workflow.draft_id
          ? '客户邮件'
          : workflow.kind === 'compose'
            ? '新建邮件草稿'
            : '客户来信回复'
      }
      icon={<Mail size={19} strokeWidth={1.6} />}
      fields={view.fields}
      footer={view.footer}
      state={view.state}
      action={{
        label: view.actionLabel,
        primary: !workflow.draft_id,
        disabled: disabled || (!view.canOpen && !(view.canReload && onReload)),
        onClick: view.canReload ? onReload || (() => {}) : onOpen,
      }}
    >
      {view.body && (
        <p className="workflow-mail-draft-preview">{workflowDraftPreview(view.body)}</p>
      )}
    </AgentReplyCard>
  );
}
