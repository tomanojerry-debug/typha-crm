import { useRef, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import type { WorkflowMailTemplate, WorkflowTemplateChoice } from '../shared/home-workflows';
import { searchMailTemplates } from '../shared/mail-templates';
import { mailVariableText } from '../shared/mail-variables';
import { Dialog } from './WorkspaceUI';
import './mail-template-library.css';
import './workflow-mail-template-preview.css';

export const workflowTemplateKey = (template: Pick<WorkflowMailTemplate, 'id' | 'kind'>) =>
  `${template.kind}:${template.id}`;

export function workflowTemplatePreviewSelection(
  templates: WorkflowMailTemplate[],
  selectedKey: string,
  query: string,
) {
  const matches = searchMailTemplates(query, templates) as WorkflowMailTemplate[];
  const selected = selectedKey
    ? matches.find((template) => workflowTemplateKey(template) === selectedKey)
    : matches[0];
  return { matches, selected };
}

export function WorkflowMailTemplatePreview({
  templates,
  initialKey,
  draftOnChoose,
  disabled,
  loading,
  error,
  onReload,
  onClose,
  onConfirm,
}: {
  templates: WorkflowMailTemplate[];
  initialKey: string;
  draftOnChoose: boolean;
  disabled: boolean;
  loading: boolean;
  error: string;
  onReload: () => void;
  onClose: () => void;
  onConfirm: (choice: WorkflowTemplateChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const confirmed = useRef(false);
  const { matches, selected } = workflowTemplatePreviewSelection(templates, selectedKey, query);
  const blocked = disabled || loading || !!error;
  return (
    <Dialog
      title="选择邮件模板"
      className="mail-template-library workflow-template-preview"
      onClose={onClose}
    >
      <div className="template-library-toolbar">
        <label className="template-library-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedKey('');
            }}
            placeholder="搜索模板…"
            aria-label="搜索全部邮件模板"
            maxLength={200}
            autoComplete="off"
          />
        </label>
      </div>
      {loading && (
        <p className="template-library-loading" role="status">
          正在加载可用模板…
        </p>
      )}
      {error && (
        <div className="template-library-load-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={onReload} disabled={disabled || loading}>
            重试加载
          </button>
        </div>
      )}
      <div className="template-library-content">
        <section className="template-library-sidebar" aria-label="模板列表">
          <p className="template-library-count" role="status">
            {matches.length} 个模板
          </p>
          <div className="template-library-list">
            {matches.map((template) => (
              <button
                type="button"
                key={workflowTemplateKey(template)}
                className={
                  selected && workflowTemplateKey(selected) === workflowTemplateKey(template)
                    ? 'is-selected'
                    : ''
                }
                aria-pressed={Boolean(
                  selected && workflowTemplateKey(selected) === workflowTemplateKey(template),
                )}
                disabled={blocked}
                onClick={() => setSelectedKey(workflowTemplateKey(template))}
              >
                <FileText size={15} aria-hidden="true" />
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.kind === 'starter' ? '起步模板' : '本人可用模板'}</small>
                </span>
              </button>
            ))}
            {!matches.length && !loading && (
              <p className="template-library-empty">
                {query.trim() ? '没有匹配的模板，试试其他关键词。' : '当前没有可用模板。'}
              </p>
            )}
          </div>
        </section>
        <section className="template-library-preview" aria-label="模板预览">
          {selected ? (
            <>
              <div className="template-library-preview-heading">
                <span>{selected.kind === 'starter' ? '起步模板' : '本人可用模板'}</span>
                <h3>{selected.name}</h3>
                {selected.description && <p>{selected.description}</p>}
              </div>
              <div className="template-library-subject">
                <span>主题</span>
                <p>
                  {(selected.variable_document
                    ? mailVariableText(selected.variable_document.subject)
                    : selected.subject
                  ).trim() || '无预设主题'}
                </p>
              </div>
              <div className="template-library-body">
                {selected.variable_document
                  ? mailVariableText(selected.variable_document.body)
                  : selected.body}
              </div>
              {selected.variable_document && (
                <p className="template-library-notice">
                  变量尚未绑定，拟稿后在写信窗口核对实际值。
                </p>
              )}
            </>
          ) : (
            <p className="template-library-empty">
              {selectedKey ? '此模板当前不可用，请选择其他模板。' : '选择模板后在这里预览。'}
            </p>
          )}
        </section>
      </div>
      <footer className="template-library-footer">
        <p>模板提供写信框架，价格、交期等仍需实际依据。</p>
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={blocked || !selected}
          onClick={() => {
            if (confirmed.current || blocked || !selected) return;
            confirmed.current = true;
            onConfirm({ kind: selected.kind, id: selected.id });
          }}
        >
          {draftOnChoose ? '使用此模板并拟稿' : '使用此模板'}
        </button>
      </footer>
    </Dialog>
  );
}
