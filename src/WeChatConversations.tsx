import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  CalendarDays,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { api } from './api';
import { GenerateActivitiesDialog } from './BusinessActivities';
import { Dialog } from './WorkspaceUI';
import { WorkspacePageHeader } from './WorkspacePage';
import { WeChatReviewDialog } from './WeChatReview';
import { ProspectSourceButton } from './ProspectSourceButton';
import { WeChatConnector } from './WeChatConnector';
import { parseWeChatConversationInput } from '../shared/wechat-conversation';
import type {
  WeChatConversation,
  WeChatPreview,
  WeChatQueryResult,
  WeChatRequest,
  WeChatStatus,
} from '../shared/wechat';
import './wechat.css';

type Directory = { items: WeChatConversation[]; total: number };
type History = { items: WeChatPreview[]; total: number };
type Notice = { id: string; role: 'user' | 'helper'; text: string };
type Pending = {
  identity: string;
  conversation_id?: string;
  start?: string;
  end?: string;
  candidates?: WeChatQueryResult['candidates'];
};
const label = (identity: WeChatConversation['identity']) =>
  identity.remark || identity.name || identity.wechat_id || identity.id;
const clock = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export function WeChatWorkspace(props: {
  workspace: string;
  admin: boolean;
  askButton?: ReactNode;
}) {
  return <ConversationWorkspace key={props.workspace} {...props} />;
}

