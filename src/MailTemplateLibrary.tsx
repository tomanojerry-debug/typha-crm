import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, FileText, Plus, Search } from 'lucide-react';
import { searchMailTemplates, type MailTemplate } from '../shared/mail-templates';
import type { SavedMailTemplate } from '../shared/mail-template-storage';
import {
  mailVariableDocumentFromText,
  mailVariableText,
  type MailVariableCatalog,
  type MailVariableDocument,
} from '../shared/mail-variables';
import { MailVariableEditor } from './MailVariableEditor';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import './mail-template-library.css';

type LibraryView = 'browse' | 'create';
type TemplateScope = 'customer' | 'personal';

function scopeLabel(template: MailTemplate) {
  if ('scope' in template) {
    if (template.scope === 'customer') return '客户专用';
    if (template.scope === 'personal') return '本人通用';
  }
  return '起步模板';
}

export function MailTemplateLibrary({
  workspace,
  customerName,
  endpoint,
  initialView,
  templates,
  onClose,
  onSelect,
  onCreated,
  loading = false,
  loadError = '',
  onReload,
  variableCatalog,
}: {
  workspace: string;
  customerName: string;
  endpoint: string;
  initialView: LibraryView;
  templates: MailTemplate[];
  onClose: () => void;
  onSelect: (template: MailTemplate) => void;
  onCreated: (template: MailTemplate) => void;
  loading?: boolean;
  loadError?: string;
  onReload?: () => void;
  variableCatalog?: MailVariableCatalog;
}) {
  const [view, setView] = useState<LibraryView>(initialView),
    [query, setQuery] = useState(''),
    [selectedId, setSelectedId] = useState(''),
    [created, setCreated] = useState<MailTemplate[]>([]),
    [name, setName] = useState(''),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState(''),
    [variableDocument, setVariableDocument] = useState<MailVariableDocument>(() =>
      mailVariableDocumentFromText('', ''),
    ),
    [scope, setScope] = useState<TemplateScope>('customer'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [savedNotice, setSavedNotice] = useState(''),
    [pending, setPending] = useState<'close' | 'browse' | null>(null);
  const id = useId(),
    searchInput = useRef<HTMLInputElement>(null),
    nameInput = useRef<HTMLInputElement>(null),
    keepButton = useRef<HTMLButtonElement>(null),
    saving = useRef(false),
    attempt = useRef<{ signature: string; requestId: string } | null>(null);
  const catalog = useMemo(() => {
    const items = new Map(templates.map((template) => [template.id, template]));
    for (const template of created) if (!items.has(template.id)) items.set(template.id, template);
    return [...items.values()];
  }, [templates, created]);
  const matches = useMemo(() => searchMailTemplates(query, catalog), [query, catalog]);
  const selected = matches.find((template) => template.id === selectedId) ?? matches[0];
  const dirty = !!name || !!subject || !!body || scope !== 'customer';

  useEffect(() => {
    if (view !== 'create' || (!dirty && !busy)) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [view, dirty, busy]);

  useEffect(() => {
    if (pending) keepButton.current?.focus();
    else if (view === 'create') nameInput.current?.focus();
    else searchInput.current?.focus();
  }, [view, pending]);

  function clearForm() {
    attempt.current = null;
    setName('');
    setSubject('');
    setBody('');
    setVariableDocument(mailVariableDocumentFromText('', ''));
    setScope('customer');
    setError('');
  }

  function leave(target: 'close' | 'browse') {
    if (saving.current) return;
    if (view === 'create' && dirty) {
      setPending(target);
      return;
    }
    if (target === 'close') onClose();
    else setView('browse');
  }

  function discard() {
    const target = pending;
    clearForm();
    setPending(null);
    if (target === 'close') onClose();
    else setView('browse');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    if (!name.trim() || !body.trim()) {
      setError('请填写模板名称和正文。');
      if (!name.trim()) nameInput.current?.focus();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError('');
    const content = {
      name: name.trim(),
      subject,
      body,
      scope,
      ...(variableCatalog ? { variable_document: variableDocument } : {}),
    };
    const signature = JSON.stringify(content);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, requestId: crypto.randomUUID() };
    try {
      const template = await api<SavedMailTemplate>(endpoint, {
        workspace,
        method: 'POST',
        body: { ...content, request_id: attempt.current.requestId },
      });
      setCreated((previous) => [...previous, template]);
      setSelectedId(template.id);
      setQuery('');
      setSavedNotice(`“${template.name}”已保存，点击“使用模板”可填入邮件。`);
      clearForm();
      setView('browse');
      onCreated(template);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={view === 'create' ? '新建模板' : '全部邮件模板'}
      className={`mail-template-library${view === 'create' ? ' template-library-create' : ''}`}
      onClose={() => (pending ? setPending(null) : leave('close'))}
    >
      {pending ? (
        <div className="template-library-discard" role="alert">
          <h3>放弃未保存的模板？</h3>
          <p>填写的内容还没有保存，放弃后将丢失。</p>
          <div>
            <button ref={keepButton} type="button" onClick={() => setPending(null)}>
              继续编辑
            </button>
            <button type="button" onClick={discard}>
              放弃更改
            </button>
          </div>
        </div>
      ) : view === 'browse' ? (
        <>
          <div className="template-library-toolbar">
            <label className="template-library-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchInput}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索模板…"
                aria-label="搜索全部邮件模板"
                maxLength={200}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                clearForm();
                setSavedNotice('');
                setView('create');
              }}
            >
              <Plus size={14} />
              新建模板
            </button>
          </div>
          {savedNotice && (
            <p className="template-library-notice" role="status">
              <Check size={14} aria-hidden="true" />
              {savedNotice}
            </p>
          )}
          {loading && (
            <p className="template-library-loading" role="status">
              正在加载已保存模板…
            </p>
          )}
          {loadError && (
            <div className="template-library-load-error" role="alert">
              <p>已保存模板加载失败：{loadError}</p>
              {onReload && (
                <button type="button" onClick={onReload} disabled={loading}>
                  重试
                </button>
              )}
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
                    key={template.id}
                    className={selected?.id === template.id ? 'is-selected' : ''}
                    aria-pressed={selected?.id === template.id}
                    onClick={() => setSelectedId(template.id)}
                  >
                    <FileText size={15} aria-hidden="true" />
                    <span>
                      <strong>{template.name}</strong>
                      <small>{scopeLabel(template)}</small>
                    </span>
                  </button>
                ))}
                {!matches.length && (
                  <p className="template-library-empty">
                    {query.trim() ? '没有匹配的模板，试试其他关键词。' : '还没有可用模板。'}
                  </p>
                )}
              </div>
            </section>
            <section className="template-library-preview" aria-label="模板预览">
              {selected ? (
                <>
                  <div className="template-library-preview-heading">
                    <span>{scopeLabel(selected)}</span>
                    <h3>{selected.name}</h3>
                    {selected.description && <p>{selected.description}</p>}
                  </div>
                  <div className="template-library-subject">
                    <span>主题</span>
                    <p>
                      {(selected.variable_document
                        ? mailVariableText(selected.variable_document.subject)
                        : selected.subject
                      ).trim() || '无预设主题，选用时保留邮件原主题'}
                    </p>
                  </div>
                  <div className="template-library-body">
                    {selected.variable_document
                      ? mailVariableText(selected.variable_document.body)
                      : selected.body}
                  </div>
                  {selected.variable_document && (
                    <p className="template-library-notice">变量尚未绑定，写信时再核对实际值。</p>
                  )}
                </>
              ) : (
                <p className="template-library-empty">选择模板后在这里预览。</p>
              )}
            </section>
          </div>
          <footer className="template-library-footer">
            <p>选用后仍可编辑，发送前请核对内容。</p>
            <button
              type="button"
              className="primary"
              disabled={!selected}
              onClick={() => selected && onSelect(selected)}
            >
              使用模板
            </button>
          </footer>
        </>
      ) : (
        <form className="template-library-form" onSubmit={save}>
          <div className="template-library-fields">
            <button
              className="template-library-back"
              type="button"
              disabled={busy}
              onClick={() => leave('browse')}
            >
              <ArrowLeft size={14} />
              全部模板
            </button>
            <label htmlFor={`${id}-name`}>
              模板名称 <span>必填</span>
            </label>
            <input
              ref={nameInput}
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：样衣反馈回复"
              maxLength={80}
              required
              disabled={busy}
            />
            <label htmlFor={`${id}-subject`}>
              邮件主题 <span>可选</span>
            </label>
            {variableCatalog ? (
              <MailVariableEditor
                label="邮件主题"
                value={variableDocument.subject}
                onChange={(nodes) => {
                  setVariableDocument((previous) => ({ ...previous, subject: nodes }));
                  setSubject(mailVariableText(nodes));
                }}
                catalog={variableCatalog}
                placeholder="输入邮件主题，输入 { 插入变量"
                maxLength={500}
                disabled={busy}
              />
            ) : (
              <input
                id={`${id}-subject`}
                value={subject}
                onChange={(event) => {
                  const text = event.target.value;
                  setSubject(text);
                  setVariableDocument((previous) => ({
                    ...previous,
                    subject: text ? [{ type: 'text', text }] : [],
                  }));
                }}
                placeholder="输入邮件主题"
                maxLength={500}
                disabled={busy}
              />
            )}
            <label htmlFor={`${id}-body`}>
              模板正文 <span>必填</span>
            </label>
            {variableCatalog ? (
              <MailVariableEditor
                label="模板正文"
                value={variableDocument.body}
                onChange={(nodes) => {
                  setVariableDocument((previous) => ({ ...previous, body: nodes }));
                  setBody(mailVariableText(nodes));
                }}
                catalog={variableCatalog}
                placeholder="输入可重复使用的邮件内容，输入 { 插入变量"
                maxLength={20000}
                multiline
                disabled={busy}
              />
            ) : (
              <textarea
                id={`${id}-body`}
                value={body}
                onChange={(event) => {
                  const text = event.target.value;
                  setBody(text);
                  setVariableDocument((previous) => ({
                    ...previous,
                    body: text ? [{ type: 'text', text }] : [],
                  }));
                }}
                placeholder="输入可重复使用的邮件内容…"
                maxLength={20000}
                required
                disabled={busy}
                rows={9}
              />
            )}
            {variableCatalog && <p>模板只保存字段引用，当前未绑定客户值。</p>}
            <fieldset className="template-library-scope" disabled={busy}>
              <legend>使用范围</legend>
              <label>
                <input
                  type="radio"
                  name={`${id}-scope`}
                  value="customer"
                  checked={scope === 'customer'}
                  onChange={() => setScope('customer')}
                />
                当前客户专用
              </label>
              <label>
                <input
                  type="radio"
                  name={`${id}-scope`}
                  value="personal"
                  checked={scope === 'personal'}
                  onChange={() => setScope('personal')}
                />
                本人通用
              </label>
              <p>
                {scope === 'customer'
                  ? `仅本人为${customerName || '当前客户'}写信时可见。`
                  : '本人为其他已授权客户写信时也可用。请只保存通用文案。'}
              </p>
            </fieldset>
            {error && (
              <p className="template-library-save-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="template-library-footer">
            <button type="button" onClick={() => leave('close')} disabled={busy}>
              取消
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? '保存中…' : '保存模板'}
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
