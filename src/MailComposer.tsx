import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  Clock3,
  FilePlus2,
  FileText,
  Mail,
  Paperclip,
  Plus,
  Save,
  Send,
  X,
} from 'lucide-react';
import { Dialog } from './WorkspaceUI';
import { MailTemplatePicker } from './MailTemplatePicker';
import { MailTemplateLibrary } from './MailTemplateLibrary';
import { MailVariableEditor, type MailVariableEditorHandle } from './MailVariableEditor';
import {
  mailVariableDocumentFromText,
  mailVariableText,
  type MailInlineNode,
  type MailVariablePreview,
} from '../shared/mail-variables';
import { mailTemplates, type MailTemplate } from '../shared/mail-templates';
import { api, HttpError } from './api';
import {
  bindComposerRecipient,
  composerCloseReason,
  composerVariableIssues,
  hasComposerEdits,
  initialComposerRecipientBinding,
  matchesComposerScope,
  outgoingContentOf,
  shanghaiLocalMinute,
  shanghaiScheduleInstant,
  type MailComposerStep,
} from './mail-composer-state';
import type { Person } from '../shared/domain';
import type { MailMessage } from '../shared/connections';
import {
  lockedOutgoing,
  outgoingLabels,
  type ComposeOptions,
  type OutgoingAttachment,
  type OutgoingContent,
  type OutgoingMail,
  type OutgoingSummary,
  type ReplyOptions,
} from '../shared/outgoing';
import './mail-composer.css';

type ContactOption = {
  id: string;
  name: string;
  email: string;
  customer_name: string;
  customer_id?: string;
};
type HandoffMailSeed = {
  taskId: string;
  draftId: string;
  projectId: string | null;
  attachment: OutgoingAttachment;
  cc: string | null;
};