function ConversationWorkspace({
  workspace,
  admin,
  askButton,
}: {
  workspace: string;
  admin: boolean;
  askButton?: ReactNode;
}) {
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [directory, setDirectory] = useState<Directory>({ items: [], total: 0 });
  const [history, setHistory] = useState<History>({ items: [], total: 0 });
  const [active, setActive] = useState<string | null>(null);
  const [preview, setPreview] = useState<WeChatPreview | null>(null);
  const [review, setReview] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityNotice, setActivityNotice] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState('');
  const [customDates, setCustomDates] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [watchLogin, setWatchLogin] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const requests = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const lastRequest = useRef<{ key: string; id: string } | null>(null);
  const ready = status?.state === 'ready';

  async function check(signal?: AbortSignal) {
    setChecking(true);
    try {
      const next = await api<WeChatStatus>('/wechat/status', { workspace, signal });
      setStatus(next);
      if (next.state === 'ready') {
        setConnectionOpen(false);
        setWatchLogin(false);
        input.current?.focus();
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }
  async function refreshDirectory(signal?: AbortSignal) {
    const next = await api<Directory>('/wechat/conversations', { workspace, signal });
    setDirectory(next);
    return next;
  }
  useEffect(() => {
    const controller = new AbortController();
    if (admin) void check(controller.signal);
    else setStatus({ state: 'unavailable', message: '本机微信连接由当前电脑的工作台管理员操作。' });
    void refreshDirectory(controller.signal).catch((e) => {
      if (e.name !== 'AbortError') setError(e.message);
    });
    return () => {
      controller.abort();
      requests.current?.abort();
      generation.current++;
    };
  }, [workspace, admin]);
  useEffect(() => {
    if (!watchLogin || !connectionOpen || !admin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function poll() {
      await check(controller.signal);
      if (!controller.signal.aborted && ++attempts < 20) timer = setTimeout(poll, 3000);
      else setWatchLogin(false);
    }
    timer = setTimeout(poll, 3000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [watchLogin, connectionOpen, admin]);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [notices, pending, busy]);

  function say(role: Notice['role'], text: string) {
    setNotices((rows) => [...rows, { id: crypto.randomUUID(), role, text }]);
  }
  function begin() {
    if (!ready) {
      setConnectionOpen(true);
      return;
    }
    generation.current++;
    requests.current?.abort();
    setActive(null);
    setPreview(null);
    setHistory({ items: [], total: 0 });
    setNotices([]);
    setPending(null);
    setError('');
    setDraft('');
    setCustomDates(false);
    lastRequest.current = null;
    input.current?.focus();
  }
  async function openConversation(conversation: WeChatConversation) {
    const token = ++generation.current;
    requests.current?.abort();
    const controller = new AbortController();
    requests.current = controller;
    setActive(conversation.id);
    setPreview(null);
    setPending(null);
    setNotices([]);
    setHistory({ items: [], total: 0 });
    setError('');
    setBusy(true);
    setCustomDates(false);
    setReview(false);
    try {
      const rows = await api<History>(`/wechat/conversations/${conversation.id}/queries`, {
        workspace,
        signal: controller.signal,
      });
      if (generation.current !== token) return;
      setHistory(rows);
      const latest = rows.items[0];
      if (latest) {
        const item = await api<WeChatPreview>(`/wechat/queries/${latest.id}`, {
          workspace,
          signal: controller.signal,
        });
        if (generation.current === token) {
          setPreview(item);
          if (feed.current) feed.current.scrollTop = 0;
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && generation.current === token)
        setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }
  async function openHistory(id: string) {
    setBusy(true);
    setError('');
    setNotices([]);
    setPending(null);
    setReview(false);
    // Clear the previous source before fetching, so an inaccessible source never leaves old text visible.
    setPreview(null);
    try {
      setPreview(await api<WeChatPreview>(`/wechat/queries/${id}`, { workspace }));
      if (feed.current) feed.current.scrollTop = 0;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function read(query: Pending & { start: string; end: string }, talker?: string) {
    if (!ready || !admin) {
      setConnectionOpen(true);
      return;
    }
    setBusy(true);
    setError('');
    setCustomDates(false);
    const body = {
      identity: query.identity,
      start: query.start,
      end: query.end,
      ...(query.conversation_id ? { conversation_id: query.conversation_id } : {}),
      ...(talker ? { talker } : {}),
    };
    const key = JSON.stringify(body);
    if (lastRequest.current?.key !== key) lastRequest.current = { key, id: crypto.randomUUID() };
    const token = ++generation.current;
    const controller = new AbortController();
    requests.current = controller;
    try {
      const result = await api<WeChatQueryResult>('/wechat/queries', {
        workspace,
        method: 'POST',
        body: { ...body, request_id: lastRequest.current!.id },
        signal: controller.signal,
      });
      if (token !== generation.current) return;
      if (result.candidates) {
        setPending({ ...query, candidates: result.candidates });
        say('helper', '找到了多位同名联系人，请选择具体的一位。');
      } else {
        const item = result.preview;
        setPreview(item);
        setPending(null);
        setNotices([]);
        setReview(false);
        lastRequest.current = null;
        const next = await refreshDirectory(controller.signal);
        if (token !== generation.current) return;
        const conversation = next.items.find((row) => row.latest.id === item.id);
        setActive(conversation?.id || null);
        if (conversation)
          setHistory(
            await api<History>(`/wechat/conversations/${conversation.id}/queries`, {
              workspace,
              signal: controller.signal,
            }),
          );
        if (feed.current) feed.current.scrollTop = 0;
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && token === generation.current)
        setError((e as Error).message);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  function send() {
    const text = draft.trim();
    if (!text || busy) return;
    if (!ready) {
      setConnectionOpen(true);
      return;
    }
    const base = pending?.identity || preview?.identity.id || '';
    const result = parseWeChatConversationInput(text, base);
    setDraft('');
    setError('');
    say('user', text);
    if (result.kind === 'cancel') {
      setPending(null);
      setCustomDates(false);
      say('helper', '已取消本次读取。');
      return;
    }
    if (result.kind === 'error') {
      say('helper', result.message);
      return;
    }
    const samePerson = result.identity === base;
    const conversation_id = samePerson
      ? pending?.conversation_id || active || undefined
      : undefined;
    if (result.kind === 'query') {
      const query = {
        identity: result.identity,
        start: result.start,
        end: result.end,
        conversation_id,
      };
      setPending(query);
      void read(query);
      return;
    }
    if (!samePerson) {
      setActive(null);
      setPreview(null);
      setHistory({ items: [], total: 0 });
      lastRequest.current = null;
    }
    setPending({ identity: result.identity, conversation_id });
    setCustomDates(false);
    setStart('');
    setEnd('');
    say('helper', `想查看与「${result.identity}」哪几天的聊天？`);
  }
  function chooseDays(text: string) {
    if (!pending) return;
    const result = parseWeChatConversationInput(text, pending.identity);
    if (result.kind !== 'query') return;
    say('user', text);
    const query = { ...pending, start: result.start, end: result.end, candidates: undefined };
    setPending(query);
    void read(query);
  }
  async function openNativeLogin() {
    setError('');
    try {
      await api('/wechat/open', { workspace, method: 'POST', body: {} });
      setConnectionOpen(true);
      setWatchLogin(true);
      await check();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const nativeName =
    status?.platform === 'windows'
      ? 'Windows 微信'
      : status?.platform === 'macos'
        ? 'Mac 微信'
        : '本机微信';
  const connectionCard = (
    <WeChatConnector
      status={status}
      checking={checking}
      admin={admin}
      nativeName={nativeName}
      onCheck={() => void check()}
      onOpen={() => void openNativeLogin()}
    />
  );

  return (
    <section className="wechat-chat-workspace workspace-page">
      <WorkspacePageHeader
        title="微信沟通管理"
        description="查看已读取的会话，按需指定联系人和日期。"
        meta={
          <span className={`wechat-status-pill ${ready ? 'is-ready' : ''}`}>
            <i />
            {ready
              ? '已连接'
              : checking || !status
                ? '检查中'
                : status.state === 'needs_setup'
                  ? '待初始化'
                  : '待连接'}
          </span>
        }
        actions={
          <>
            <button onClick={() => setConnectionOpen(true)}>
              {ready ? '连接设置' : '连接微信'}
            </button>
            {askButton}
          </>
        }
      />
      <div className="wechat-chat-layout">
        <div className="wechat-chat-main">
          {(preview || active) && (
            <header className="wechat-reader-heading">
              <div>
                <strong>
                  {preview
                    ? label(preview.identity)
                    : directory.items.find((row) => row.id === active)
                      ? label(directory.items.find((row) => row.id === active)!.identity)
                      : '聊天记录'}
                </strong>
                <span>仅自己可见</span>
              </div>
              <div>
                {history.items.length > 0 && (
                  <select
                    aria-label="已读取的日期范围"
                    value={preview?.id || ''}
                    onChange={(e) => void openHistory(e.target.value)}
                    disabled={busy}
                  >
                    {!preview && <option value="">正在打开…</option>}
                    {history.items.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.start} 至 {row.end} · {row.message_count}条
                      </option>
                    ))}
                  </select>
                )}
                {preview?.state === 'associated' && preview.customer_id && (
                  <>
                    <ProspectSourceButton
                      workspace={workspace}
                      customerId={preview.customer_id}
                      sourceKind="wechat"
                      sourceId={preview.id}
                      disabled={busy}
                    />
                    <button disabled={busy} onClick={() => setActivityOpen(true)}>
                      生成活动
                      <ChevronRight size={12} />
                    </button>
                  </>
                )}
                {preview && (
                  <button onClick={() => setReview(true)} disabled={busy}>
                    {preview.state === 'associated' ? '已自动归档' : '待关联归属'}
                    <ChevronRight size={12} />
                  </button>
                )}
              </div>
            </header>
          )}
          <div className="wechat-chat-feed" ref={feed} aria-busy={busy}>
            {activityNotice && (
              <p className="ba-notice" role="status">
                {activityNotice}
              </p>
            )}
            {!preview && !notices.length && !busy && (
              <div className="wechat-chat-welcome">
                {!ready ? (
                  connectionOpen ? (
                    <p>请在连接窗口中检查本机微信状态。</p>
                  ) : (
                    connectionCard
                  )
                ) : (
                  <>
                    <div className="wechat-welcome-icon">
                      <MessageCircle size={30} strokeWidth={1.5} />
                    </div>
                    <h2>想查看与谁的聊天？</h2>
                    <p>发送微信号、微信名或备注，添加一段对话。</p>
                  </>
                )}
              </div>
            )}
            {preview && (
              <section
                className="wechat-chat-transcript"
                aria-label={`与${label(preview.identity)}的已读取聊天记录`}
              >
                <p className="wechat-transcript-date">
                  {preview.start} 至 {preview.end} · {preview.message_count} 条文字
                </p>
                {!preview.messages.length && (
                  <p className="wechat-transcript-empty">
                    这些日期内没有文字消息，可以另选日期查看。
                  </p>
                )}
                {preview.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`wechat-message ${message.from_me ? 'from-me' : ''}`}
                  >
                    <div className="wechat-message-avatar" aria-hidden="true">
                      {message.from_me ? '我' : label(preview.identity).slice(0, 1)}
                    </div>
                    <div>
                      <small>
                        {message.from_me ? '我' : message.speaker} · {clock(message.at)}
                      </small>
                      <p>{message.text}</p>
                    </div>
                  </article>
                ))}
                <p className="wechat-transcript-footnote">
                  {preview.warnings.join(' ') || '当前展示的是已读取的文字记录。'}
                  {preview.state === 'associated'
                    ? ` 已按对话归属自动整理，关联 ${preview.record_count || 1} 条业务记录；新旧表达和原文来源保留。`
                    : ' 文字已整理在本人待关联区；选择对话归属后自动归档，不需要逐条确认。'}
                </p>
                {history.total > history.items.length && (
                  <p className="wechat-transcript-footnote">
                    日期列表显示最近 {history.items.length} 次读取，共 {history.total} 次。
                  </p>
                )}
              </section>
            )}
            <div className="wechat-local-dialogue" role="log" aria-label="微信查询对话">
              {notices.map((notice) => (
                <div className={`wechat-dialogue-note ${notice.role}`} key={notice.id}>
                  <p>{notice.text}</p>
                </div>
              ))}
              {pending && !pending.start && !busy && (
                <div className="wechat-date-choices">
                  {['今天', '昨天', '最近7天'].map((day) => (
                    <button key={day} onClick={() => chooseDays(day)}>
                      {day}
                    </button>
                  ))}
                  <button
                    onClick={() => setCustomDates((value) => !value)}
                    aria-expanded={customDates}
                  >
                    <CalendarDays size={13} />
                    选择日期
                  </button>
                </div>
              )}
              {customDates && pending && (
                <form
                  className="wechat-inline-dates"
                  onSubmit={(e) => {
                    e.preventDefault();
                    say('user', `${start} 至 ${end}`);
                    void read({ ...pending, start, end });
                  }}
                >
                  <label>
                    开始日期
                    <input
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      required
                      disabled={busy}
                    />
                  </label>
                  <span>至</span>
                  <label>
                    结束日期
                    <input
                      type="date"
                      min={start}
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      required
                      disabled={busy}
                    />
                  </label>
                  <button disabled={!start || !end || busy}>查看聊天</button>
                </form>
              )}
              {pending?.candidates && !busy && (
                <div className="wechat-contact-choices" aria-label="选择微信联系人">
                  {pending.candidates.map((contact) => (
                    <button
                      key={contact.id}
                      onClick={() =>
                        void read(
                          { ...pending, start: pending.start!, end: pending.end! },
                          contact.id,
                        )
                      }
                    >
                      <span className="wechat-person-avatar">{label(contact).slice(0, 1)}</span>
                      <span>
                        <strong>{label(contact)}</strong>
                        <small>{contact.wechat_id || contact.id}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              )}
              {busy && (
                <p className="wechat-query-progress" role="status">
                  <LoaderCircle size={14} className="wechat-spin" />
                  正在打开指定的聊天记录…
                </p>
              )}
            </div>
          </div>
          <footer className="wechat-composer-area">
            {error && (
              <p role="alert" className="wechat-chat-error">
                {error}
              </p>
            )}
            <form
              className="wechat-chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <MessageCircle size={17} aria-hidden="true" />
              <input
                ref={input}
                aria-label="微信查询消息"
                placeholder={
                  ready
                    ? pending && !pending.start
                      ? '输入日期，例如：昨天或最近7天'
                      : '输入微信号、微信名或备注…'
                    : '连接微信后，添加想查看的对话'
                }
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy || !ready}
                maxLength={300}
              />
              <button
                type="submit"
                aria-label="发送查询"
                disabled={!ready || busy || !draft.trim()}
              >
                <ArrowUp size={17} />
              </button>
            </form>
            <span className="wechat-composer-hint">
              指定联系人和日期后读取 · 仅保存在你的工作台
            </span>
          </footer>
        </div>
        <aside className="wechat-conversation-sidebar" aria-label="已添加的微信对话">
          <header>
            <h2>
              已添加的对话<span>{directory.total}</span>
            </h2>
            <button
              className="icon-button"
              onClick={begin}
              disabled={busy}
              aria-label="添加微信对话"
            >
              <Plus size={16} />
            </button>
          </header>
          {!directory.items.length && (
            <div className="wechat-conversation-empty">
              <MessageCircle size={22} strokeWidth={1.25} />
              <p>还没有添加对话</p>
              <small>查看过的联系人会显示在这里。</small>
            </div>
          )}
          <div className="wechat-conversation-items">
            {directory.items.map((conversation) => (
              <button
                key={conversation.id}
                className={active === conversation.id ? 'active' : ''}
                aria-pressed={active === conversation.id}
                disabled={busy}
                onClick={() => void openConversation(conversation)}
              >
                <span className="wechat-person-avatar">
                  {label(conversation.identity).slice(0, 1)}
                </span>
                <span>
                  <strong>{label(conversation.identity)}</strong>
                  <small>
                    {conversation.identity.wechat_id ||
                      conversation.identity.name ||
                      conversation.identity.id}
                  </small>
                  <span>
                    {conversation.latest.end} · {conversation.query_count}次读取
                  </span>
                </span>
              </button>
            ))}
          </div>
          {directory.total > directory.items.length && (
            <p className="wechat-sidebar-footnote">
              显示最近 {directory.items.length} 个对话，共 {directory.total} 个。
            </p>
          )}
          <div className="wechat-sidebar-private">
            <ShieldCheck size={13} />
            <span>已添加对话仅自己可见</span>
          </div>
        </aside>
      </div>
      {connectionOpen && (
        <Dialog
          title={ready ? '微信连接' : '连接微信'}
          onClose={() => {
            setConnectionOpen(false);
            setWatchLogin(false);
          }}
          className="wechat-connect-dialog"
        >
          {ready ? (
            <div className="wechat-connection-ready">
              <ShieldCheck size={30} />
              <h3>微信已连接</h3>
              <p>可以添加联系人并选择日期查看聊天。</p>
            </div>
          ) : (
            connectionCard
          )}
          <details className="wechat-connection-help">
            <summary>连接帮助</summary>
            <p>{status?.message || '正在核对本机连接状态。'}</p>
            <p>使用本机已登录的微信账号；首次读取初始化和系统授权需要另行操作。</p>
          </details>
          {error && (
            <p role="alert" className="wechat-chat-error">
              {error}
            </p>
          )}
        </Dialog>
      )}
      {activityOpen && preview?.customer_id && preview.state === 'associated' && (
        <GenerateActivitiesDialog
          workspace={workspace}
          customerId={preview.customer_id}
          personId={preview.person_id || undefined}
          projectId={preview.project_id || undefined}
          sourceContext={{ channel: 'wechat', wechatQueryId: preview.id }}
          onClose={() => setActivityOpen(false)}
          onGenerated={(result) => {
            setActivityOpen(false);
            setActivityNotice(
              result.activities.length
                ? `已${result.reused ? '读取已有' : '生成并保存'} ${result.activities.length} 条活动，可在对应公司／联系人活动页查看。`
                : '本批没有符合所选类型的活动，原文保留。',
            );
          }}
        />
      )}
      {review && preview && (
        <WeChatReviewDialog
          key={preview.id}
          preview={preview}
          workspace={workspace}
          onClose={() => setReview(false)}
          onAssociated={(item) => {
            setPreview(item);
            setHistory((rows) => ({
              ...rows,
              items: rows.items.map((row) =>
                row.id === item.id ? { ...row, state: item.state } : row,
              ),
            }));
            void refreshDirectory().catch((e) => setError(e.message));
          }}
        />
      )}
    </section>
  );
}