function newMailContent(
  email: string | null,
  accountId: string | null,
  handoff?: HandoffMailSeed,
): OutgoingContent {
  const to = email ? [email.trim().toLowerCase()] : [];
  const cc = handoff?.cc?.trim().toLowerCase();
  return {
    account_id: accountId,
    project_id: handoff?.projectId ?? null,
    to,
    cc: cc && !to.includes(cc) ? [cc] : [],
    bcc: [],
    subject: '',
    body: '',
    attachments: handoff ? [handoff.attachment] : [],
  };
}
const emailValid = (value: string) => /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(value);
const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function RecipientField({
  label,
  values,
  onChange,
  workspace,
  personId,
  kind = 'people',
  disabled,
  onPending,
  drawer = false,
  active = true,
  queryValue,
  onQueryChange,
  onSelectContact,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  workspace: string;
  personId: string;
  kind?: 'people' | 'customers';
  disabled: boolean;
  onPending: (pending: boolean) => void;
  drawer?: boolean;
  active?: boolean;
  queryValue?: string;
  onQueryChange?: (value: string) => void;
  onSelectContact?: (contact: ContactOption) => void;
}) {
  const [localQuery, setLocalQuery] = useState(''),
    [open, setOpen] = useState(false),
    [result, setResult] = useState<{ query: string; items: ContactOption[] } | null>(null),
    [error, setError] = useState('');
  const query = queryValue ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;
  const inputId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const options = result?.query === query ? result.items : [];
  const available = options.filter((o) => !values.includes(o.email.toLowerCase()));
  const addresses = query
    .split(/[;,，；\n]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const canAddAddress =
    addresses.length > 0 &&
    addresses.every(emailValid) &&
    addresses.some((a) => !values.includes(a)) &&
    !options.some((o) => o.email.toLowerCase() === query.trim().toLowerCase());
  const candidates = [
    ...available.map((o) => ({ key: o.id, address: o.email, contact: o })),
    ...(canAddAddress ? [{ key: 'manual', address: query, contact: undefined }] : []),
  ];
  const showSuggestions = open && active && !disabled && !!query.trim();
  const searching = result?.query !== query && !error;
  const [known, setKnown] = useState<Record<string, ContactOption>>({});
  const ref = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) onPending(!!query.trim());
  }, [query, onPending, active]);
  useEffect(() => {
    if (active && drawer) input.current?.focus({ preventScroll: true });
  }, [active, drawer]);
  useEffect(() => {
    if (!open || !active) return;
    const c = new AbortController();
    const timer = setTimeout(
      () =>
        api<ContactOption[]>(
          `/${kind}/${personId}/recipient-options?q=${encodeURIComponent(query.trim().slice(0, 100))}${drawer ? '&mass=true' : ''}`,
          { workspace, signal: c.signal },
        )
          .then((items) => {
            if (c.signal.aborted) return;
            setResult({ query, items });
            setActiveIndex(0);
            setKnown((previous) => ({
              ...previous,
              ...Object.fromEntries(items.map((o) => [o.email.toLowerCase(), o])),
            }));
            setError('');
          })
          .catch((e) => {
            if (e.name !== 'AbortError') setError(e.message);
          }),
      150,
    );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [open, query, personId, workspace, kind, active, drawer]);
  function add(address: string, contact?: ContactOption) {
    const added = address
      .split(/[;,，；\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!added.length || added.some((s) => !emailValid(s))) {
      setError('请输入完整邮箱地址；多个地址可用分号分隔');
      return;
    }
    const next = [...new Set([...values, ...added])];
    if (next.length > 20) {
      setError('每栏最多添加 20 个邮箱');
      return;
    }
    onChange(next);
    if (contact) onSelectContact?.(contact);
    setQuery('');
    setError('');
    setOpen(false);
    input.current?.focus();
  }
  return (
    <div
      ref={ref}
      className={`compose-recipient-field${drawer ? ' recipient-drawer-field' : ''}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <label htmlFor={inputId}>{label}</label>
      <div className="compose-recipient-control">
        {values.map((address) => (
          <span className="recipient-chip" key={address}>
            {drawer ? (
              <span className="recipient-initial">
                {(known[address]?.name || address).slice(0, 1)}
              </span>
            ) : (
              <Mail size={12} />
            )}
            <span>
              {drawer && <strong>{known[address]?.name || address.split('@')[0]}</strong>}
              {address}
            </span>
            {!disabled && (
              <button
                type="button"
                aria-label={`移除${label} ${address}`}
                onClick={() => onChange(values.filter((a) => a !== address))}
              >
                <X size={12} />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <div className="recipient-search">
            <input
              ref={input}
              id={inputId}
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls={showSuggestions ? `${inputId}-suggestions` : undefined}
              aria-activedescendant={
                showSuggestions && candidates[activeIndex]
                  ? `${inputId}-option-${candidates[activeIndex].key}`
                  : undefined
              }
              value={query}
              maxLength={2000}
              placeholder={
                drawer
                  ? '搜索联系人或添加邮箱…'
                  : values.length
                    ? '添加更多收件人…'
                    : '搜索联系人或输入邮箱…'
              }
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setError('');
                setActiveIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && query.trim()) {
                  e.preventDefault();
                  setOpen(true);
                  if (candidates.length)
                    setActiveIndex(
                      (i) =>
                        (i + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) %
                        candidates.length,
                    );
                }
                if (e.key === 'Enter' || e.key === ';') {
                  e.preventDefault();
                  if (e.key === 'Enter' && showSuggestions && candidates[activeIndex])
                    add(candidates[activeIndex].address, candidates[activeIndex].contact);
                  else if (query.trim()) add(query);
                }
                if (e.key === 'Escape' && open) {
                  e.stopPropagation();
                  e.preventDefault();
                  setOpen(false);
                }
              }}
            />
            {showSuggestions && (
              <div className="recipient-options" onMouseDown={(e) => e.preventDefault()}>
                <div role="listbox" id={`${inputId}-suggestions`} aria-label={`${label}候选列表`}>
                  {options.map((o) => {
                    const added = values.includes(o.email.toLowerCase());
                    const index = candidates.findIndex((c) => c.key === o.id);
                    return (
                      <button
                        type="button"
                        role="option"
                        key={o.id}
                        id={`${inputId}-option-${o.id}`}
                        tabIndex={-1}
                        disabled={added}
                        aria-selected={!added && index === activeIndex}
                        aria-label={`${o.email.split('@')[0]} ${o.name} ${o.email}${added ? ' 已添加' : ''}`}
                        onMouseEnter={() => {
                          if (!added) setActiveIndex(index);
                        }}
                        onClick={() => add(o.email, o)}
                      >
                        <span className="recipient-initial">{o.name.slice(0, 1)}</span>
                        <span>
                          <span className="recipient-option-title">
                            <strong>{o.email.split('@')[0]}</strong>
                            <span>{o.name}</span>
                          </span>
                          <small>{o.email}</small>
                        </span>
                        {added ? (
                          <span className="recipient-option-added">已添加</span>
                        ) : (
                          <Plus size={13} />
                        )}
                      </button>
                    );
                  })}
                  {canAddAddress && (
                    <button
                      className="recipient-add"
                      type="button"
                      role="option"
                      id={`${inputId}-option-manual`}
                      tabIndex={-1}
                      aria-selected={candidates[activeIndex]?.key === 'manual'}
                      onMouseEnter={() => setActiveIndex(candidates.length - 1)}
                      onClick={() => add(query)}
                    >
                      <Plus size={14} />
                      添加邮箱：{query}
                    </button>
                  )}
                </div>
                {searching && <p role="status">正在查找…</p>}
                {!searching && !options.length && !error && !canAddAddress && (
                  <p role="status">未找到匹配联系人，可输入完整邮箱添加。</p>
                )}
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
export function OutgoingPanel({
  workspace,
  personId,
  kind = 'people',
  refresh,
  onOpen,
  replyToMessageId,
}: {
  workspace: string;
  personId: string;
  kind?: 'people' | 'customers';
  refresh: number;
  onOpen: (id: string) => void;
  replyToMessageId?: string;
}) {
  const [rows, setRows] = useState<OutgoingSummary[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    const load = () =>
      api<OutgoingSummary[]>(
        replyToMessageId
          ? `/mail/messages/${replyToMessageId}/replies`
          : `/${kind}/${personId}/outgoing`,
        { workspace, signal: c.signal },
      )
        .then((items) => {
          setRows(items);
          setError('');
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [workspace, personId, refresh, kind, replyToMessageId]);
  if (!rows.length && !error) return null;
  return (
    <section className="outgoing-panel" aria-label="我的草稿与发件">
      <h3>
        {replyToMessageId ? '我的回复' : '我的草稿与发件'} <span>{rows.length}</span>
      </h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows.map((r) => (
        <button key={r.id} onClick={() => onOpen(r.id)}>
          <Mail size={14} />
          <strong>{r.subject || '（无主题）'}</strong>
          <span className={`outgoing-state ${r.status}`}>{outgoingLabels[r.status]}</span>
          {r.scheduled_at && <time>{time(r.scheduled_at)}</time>}
        </button>
      ))}
    </section>
  );
}
export function MailComposer({
  workspace,
  person,
  kind = 'people',
  draftId,
  onClose,
  onChanged,
  reply,
  handoff,
}: {
  workspace: string;
  person: Pick<Person, 'id' | 'name' | 'email' | 'customer_id' | 'customer_name'>;
  kind?: 'people' | 'customers';
  draftId?: string;
  onClose: () => void;
  onChanged: () => void;
  reply?: { plan: ReplyOptions; source: MailMessage };
  handoff?: HandoffMailSeed;
}) {
  const composerIdentity = JSON.stringify([
    workspace,
    kind,
    person.id,
    person.customer_id,
    draftId || null,
    reply?.plan.source_id || null,
    handoff?.taskId || null,
  ]);
  const identity = useRef(composerIdentity);
  identity.current = composerIdentity;
  const initializedIdentity = useRef(composerIdentity);
  const mounted = useRef(true);
  const actionBusy = useRef(false);
  const [id, setId] = useState(() => draftId || handoff?.draftId || crypto.randomUUID());
  const [saved, setSaved] = useState<OutgoingMail | null>(null);
  const [content, setContent] = useState<OutgoingContent>(
    reply?.plan.content || newMailContent(person.email, null, handoff),
  );
  const [baseline, setBaseline] = useState<OutgoingContent>(() =>
    outgoingContentOf(handoff ? newMailContent(person.email, null) : content),
  );
  const dirty = hasComposerEdits(content, baseline);
  const [options, setOptions] = useState<ComposeOptions | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState('');
  const [step, setStep] = useState<MailComposerStep>('write');
  const [showCopies, setShowCopies] = useState(false),
    [pendingTo, setPendingTo] = useState(false),
    [pendingCc, setPendingCc] = useState(false),
    [pendingBcc, setPendingBcc] = useState(false);
  const [closing, setClosing] = useState<ReturnType<typeof composerCloseReason>>(null),
    [mode, setMode] = useState<'now' | 'later'>('now'),
    [sendAt, setSendAt] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const variableMessageRef = useRef<MailVariableEditorHandle>(null);
  const [variablePreview, setVariablePreview] = useState<{
    version: number;
    value: MailVariablePreview;
  } | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState<MailTemplate | null>(null);
  const [templateView, setTemplateView] = useState<'browse' | 'create' | null>(null);
  const [savedTemplates, setSavedTemplates] = useState<MailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState('');
  const [templateRevision, setTemplateRevision] = useState(0);
  const templateEndpoint = `/${kind}/${person.id}/mail-templates`;
  const templates = [...mailTemplates, ...savedTemplates];
  const [recipientPanelOpen, setRecipientPanelOpen] = useState(false);
  const [toQuery, setToQuery] = useState('');
  const massSwitch = useRef<HTMLButtonElement>(null);
  const recipientPanelId = useId();
  const massCompose = step === 'write' && !!content.mass_sending;
  const drawerShown = massCompose && recipientPanelOpen;
  function hideRecipients() {
    setRecipientPanelOpen(false);
    massSwitch.current?.focus();
  }
  const pending = pendingTo || pendingCc || pendingBcc;
  const locked = !!saved && lockedOutgoing(saved.status);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSavedTemplates([]);
    setTemplatesLoading(true);
    setTemplatesError('');
    api<MailTemplate[]>(templateEndpoint, { workspace, signal: controller.signal })
      .then((values) => {
        if (!controller.signal.aborted) setSavedTemplates(values);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setTemplatesError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setTemplatesLoading(false);
      });
    return () => controller.abort();
  }, [workspace, templateEndpoint, templateRevision]);
  useEffect(() => {
    const c = new AbortController();
    const loadingIdentity = composerIdentity;
    if (initializedIdentity.current !== loadingIdentity) {
      initializedIdentity.current = loadingIdentity;
      setId(draftId || handoff?.draftId || crypto.randomUUID());
      setSaved(null);
      const empty: OutgoingContent = {
        account_id: null,
        project_id: null,
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        body: '',
        attachments: [],
      };
      setContent(empty);
      setBaseline(outgoingContentOf(empty));
      setMode('now');
      setSendAt('');
      setClosing(null);
      setToQuery('');
      setPendingTo(false);
      setPendingCc(false);
      setPendingBcc(false);
      setSelectedTemplate(null);
      setTemplateView(null);
      setConnectionNotice('');
      setVariablePreview(null);
      setPreviewIndex(0);
    }
    setLoading(true);
    setOptions(null);
    setError('');
    Promise.all([
      reply
        ? Promise.resolve(reply.plan.options)
        : api<ComposeOptions>(`/${kind}/${person.id}/compose-options`, {
            workspace,
            signal: c.signal,
          }),
      draftId
        ? api<OutgoingMail>(`/outgoing/${draftId}`, { workspace, signal: c.signal })
        : Promise.resolve(null),
    ])
      .then(([o, r]) => {
        if (c.signal.aborted || identity.current !== loadingIdentity) return;
        if (
          r &&
          !matchesComposerScope(r, {
            id: draftId!,
            workspace,
            customer: person.customer_id,
            target: person.id,
            kind,
          })
        )
          throw new Error('草稿与当前客户或收件对象不一致，请关闭后重新打开');
        setOptions(o);
        if (r) {
          setSaved(r);
          const initial = outgoingContentOf(r);
          setContent(initial);
          setBaseline(outgoingContentOf(initial));
          setShowCopies(!!(r.cc.length || r.bcc.length));
          setRecipientPanelOpen(!!r.mass_sending);
          setStep(r.status === 'approved' ? 'schedule' : r.status === 'draft' ? 'write' : 'status');
        } else {
          const defaultAccount = o.accounts.length === 1 ? o.accounts[0].id : null;
          const initial = initialComposerRecipientBinding(
            outgoingContentOf(
              reply?.plan.content || newMailContent(person.email, defaultAccount, handoff),
            ),
            person,
            kind === 'people' && !!o.mail_variables,
          );
          setContent(initial);
          setBaseline(
            handoff ? newMailContent(person.email, defaultAccount) : outgoingContentOf(initial),
          );
          setShowCopies(!!(initial.cc.length || initial.bcc.length));
          setStep('write');
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!c.signal.aborted && identity.current === loadingIdentity && e.name !== 'AbortError') {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => c.abort();
  }, [composerIdentity]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty || pending || step === 'schedule') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, pending, step]);
  useEffect(() => {
    if (step !== 'status' || !saved || !['scheduled', 'sending'].includes(saved.status)) return;
    const c = new AbortController();
    const pollingIdentity = composerIdentity;
    const timer = setInterval(
      () =>
        api<OutgoingMail>(`/outgoing/${id}`, { workspace, signal: c.signal })
          .then((r) => {
            if (c.signal.aborted || identity.current !== pollingIdentity) return;
            if (
              !matchesComposerScope(r, {
                id,
                workspace,
                customer: person.customer_id,
                target: person.id,
                kind,
              })
            )
              return;
            setSaved(r);
            if (r.status !== saved.status) onChanged();
          })
          .catch((e) => {
            if (
              !c.signal.aborted &&
              identity.current === pollingIdentity &&
              e.name !== 'AbortError'
            )
              setError(e.message);
          }),
      3000,
    );
    return () => {
      clearInterval(timer);
      c.abort();
    };
  }, [step, saved?.status, id, workspace, onChanged, composerIdentity]);
  function update<K extends keyof OutgoingContent>(key: K, value: OutgoingContent[K]) {
    setContent((v) => ({
      ...v,
      [key]: value,
      ...(key === 'to' && v.recipient_bindings
        ? {
            recipient_bindings: v.recipient_bindings.filter((binding) =>
              (value as string[]).includes(binding.email),
            ),
          }
        : {}),
    }));
    setVariablePreview(null);
    setError('');
  }
  function editVariableDocument(part: 'subject' | 'body', nodes: MailInlineNode[]) {
    setContent((value) => {
      const previous =
        value.variable_document || mailVariableDocumentFromText(value.subject, value.body);
      const document = { ...previous, [part]: nodes };
      return { ...value, [part]: mailVariableText(nodes), variable_document: document };
    });
    setVariablePreview(null);
    setError('');
  }
  function selectRecipient(contact: ContactOption) {
    setContent((value) =>
      bindComposerRecipient(value, contact, person.customer_id, !!options?.mail_variables),
    );
    setVariablePreview(null);
  }
  function applyTemplate(template: MailTemplate) {
    setContent((value) => {
      const useSubject = !!template.subject.trim();
      const document =
        options?.mail_variables && (template.variable_document || value.variable_document)
          ? {
              version: 1 as const,
              subject: useSubject
                ? template.variable_document?.subject ||
                  mailVariableDocumentFromText(template.subject, '').subject
                : value.variable_document?.subject ||
                  mailVariableDocumentFromText(value.subject, '').subject,
              body:
                template.variable_document?.body ||
                mailVariableDocumentFromText('', template.body).body,
            }
          : undefined;
      return {
        ...value,
        subject: useSubject ? template.subject : value.subject,
        body: template.body,
        ...(options?.mail_variables ? { variable_document: document } : {}),
      };
    });
    setVariablePreview(null);
    setError('');
    setSelectedTemplate(null);
    requestAnimationFrame(() =>
      options?.mail_variables ? variableMessageRef.current?.focus() : messageRef.current?.focus(),
    );
  }
  function selectTemplate(template: MailTemplate) {
    setTemplateView(null);
    if (content.subject.trim() || content.body.trim()) setSelectedTemplate(template);
    else applyTemplate(template);
  }
  function close() {
    if (busy || actionBusy.current) return;
    const reason = composerCloseReason(dirty, pending, step);
    if (reason) {
      setError('');
      setClosing(reason);
    } else onClose();
  }
  async function save(nextContent = content) {
    if (pending) throw new Error('请先点击“添加邮箱”或按回车加入已输入的收件人');
    const requestIdentity = identity.current;
    const expected = { id, workspace, customer: person.customer_id, target: person.id, kind };
    const payloadContent = outgoingContentOf(nextContent);
    if (!options?.mail_variables) {
      delete payloadContent.variable_document;
      delete payloadContent.recipient_bindings;
    }
    let r: OutgoingMail;
    try {
      r = await api<OutgoingMail>(`/${kind}/${person.id}/outgoing`, {
        workspace,
        method: 'POST',
        body: {
          id,
          version: saved?.version || 0,
          content: payloadContent,
          reply_to_message_id: saved?.reply_to_message_id || reply?.plan.source_id || null,
          ...(handoff || saved?.handoff_task_id
            ? { handoff_task_id: handoff?.taskId || saved?.handoff_task_id }
            : {}),
        },
      });
    } catch (failure) {
      if (
        failure instanceof HttpError &&
        failure.status === 409 &&
        mounted.current &&
        identity.current === requestIdentity
      ) {
        const latest = await api<OutgoingMail>(`/outgoing/${id}`, { workspace }).catch(() => null);
        if (
          latest &&
          mounted.current &&
          identity.current === requestIdentity &&
          matchesComposerScope(latest, expected)
        ) {
          setSaved(latest);
          setBaseline(outgoingContentOf(latest));
        }
      }
      throw failure;
    }
    if (!mounted.current || identity.current !== requestIdentity)
      throw new DOMException('写信窗口已切换', 'AbortError');
    if (!matchesComposerScope(r, expected))
      throw new Error('草稿保存结果与当前客户或收件对象不一致，本次编辑仍保留');
    setSaved(r);
    const persisted = outgoingContentOf(r);
    setContent(persisted);
    setBaseline(outgoingContentOf(persisted));
    onChanged();
    return r;
  }
  async function run(fn: () => Promise<void>) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current && (!(e instanceof DOMException) || e.name !== 'AbortError'))
        setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      actionBusy.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadVariablePreview(mail: OutgoingMail) {
    setVariablePreview(null);
    setPreviewIndex(0);
    if (!options?.mail_variables) return;
    const requestIdentity = identity.current;
    const value = await api<MailVariablePreview>(`/outgoing/${id}/variable-preview`, {
      workspace,
      method: 'POST',
      body: { version: mail.version },
    });
    if (!mounted.current || identity.current !== requestIdentity)
      throw new DOMException('写信窗口已切换', 'AbortError');
    setVariablePreview({ version: mail.version, value });
  }
  async function action(name: 'approve' | 'cancel' | 'reconcile') {
    const requestIdentity = identity.current;
    const r = await api<OutgoingMail>(`/outgoing/${id}/${name}`, {
      workspace,
      method: 'POST',
      body: {
        version: saved!.version,
        ...(name === 'approve' &&
        options?.mail_variables &&
        variablePreview?.version === saved!.version
          ? { variable_preview_digest: variablePreview.value.digest }
          : {}),
      },
    });
    if (!mounted.current || identity.current !== requestIdentity)
      throw new DOMException('写信窗口已切换', 'AbortError');
    if (
      !matchesComposerScope(r, {
        id,
        workspace,
        customer: person.customer_id,
        target: person.id,
        kind,
      })
    )
      throw new Error('发件状态与当前客户或收件对象不一致，请重新打开核对');
    setSaved(r);
    onChanged();
    return r;
  }
  async function files(list: FileList | null) {
    if (!list?.length) return;
    await run(async () => {
      const selected = Array.from(list);
      const previousSize = content.attachments.reduce(
        (n, a) => n + Math.floor((a.content.length * 3) / 4),
        0,
      );
      if (
        selected.length + content.attachments.length > 10 ||
        selected.reduce((n, f) => n + f.size, previousSize) > 5 * 1024 * 1024
      )
        throw new Error('最多 10 个附件，总大小不超过 5 MB');
      const added = await Promise.all(
        selected.map(
          (file) =>
            new Promise<{ name: string; content: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({ name: file.name, content: String(reader.result).split(',')[1] });
              reader.onerror = () => reject(new Error('附件读取失败'));
              reader.readAsDataURL(file);
            }),
        ),
      );
      update('attachments', [...content.attachments, ...added]);
    });
    if (fileRef.current) fileRef.current.value = '';
  }
  const selectedAccount = options?.accounts.find((a) => a.id === content.account_id);
  const selectedProject = options?.projects.find((p) => p.id === content.project_id);
  const variableDocument =
    content.variable_document || mailVariableDocumentFromText(content.subject, content.body);
  const currentPreview =
    variablePreview?.version === saved?.version ? variablePreview?.value : null;
  const previewMessages =
    step === 'review' ? currentPreview?.messages : saved?.variable_snapshot?.messages;
  const renderedMessage =
    previewMessages?.[Math.min(previewIndex, Math.max(0, previewMessages.length - 1))];
  const canApprove =
    !options?.mail_variables || !!(currentPreview?.can_confirm && currentPreview.digest);
  const canReview =
    !!content.account_id &&
    !!content.to.length &&
    !!content.subject.trim() &&
    !!content.body.trim() &&
    content.subject.length <= 500 &&
    content.body.length <= 100000 &&
    !pending &&
    (!content.mass_sending || (!content.cc.length && !content.bcc.length));
  let scheduledInstant: string | undefined;
  let scheduleError = '';
  if (mode === 'later' && sendAt) {
    try {
      scheduledInstant = shanghaiScheduleInstant(sendAt);
    } catch (failure) {
      scheduleError = failure instanceof Error ? failure.message : '发送时间无效';
    }
  }
  const summary = (
    <div className="compose-review">
      <dl>
        <div>
          <dt>邮件版本</dt>
          <dd>第 {saved?.version} 版</dd>
        </div>
        {(step === 'review' || step === 'schedule') && (
          <div>
            <dt>发送时间</dt>
            <dd>
              {step === 'review'
                ? mode === 'later'
                  ? '定时发送 · 确认内容后选择具体时间'
                  : '确认内容后选择发送时间'
                : mode === 'later'
                  ? scheduledInstant
                    ? `${time(scheduledInstant)}（北京时间 / Asia/Shanghai）`
                    : '请选择具体时间（北京时间 / Asia/Shanghai）'
                  : '立即发送 · 最终确认后执行'}
            </dd>
          </div>
        )}
        {content.mass_sending && (
          <div>
            <dt>发送方式</dt>
            <dd>逐人独立发送 · {content.to.length} 封 · 收件人互不可见</dd>
          </div>
        )}
        {(reply || saved?.reply_to_message_id) && (
          <div>
            <dt>回复</dt>
            <dd>{reply?.source.subject || '原邮件'}</dd>
          </div>
        )}
        <div>
          <dt>客户</dt>
          <dd>{person.customer_name}</dd>
        </div>
        <div>
          <dt>项目</dt>
          <dd>
            {selectedProject?.name ||
              (content.project_id ? '项目已不可用' : '客户层级 · 不指定项目')}
          </dd>
        </div>
        <div>
          <dt>发件人</dt>
          <dd>{saved?.from_email || selectedAccount?.email || '未选择'}</dd>
        </div>
        <div>
          <dt>收件人</dt>
          <dd>{content.to.join('；')}</dd>
        </div>
        {content.cc.length > 0 && (
          <div>
            <dt>抄送</dt>
            <dd>{content.cc.join('；')}</dd>
          </div>
        )}
        {content.bcc.length > 0 && (
          <div>
            <dt>密送</dt>
            <dd>{content.bcc.join('；')}</dd>
          </div>
        )}
        <div>
          <dt>附件</dt>
          <dd>{content.attachments.map((a) => a.name).join('、') || '无附件'}</dd>
        </div>
      </dl>
      {!!previewMessages?.length && (previewMessages.length > 1 || step !== 'review') && (
        <div className="compose-variable-preview-picker">
          {previewMessages.length > 1 && (
            <label>
              收件人预览
              <select
                aria-label="收件人预览"
                value={Math.min(previewIndex, previewMessages.length - 1)}
                onChange={(event) => setPreviewIndex(Number(event.target.value))}
              >
                {previewMessages.map((message, index) => (
                  <option key={`${message.recipient}:${index}`} value={index}>
                    {message.recipient || '当前邮件'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {step !== 'review' && <small>已确认版本的冻结内容</small>}
        </div>
      )}
      <h3>{(renderedMessage?.subject ?? content.subject) || '（无主题）'}</h3>
      <pre>{renderedMessage?.body ?? content.body}</pre>
      {step === 'review' && currentPreview && (
        <>
          {composerVariableIssues(currentPreview).map((issue, index) => (
            <p className="error" role="alert" key={`${issue.code}:${index}`}>
              {issue.recipient && `${issue.recipient}：`}
              {issue.message}
            </p>
          ))}
          {currentPreview.recipient_choices.map((choice) => (
            <label className="compose-variable-binding" key={choice.email}>
              为 {choice.email} 选择联系人
              <select
                aria-label={`为 ${choice.email} 选择联系人`}
                disabled={busy}
                value={
                  content.recipient_bindings?.find((binding) => binding.email === choice.email)
                    ?.person_id || ''
                }
                onChange={(event) => {
                  if (!event.target.value) return;
                  const next = {
                    ...content,
                    recipient_bindings: [
                      ...(content.recipient_bindings || []).filter(
                        (binding) => binding.email !== choice.email,
                      ),
                      { email: choice.email, person_id: event.target.value },
                    ],
                  };
                  setContent(next);
                  setVariablePreview(null);
                  void run(async () => {
                    const mail = await save(next);
                    await loadVariablePreview(mail);
                  });
                }}
              >
                <option value="">请选择实际收件人</option>
                {choice.candidates.map((candidate) => (
                  <option key={candidate.person_id} value={candidate.person_id}>
                    {candidate.name} · {candidate.customer_name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </>
      )}
      {!!renderedMessage?.values.length && (
        <details className="compose-variable-values">
          <summary>变量取值与来源</summary>
          {renderedMessage.values.map((value, index) => (
            <div key={`${value.node_id}:${index}`}>
              <strong>{value.path.join(' › ')}</strong>
              <span>
                {value.value !== null
                  ? value.value === ''
                    ? '（空文本）'
                    : value.value
                  : '未解析'}
              </span>
              <small>
                {
                  {
                    recipient: '当前收件人资料',
                    recipient_company: '收件人绑定公司资料',
                    customer: '当前邮件归属公司资料',
                    project: '当前关联项目资料',
                    sender: '所选发件账号',
                  }[value.root]
                }
                {value.state === 'fallback' ? ' · 备用文案' : ''}
                {value.origin === 'ai' ? ' · AI整理' : ''}
              </small>
            </div>
          ))}
        </details>
      )}
    </div>
  );
  return (
    <Dialog
      title={
        step === 'review'
          ? '确认邮件内容'
          : step === 'schedule'
            ? '选择发送时间'
            : step === 'status'
              ? '发件详情'
              : reply || saved?.reply_to_message_id
                ? '回复邮件'
                : '写邮件'
      }
      onClose={close}
      className={`mail-compose-dialog${massCompose ? ' mail-compose-expanded' : ''}`}
    >
      {loading ? (
        <div className="compose-loading">正在加载邮件…</div>
      ) : !options ? (
        <div className="dialog-fields">
          <p className="error" role="alert">
            {error}
          </p>
          <button onClick={onClose}>关闭</button>
        </div>
      ) : (
        <>
          <div className={`compose-layout${drawerShown ? ' recipients-open' : ''}`}>
            <div className="compose-body">
              {reply && (
                <details className="compose-original">
                  <summary>查看原邮件 · {reply.source.subject}</summary>
                  <p>
                    {reply.source.sender.map((a) => a.address).join('；')} ·{' '}
                    {time(reply.source.occurred_at)}
                  </p>
                  <pre>{reply.source.body || '无文本正文'}</pre>
                </details>
              )}
              {(reply || saved?.reply_to_message_id) &&
                !(saved ? saved.in_reply_to : reply?.plan.in_reply_to) && (
                  <p className="compose-notice">
                    这封历史邮件未保存原会话标识，将按当前主题发送回复。
                  </p>
                )}
              {step === 'write' ? (
                <>
                  <div className="compose-row">
                    <label htmlFor="compose-from">发件人</label>
                    <select
                      id="compose-from"
                      disabled={busy || locked}
                      value={content.account_id || ''}
                      onChange={(e) => update('account_id', e.target.value || null)}
                    >
                      <option value="">选择已连接邮箱</option>
                      {options.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.email}
                        </option>
                      ))}
                    </select>
                    {options.can_test_sender !== false && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy || !content.account_id}
                        onClick={() =>
                          void run(async () => {
                            const result = await api<{ message: string }>(
                              `/mail/accounts/${content.account_id}/test-smtp`,
                              { workspace, method: 'POST', body: {} },
                            );
                            setConnectionNotice(result.message);
                          })
                        }
                      >
                        检查连接
                      </button>
                    )}
                  </div>
                  {connectionNotice && (
                    <p className="compose-notice" role="status">
                      {connectionNotice}
                    </p>
                  )}
                  {(!options.accounts.length || options.sender_notice) && (
                    <p className="compose-notice">
                      {options.sender_notice ||
                        '还没有可用邮箱。请先在“邮件管理 → 邮箱设置”连接网易邮箱。'}
                    </p>
                  )}
                  <div className="compose-to-row">
                    {content.mass_sending ? (
                      <div className="compose-row compose-mass-to">
                        <span>收件人</span>
                        <button
                          type="button"
                          disabled={busy || locked}
                          aria-expanded={drawerShown}
                          aria-controls={recipientPanelId}
                          onClick={() => setRecipientPanelOpen(!recipientPanelOpen)}
                        >
                          <Mail size={13} />
                          发送给 {content.to.length} 位收件人
                          <ChevronLeft size={13} />
                        </button>
                      </div>
                    ) : (
                      <RecipientField
                        label="收件人"
                        values={content.to}
                        onChange={(v) => update('to', v)}
                        workspace={workspace}
                        personId={person.id}
                        kind={kind}
                        disabled={busy || locked}
                        onPending={setPendingTo}
                        queryValue={toQuery}
                        onQueryChange={setToQuery}
                        onSelectContact={options.mail_variables ? selectRecipient : undefined}
                      />
                    )}
                    {!content.mass_sending && (
                      <button
                        type="button"
                        className="compose-copy-toggle"
                        onClick={() => setShowCopies(!showCopies)}
                        disabled={busy || pendingCc || pendingBcc}
                      >
                        抄送 / 密送
                      </button>
                    )}
                  </div>
                  {content.mass_sending && (
                    <p className="compose-mass-note">
                      每人收到一封独立邮件，彼此不可见。归入 {person.customer_name} 及所选项目。
                    </p>
                  )}
                  {showCopies &&
                    (!content.mass_sending || !!(content.cc.length || content.bcc.length)) && (
                      <>
                        <RecipientField
                          label="抄送"
                          values={content.cc}
                          onChange={(v) => update('cc', v)}
                          workspace={workspace}
                          personId={person.id}
                          kind={kind}
                          disabled={busy || locked}
                          onPending={setPendingCc}
                        />
                        <RecipientField
                          label="密送"
                          values={content.bcc}
                          onChange={(v) => update('bcc', v)}
                          workspace={workspace}
                          personId={person.id}
                          kind={kind}
                          disabled={busy || locked}
                          onPending={setPendingBcc}
                        />
                      </>
                    )}
                  {content.mass_sending && !!(content.cc.length || content.bcc.length) && (
                    <p className="compose-notice">
                      群发不使用抄送或密送，请先移除上方地址，再核对邮件。
                    </p>
                  )}
                  <div className="compose-row">
                    <label htmlFor="compose-project">关联项目</label>
                    <select
                      id="compose-project"
                      disabled={busy || locked || !!handoff || !!saved?.handoff_task_id}
                      value={content.project_id || ''}
                      onChange={(e) => update('project_id', e.target.value || null)}
                    >
                      <option value="">客户层级 · 不指定项目</option>
                      {options.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="compose-row compose-subject">
                    <label htmlFor="compose-subject">主题</label>
                    {options.mail_variables ? (
                      <MailVariableEditor
                        value={variableDocument.subject}
                        onChange={(nodes) => editVariableDocument('subject', nodes)}
                        catalog={options.mail_variables}
                        label="邮件主题"
                        disabled={busy || locked}
                        placeholder="输入邮件主题，或输入 { 插入变量…"
                        identityKey={composerIdentity}
                        maxLength={500}
                      />
                    ) : (
                      <input
                        id="compose-subject"
                        placeholder="输入邮件主题…"
                        maxLength={500}
                        value={content.subject}
                        disabled={busy || locked}
                        onChange={(e) => update('subject', e.target.value)}
                      />
                    )}
                  </div>
                  <div className="compose-editor">
                    {options.mail_variables ? (
                      <MailVariableEditor
                        ref={variableMessageRef}
                        value={variableDocument.body}
                        onChange={(nodes) => editVariableDocument('body', nodes)}
                        catalog={options.mail_variables}
                        label="邮件正文"
                        multiline
                        disabled={busy || locked}
                        placeholder={content.body ? '输入正文，或输入 { 插入变量…' : ''}
                        identityKey={composerIdentity}
                        maxLength={100000}
                      />
                    ) : (
                      <textarea
                        ref={messageRef}
                        className="compose-message"
                        aria-label="邮件正文"
                        value={content.body}
                        maxLength={100000}
                        disabled={busy || locked}
                        onChange={(e) => update('body', e.target.value)}
                      />
                    )}
                    {!content.body && (
                      <div className="compose-message-hint">
                        <span>开始输入，或 </span>
                        <MailTemplatePicker
                          templates={templates}
                          onSelect={selectTemplate}
                          disabled={busy || locked}
                        />
                      </div>
                    )}
                    {!content.body && (
                      <div className="compose-template-shortcuts">
                        <button
                          type="button"
                          disabled={busy || locked}
                          onClick={() => setTemplateView('browse')}
                        >
                          <FileText size={16} />
                          查看全部模板
                        </button>
                        <button
                          type="button"
                          disabled={busy || locked}
                          onClick={() => setTemplateView('create')}
                        >
                          <FilePlus2 size={16} />
                          新建模板
                        </button>
                        {templatesError && (
                          <small role="alert">已保存模板加载失败，请在“查看全部模板”中重试。</small>
                        )}
                      </div>
                    )}
                  </div>
                  {!!content.body && (
                    <div className="compose-template-action">
                      <MailTemplatePicker
                        label="选择模板"
                        templates={templates}
                        onSelect={selectTemplate}
                        disabled={busy || locked}
                      />
                      <button
                        type="button"
                        disabled={busy || locked}
                        onClick={() => setTemplateView('browse')}
                      >
                        <FileText size={14} />
                        查看全部模板
                      </button>
                      <button
                        type="button"
                        disabled={busy || locked}
                        onClick={() => setTemplateView('create')}
                      >
                        <FilePlus2 size={14} />
                        新建模板
                      </button>
                      {templatesError && <small role="alert">已保存模板加载失败，请重试。</small>}
                    </div>
                  )}
                  {!!content.attachments.length && (
                    <div className="compose-attachments">
                      {content.attachments.map((a, i) => (
                        <span key={`${a.name}:${i}`}>
                          <Paperclip size={13} />
                          {a.name}
                          <button
                            className="icon-button"
                            aria-label={`移除附件 ${a.name}`}
                            disabled={busy || locked}
                            onClick={() =>
                              update(
                                'attachments',
                                content.attachments.filter((_, j) => j !== i),
                              )
                            }
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {saved?.status === 'scheduled' && (
                    <p className="compose-notice">保存修改会取消原排期，需要重新确认内容和时间。</p>
                  )}
                  {saved?.status === 'cancelled' && (
                    <p className="compose-notice">
                      此邮件的发送已取消。关闭或放弃编辑不会恢复发送，需重新确认内容和时间。
                    </p>
                  )}
                </>
              ) : (
                <>
                  {step === 'status' && saved && (
                    <div className={`compose-status ${saved.status}`} role="status">
                      <strong>{outgoingLabels[saved.status]}</strong>
                      {saved.scheduled_at && (
                        <span>发送时间：{time(saved.scheduled_at)}（北京时间）</span>
                      )}
                      {saved.status === 'submitted' && (
                        <span>
                          发件服务器已接受邮件，可继续核对发件箱；不代表对方已收到或阅读。
                        </span>
                      )}
                      {saved.status === 'sent_confirmed' && (
                        <span>已在发件箱找到相符记录；不代表对方已收到或阅读。</span>
                      )}
                      {saved.error && <span>{saved.error}</span>}
                    </div>
                  )}
                  {summary}
                  {step === 'status' && !!saved?.deliveries?.length && (
                    <div className="compose-deliveries">
                      <h3>逐人发送结果</h3>
                      {saved.deliveries.map((d) => (
                        <div key={d.id}>
                          <span>{d.recipient}</span>
                          <strong>
                            {
                              {
                                pending: '等待发送',
                                sending: '正在发送',
                                submitted: '邮箱已接受',
                                sent_confirmed: '已核对发件记录',
                                uncertain: '结果待核对',
                                failed: '发送失败',
                                stopped: '尚未发送',
                              }[d.status]
                            }
                          </strong>
                          {d.error && <small>{d.error}</small>}
                        </div>
                      ))}
                    </div>
                  )}
                  {step === 'review' && (
                    <p className="compose-notice">
                      确认第 {saved?.version}{' '}
                      版：客户、项目、发件账号、全部收件人、正文与附件。下一步由你选择
                      {mode === 'later' ? '具体定时时间' : '发送时间'}并最终确认。
                    </p>
                  )}
                  {step === 'schedule' && (
                    <div className="compose-schedule">
                      <p>
                        <Check size={14} />第 {saved?.version} 版内容已确认
                      </p>
                      <label>
                        <input
                          type="radio"
                          name="send-mode"
                          disabled={busy}
                          checked={mode === 'now'}
                          onChange={() => setMode('now')}
                        />
                        立即发送
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="send-mode"
                          disabled={busy}
                          checked={mode === 'later'}
                          onChange={() => setMode('later')}
                        />
                        定时发送
                      </label>
                      {mode === 'later' && (
                        <label className="compose-date">
                          发送时间（北京时间 / Asia/Shanghai）
                          <input
                            type="datetime-local"
                            aria-label="发送时间"
                            value={sendAt}
                            disabled={busy}
                            min={shanghaiLocalMinute(Date.now() + 60000)}
                            max={shanghaiLocalMinute(Date.now() + 366 * 86400000)}
                            onInput={(e) => setSendAt(e.currentTarget.value)}
                            onChange={(e) => setSendAt(e.target.value)}
                          />
                        </label>
                      )}
                      {scheduleError && (
                        <p className="error" role="alert">
                          {scheduleError}
                        </p>
                      )}
                      <small>
                        {content.mass_sending && '群发将在所选时间开始逐封发送，开始后无法撤回。'}
                        后台服务运行时执行；关闭网页不影响排期。若服务停机导致逾期超过 15
                        分钟，将等待你重新确认。
                      </small>
                    </div>
                  )}
                </>
              )}
              {error && !closing && (
                <p className="error compose-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <button
              type="button"
              className="compose-drawer-scrim"
              tabIndex={-1}
              aria-label="收起收件人栏"
              hidden={!drawerShown}
              onClick={hideRecipients}
            />
            <aside
              className="compose-recipient-drawer"
              id={recipientPanelId}
              aria-label="群发收件人"
              aria-hidden={!drawerShown}
              inert={!drawerShown}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  e.preventDefault();
                  hideRecipients();
                }
              }}
            >
              <div className="recipient-drawer-heading">
                <strong>
                  收件人 <span>{content.to.length}</span>
                </strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="收起收件人"
                  onClick={hideRecipients}
                >
                  <X size={15} />
                </button>
              </div>
              <RecipientField
                label="群发收件人"
                values={content.to}
                onChange={(v) => update('to', v)}
                workspace={workspace}
                personId={person.id}
                kind={kind}
                disabled={busy || locked}
                onPending={setPendingTo}
                drawer
                active={drawerShown}
                queryValue={toQuery}
                onQueryChange={setToQuery}
                onSelectContact={options.mail_variables ? selectRecipient : undefined}
              />
              <p className="recipient-drawer-note">
                每人单独一封 · 最多 20 位<br />
                可搜索当前公司联系人，也可直接输入邮箱地址。
              </p>
            </aside>
          </div>
          <footer className="compose-footer">
            {step === 'write' ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => void files(e.target.files)}
                />
                <button
                  className="icon-button"
                  title="添加附件（总计最多 5 MB）"
                  aria-label="添加附件"
                  disabled={busy || locked}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip size={17} />
                </button>
                <span className="compose-save-state">
                  {dirty || pending ? '未保存' : saved ? '已保存草稿' : ''}
                </span>
                {!(reply || saved?.reply_to_message_id) && (
                  <button
                    type="button"
                    ref={massSwitch}
                    className="compose-mass-switch"
                    role="switch"
                    aria-label="群发"
                    aria-checked={!!content.mass_sending}
                    aria-controls={recipientPanelId}
                    disabled={busy || locked}
                    onClick={() => {
                      const enabled = !content.mass_sending;
                      update('mass_sending', enabled);
                      setRecipientPanelOpen(enabled);
                    }}
                  >
                    <span className="compose-switch-track">
                      <span />
                    </span>
                    群发
                  </button>
                )}
                <button
                  disabled={busy || pending || locked}
                  onClick={() =>
                    void run(async () => {
                      await save();
                    })
                  }
                >
                  <Save size={14} />
                  保存草稿
                </button>
                <button
                  type="button"
                  className="compose-schedule-shortcut"
                  disabled={busy || !canReview || locked}
                  onClick={() =>
                    void run(async () => {
                      const mail = await save();
                      setMode('later');
                      setStep('review');
                      await loadVariablePreview(mail);
                    })
                  }
                >
                  <Clock3 size={14} />
                  定时发送
                </button>
                <button
                  className="primary"
                  disabled={busy || !canReview || locked}
                  onClick={() =>
                    void run(async () => {
                      const mail = await save();
                      setStep('review');
                      await loadVariablePreview(mail);
                    })
                  }
                >
                  {content.mass_sending ? `核对邮件 (${content.to.length})` : '核对邮件'}{' '}
                  <Send size={14} />
                </button>
              </>
            ) : step === 'review' ? (
              <>
                <button disabled={busy} onClick={() => setStep('write')}>
                  <ChevronLeft size={14} />
                  返回编辑
                </button>
                <span className="compose-spacer" />
                <button
                  className="primary"
                  disabled={busy || !canApprove}
                  onClick={() =>
                    void run(async () => {
                      await action('approve');
                      setStep('schedule');
                    })
                  }
                >
                  <Check size={14} />
                  {mode === 'later' ? '确认此版本并选择时间' : '确认此版本'}
                </button>
              </>
            ) : step === 'schedule' ? (
              <>
                <button disabled={busy} onClick={() => setStep('write')}>
                  <ChevronLeft size={14} />
                  返回编辑
                </button>
                <span className="compose-spacer" />
                <button
                  className="primary"
                  disabled={busy || (mode === 'later' && !scheduledInstant)}
                  onClick={() =>
                    void run(async () => {
                      const requestIdentity = identity.current;
                      const r = await api<OutgoingMail>(`/outgoing/${id}/schedule`, {
                        workspace,
                        method: 'POST',
                        body: {
                          version: saved!.version,
                          mode,
                          timezone: 'Asia/Shanghai',
                          ...(mode === 'later' ? { at: shanghaiScheduleInstant(sendAt) } : {}),
                        },
                      });
                      if (!mounted.current || identity.current !== requestIdentity)
                        throw new DOMException('写信窗口已切换', 'AbortError');
                      if (
                        !matchesComposerScope(r, {
                          id,
                          workspace,
                          customer: person.customer_id,
                          target: person.id,
                          kind,
                        })
                      )
                        throw new Error('排期结果与当前客户或收件对象不一致，请重新打开核对');
                      setSaved(r);
                      setStep('status');
                      onChanged();
                    })
                  }
                >
                  {mode === 'later' ? <Clock3 size={14} /> : <Send size={14} />}
                  {mode === 'later' ? '确认定时发送' : '确认立即发送'}
                </button>
              </>
            ) : (
              <>
                {saved && !locked && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (saved.status === 'scheduled') await action('cancel');
                        setStep('write');
                      })
                    }
                  >
                    {saved.status === 'scheduled' ? '取消排期并编辑' : '编辑邮件'}
                  </button>
                )}
                {saved && ['scheduled', 'approved'].includes(saved.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await action('cancel');
                      })
                    }
                  >
                    取消发送
                  </button>
                )}
                {saved && ['submitted', 'uncertain', 'partial'].includes(saved.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await action('reconcile');
                      })
                    }
                  >
                    核对发件记录
                  </button>
                )}
                <span className="compose-spacer" />
                <button disabled={busy} onClick={close}>
                  关闭
                </button>
              </>
            )}
          </footer>
        </>
      )}
      {templateView && (
        <MailTemplateLibrary
          variableCatalog={options?.mail_variables}
          workspace={workspace}
          customerName={person.customer_name || person.name}
          endpoint={templateEndpoint}
          initialView={templateView}
          templates={templates}
          loading={templatesLoading}
          loadError={templatesError}
          onReload={() => setTemplateRevision((value) => value + 1)}
          onClose={() => setTemplateView(null)}
          onSelect={selectTemplate}
          onCreated={(template) => {
            setSavedTemplates((values) => [
              template,
              ...values.filter((value) => value.id !== template.id),
            ]);
            setTemplatesError('');
            setTemplateRevision((value) => value + 1);
          }}
        />
      )}
      {selectedTemplate && (
        <Dialog
          title="使用这个模板？"
          onClose={() => setSelectedTemplate(null)}
          className="compose-close-dialog"
        >
          <div className="dialog-fields compose-template-preview compose-review">
            <p>
              {selectedTemplate.subject.trim()
                ? '将替换当前邮件的主题和正文，选用后可继续编辑。'
                : '将替换当前邮件的正文，保留现有主题，选用后可继续编辑。'}
            </p>
            <h3>{selectedTemplate.name}</h3>
            <strong>{selectedTemplate.subject.trim() || content.subject || '无预设主题'}</strong>
            <pre>{selectedTemplate.body}</pre>
          </div>
          <footer className="form-footer">
            <button onClick={() => setSelectedTemplate(null)}>保留当前内容</button>
            <button className="primary" onClick={() => applyTemplate(selectedTemplate)}>
              使用模板
            </button>
          </footer>
        </Dialog>
      )}
      {closing && (
        <Dialog
          title={closing === 'time' ? '退出发送时间选择？' : '保存这封邮件？'}
          onClose={() => {
            if (!actionBusy.current) setClosing(null);
          }}
          className="compose-close-dialog"
        >
          <div className="dialog-fields">
            {closing === 'time' ? (
              <p>邮件内容已保存，尚未确认发送。退出后不会发送或排期，所选时间不会保存。</p>
            ) : (
              <p>邮件有尚未保存的修改。放弃编辑只会丢弃本次未保存内容，已保存的草稿仍保留。</p>
            )}
            {closing === 'edits' && mode === 'later' && sendAt && (
              <p>保存仅保存邮件内容，不会排期；尚未确认的发送时间不会保存。</p>
            )}
            {pending && <p>有邮箱还未加入收件列表，请返回编辑后按回车添加。</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="form-footer">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!actionBusy.current) setClosing(null);
              }}
            >
              {closing === 'time' ? '继续设置' : '继续编辑'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!actionBusy.current) onClose();
              }}
            >
              {closing === 'time' ? '退出，不排期' : '放弃编辑'}
            </button>
            {closing === 'edits' && (
              <button
                className="primary"
                disabled={busy || pending}
                onClick={() =>
                  void run(async () => {
                    await save();
                    setClosing(null);
                    onClose();
                  })
                }
              >
                {busy ? '保存中…' : '保存并关闭'}
              </button>
            )}
          </footer>
        </Dialog>
      )}
    </Dialog>
  );
}
