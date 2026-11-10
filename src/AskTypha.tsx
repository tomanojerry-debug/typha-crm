import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, MessageCircle, Plus, X } from 'lucide-react';
import type {
  AskScope,
  AskContext,
  AskAnswer,
  AskSource,
  AskAction,
  AskEvidence,
} from '../shared/ask';
import type { Selection } from './Workbench';
import type { Chat, ChatDetail } from '../shared/chat';
import type { AgentCapabilities } from '../shared/agent';
import { activeAgentRun, type AgentRun, type AgentRunResult } from '../shared/agent-runs';
import {
  observeAgentRun,
  onAgentActivity,
  publishAgentActivity,
  runFailure,
  submitAgentRun,
} from './agent-runs-client';
import { api, HttpError, streamApi, isDemoRuntime } from './api';
import { Dialog } from './WorkspaceUI';
import { AgentAnswer } from './AgentAnswer';
import { AgentReplySources } from './AgentReplyCards';
import {
  canOrganizeAnswerAsNote,
  organizeAnswerAsNote,
  openAgentNoteDraft,
} from './note-agent-client';
import './ask-typha.css';

export function AskTyphaButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      className={`ask-typha-trigger ${open ? 'is-open' : ''}`}
      onClick={onClick}
      aria-expanded={open}
      aria-controls="ask-typha-panel"
    >
      <MessageCircle size={14} strokeWidth={1.7} /> Ask Typha
    </button>
  );
}

type Turn = { id: string; requestId?: string; question: string; answer: AskAnswer };
function restoredTurns(detail: ChatDetail): Turn[] {
  const result: Turn[] = [];
  let question = '';
  for (const message of detail.messages) {
    if (message.role === 'user') question = message.body;
    else if (question) {
      result.push({
        id: message.id,
        question,
        answer: {
          body: message.body,
          sources: message.sources || [],
          generated_at: message.created_at,
          mode: message.model ? 'model' : 'local',
          ...(message.model ? { model: message.model } : {}),
        },
      });
      question = '';
    }
  }
  return result;
}
const fail = (e: unknown) => (e instanceof Error ? e.message : '查询失败，请重试');
export function AskTyphaPanel({
  workspace,
  runOwner,
  scope,
  open,
  refresh,
  onClose,
  onSelect,
  onSessionSaved,
}: {
  workspace: string;
  runOwner: string;
  scope: AskScope;
  open: boolean;
  refresh: number;
  onClose: () => void;
  onSelect: (s: Selection) => void;
  onSessionSaved: () => void;
}) {
  const [context, setContext] = useState<AskContext | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState('');
  const [draftAnswer, setDraftAnswer] = useState('');
  const [evidence, setEvidence] = useState<AskEvidence | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [backgroundRuns, setBackgroundRuns] = useState(false);
  const [notesEnabled, setNotesEnabled] = useState(false);
  const [noteSaving, setNoteSaving] = useState<string | null>(null);
  const noteRequest = useRef<AbortController | null>(null);
  const noteRequestIds = useRef(new Map<string, string>());
  const [reconnecting, setReconnecting] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const submitting = useRef(false);
  const busy = accepting || (run ? activeAgentRun(run) : Boolean(pending));
  const continuation = useRef<string | undefined>(undefined);
  const chatId = useRef<string | null>(null);
  const sendRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const historyRestored = useRef(false);
  const newSession = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const end = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const sourceRequest = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify(scope);
  const noteView = useRef({ workspace, scopeKey, open, runOwner });
  noteView.current = { workspace, scopeKey, open, runOwner };
  useEffect(() => {
    setNoteSaving(null);
    return () => noteRequest.current?.abort();
  }, [workspace, scopeKey, open, runOwner]);
  function receiveRun(result: AgentRunResult) {
    setRun(result.run);
    setTurns(restoredTurns(result.detail));
    setPending(result.run.status === 'completed' ? '' : result.run.question);
    setDraftAnswer(activeAgentRun(result.run) ? result.run.answer : '');
    setError(
      !activeAgentRun(result.run) && result.run.status !== 'completed'
        ? runFailure(result.run)
        : '',
    );
    chatId.current = result.detail.chat.id;
    continuation.current = undefined;
    newSession.current = false;
  }
  useEffect(
    () =>
      onAgentActivity(runOwner, ({ result }) => {
        if (result && result.detail.chat.id === chatId.current && open) receiveRun(result);
      }),
    [runOwner, open],
  );
  useEffect(() => {
    if (!open || !run || !activeAgentRun(run)) return;
    const controller = new AbortController();
    request.current = controller;
    void observeAgentRun({
      owner: runOwner,
      workspace,
      run,
      signal: controller.signal,
      onRun: (next) => {
        if (controller.signal.aborted) return;
        setRun(next);
        setPending(next.status === 'completed' ? '' : next.question);
        setDraftAnswer(activeAgentRun(next) ? next.answer : '');
        setError(!activeAgentRun(next) && next.status !== 'completed' ? runFailure(next) : '');
      },
      onDone: (result) => {
        if (!controller.signal.aborted) receiveRun(result);
      },
      onReconnect: (value) => {
        if (!controller.signal.aborted) setReconnecting(value);
      },
    }).catch((e) => {
      if (!controller.signal.aborted) {
        setRun(null);
        setPending('');
        setDraftAnswer('');
        setError(fail(e));
      }
    });
    return () => controller.abort();
  }, [run?.id, Boolean(run && activeAgentRun(run)), open, workspace, runOwner]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    sourceRequest.current?.abort();
    setSourceBusy(false);
    const restore = !historyRestored.current;
    if (restore) setLoading(true);
    if (!run || activeAgentRun(run)) setError('');
    setEvidence(null);
    Promise.all([
      api<AskContext>('/ask/context', {
        workspace,
        method: 'POST',
        body: { scope },
        signal: controller.signal,
      }),
      api<AgentCapabilities>('/agent/capabilities', { workspace, signal: controller.signal }).catch(
        () => null,
      ),
      restore && !newSession.current
        ? api<{ items: Chat[] }>(
            `/chats/page?limit=1&origin_scope=${encodeURIComponent(scopeKey)}`,
            { workspace, signal: controller.signal },
          ).then(async (page) =>
            page.items[0]
              ? api<ChatDetail>(`/chats/${page.items[0].id}`, {
                  workspace,
                  signal: controller.signal,
                })
              : null,
          )
        : Promise.resolve(null),
    ])
      .then(([c, caps, detail]) => {
        if (controller.signal.aborted) return;
        setContext(c);
        setBackgroundRuns(Boolean(caps?.background_runs));
        setNotesEnabled(Boolean(caps?.notes));
        if (restore) {
          if (detail) {
            chatId.current = detail.chat.id;
            setTurns(restoredTurns(detail));
            if (detail.run) receiveRun({ run: detail.run, detail });
            else {
              setRun(null);
              setPending('');
              setDraftAnswer('');
            }
          }
          historyRestored.current = true;
        }
        setLoading(false);
        input.current?.focus();
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setContext(null);
          setError(fail(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [workspace, scopeKey, open, refresh, revision]);
  useEffect(() => {
    if (!open) {
      historyRestored.current = false;
      request.current?.abort();
      sourceRequest.current?.abort();
      setPending('');
      setDraftAnswer('');
      setSourceBusy(false);
      setEvidence(null);
    }
    return () => {
      request.current?.abort();
      sourceRequest.current?.abort();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement as HTMLElement | null;
    const focus = () => setRevision((v) => v + 1);
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal[open]')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
      if (
        e.key === 'Tab' &&
        window.matchMedia('(max-width: 1100px)').matches &&
        !document.querySelector('.modal[open]')
      ) {
        const items = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled)',
          ) || [],
        );
        if (!items.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first || !panel.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last || !panel.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('focus', focus);
    document.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('focus', focus);
      document.removeEventListener('keydown', escape, true);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [open]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns, pending, draftAnswer]);

  async function send(text = question, action?: AskAction) {
    if (!text.trim() || busy || submitting.current || loading || !context) return;
    submitting.current = true;
    setAccepting(true);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(text.trim());
    setDraftAnswer('');
    setQuestion('');
    setError('');
    try {
      chatId.current ||= crypto.randomUUID();
      const fingerprint = JSON.stringify({
        chatId: chatId.current,
        scope,
        text: text.trim(),
        action,
      });
      if (sendRequest.current?.fingerprint !== fingerprint)
        sendRequest.current = { fingerprint, id: crypto.randomUUID() };
      const payload = {
        chat_id: chatId.current,
        request_id: sendRequest.current.id,
        scope,
        question: text.trim(),
        ...(action ? { action } : {}),
        ...(continuation.current ? { continuation: continuation.current } : {}),
      };
      if (backgroundRuns) {
        const result = await submitAgentRun(
          runOwner,
          workspace,
          { id: chatId.current },
          '/ask/runs',
          payload,
          { ref: sendRequest, id: payload.request_id },
        );
        if (!controller.signal.aborted) receiveRun(result);
        return;
      }
      const result = await streamApi<AskAnswer>('/ask/query', {
        workspace,
        onText: (answer) => {
          if (!controller.signal.aborted) setDraftAnswer(answer);
        },
        body: payload,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      continuation.current = result.continuation;
      chatId.current = result.chat_id || chatId.current;
      sendRequest.current = null;
      newSession.current = false;
      setTurns((prev) => [
        ...prev,
        {
          id: payload.request_id,
          requestId: payload.request_id,
          question: text.trim(),
          answer: result,
        },
      ]);
      onSessionSaved();
    } catch (e) {
      if (!controller.signal.aborted) {
        if (backgroundRuns && e instanceof HttpError && e.status === 409 && chatId.current) {
          const detail = await api<ChatDetail>(`/chats/${chatId.current}`, { workspace }).catch(
            () => null,
          );
          if (!controller.signal.aborted && detail?.run && activeAgentRun(detail.run)) {
            receiveRun({ run: detail.run, detail });
            setQuestion(text);
            setError('当前消息仍在处理中，已保留本次输入，请稍后再发送');
            return;
          }
        }
        setDraftAnswer('');
        setQuestion(text);
        setError(fail(e));
        if (backgroundRuns) setPending('');
      }
    } finally {
      submitting.current = false;
      setAccepting(false);
      if (!controller.signal.aborted) {
        if (!backgroundRuns) {
          setPending('');
          setDraftAnswer('');
        }
        input.current?.focus();
      }
    }
  }
  async function controlRun(action: 'cancel' | 'retry') {
    if (!run || submitting.current) return;
    const selected = run;
    submitting.current = true;
    setAccepting(true);
    const controller = request.current;
    try {
      const result = await submitAgentRun(
        runOwner,
        workspace,
        { id: selected.chat_id },
        `/chats/${selected.chat_id}/runs/${selected.id}/${action}`,
        {},
      );
      publishAgentActivity(runOwner, result.detail.chat, result);
      if (!controller?.signal.aborted) receiveRun(result);
    } catch (e) {
      if (!controller?.signal.aborted) setError(fail(e));
    } finally {
      submitting.current = false;
      setAccepting(false);
    }
  }
  async function organizeTurnAsNote(turn: Turn) {
    if (
      busy ||
      noteSaving ||
      (noteRequest.current && !noteRequest.current.signal.aborted) ||
      !chatId.current ||
      !canOrganizeAnswerAsNote(turn.answer.sources)
    )
      return;
    const selectedChat = chatId.current;
    const key = `${selectedChat}:${turn.id}`;
    const requestId = noteRequestIds.current.get(key) || crypto.randomUUID();
    noteRequestIds.current.set(key, requestId);
    const controller = new AbortController();
    noteRequest.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      noteView.current.open &&
      noteView.current.runOwner === runOwner &&
      noteView.current.workspace === workspace &&
      noteView.current.scopeKey === scopeKey &&
      chatId.current === selectedChat;
    setNoteSaving(turn.id);
    setError('');
    try {
      const result = await organizeAnswerAsNote(
        workspace,
        {
          request_id: requestId,
          chat_id: selectedChat,
          ...(turn.requestId ? { message_request_id: turn.requestId } : { message_id: turn.id }),
        },
        controller.signal,
      );
      if (isCurrent())
        openAgentNoteDraft(workspace, result.draft, runOwner.slice(workspace.length + 1));
    } catch (e) {
      if (isCurrent()) setError(fail(e));
    } finally {
      if (noteRequest.current === controller) {
        noteRequest.current = null;
        if (
          !controller.signal.aborted &&
          noteView.current.workspace === workspace &&
          noteView.current.scopeKey === scopeKey
        )
          setNoteSaving(null);
      }
    }
  }
  async function showSource(source: AskSource) {
    if (source.kind === 'entity') {
      onSelect({
        customerId: source.customer_id,
        full: true,
        ...(source.object === 'people' ? { personId: source.id } : {}),
        ...(source.object === 'projects' ? { projectId: source.id } : {}),
      });
      return;
    }
    sourceRequest.current?.abort();
    const controller = new AbortController();
    sourceRequest.current = controller;
    setSourceBusy(true);
    setError('');
    try {
      const result = await api<AskEvidence>('/ask/source', {
        workspace,
        method: 'POST',
        body: { scope, kind: source.kind, id: source.id },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setEvidence(result);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(fail(e));
      }
    } finally {
      if (!controller.signal.aborted) setSourceBusy(false);
    }
  }
  return (
    <aside
      ref={panel}
      id="ask-typha-panel"
      className="ask-typha-panel"
      aria-label="Ask Typha 页面助手"
      hidden={!open}
    >
      <header className="ask-panel-heading">
        <span>
          <MessageCircle size={16} strokeWidth={1.7} />
          <strong>Ask Typha</strong>
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="新建页面对话"
            title="新问答"
            disabled={(!backgroundRuns && busy) || loading || accepting}
            onClick={() => {
              request.current?.abort();
              noteRequest.current?.abort();
              setNoteSaving(null);
              setTurns([]);
              setRun(null);
              setPending('');
              setDraftAnswer('');
              chatId.current = crypto.randomUUID();
              sendRequest.current = null;
              newSession.current = true;
              continuation.current = undefined;
              setQuestion('');
              setError('');
              input.current?.focus();
            }}
          >
            <Plus size={16} />
          </button>
          <button className="icon-button" aria-label="关闭 Ask Typha" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="ask-context">
        <span className="ask-context-dot" />
        <span>
          {loading
            ? '正在核对页面范围…'
            : scope.kind === 'page' && scope.page === 'mail'
              ? '邮件管理'
              : scope.kind === 'page' && scope.page === 'wechat'
                ? '微信沟通管理'
                : context?.label || '当前页面'}
        </span>
      </div>
      <div className="ask-panel-scroll" aria-live="polite" aria-busy={busy || loading}>
        {!turns.length && !pending && !loading && context && (
          <div className="ask-welcome">
            <div className="ask-welcome-icon">
              <MessageCircle size={23} strokeWidth={1.4} />
            </div>
            <h2>从这里开始了解</h2>
            <p>{context.description}</p>
            <div className="ask-suggestions">
              {context.suggestions.map((s) => (
                <button key={s.action} onClick={() => void send(s.text, s.action)}>
                  <span>{s.text}</span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        {!loading &&
          turns.map((turn) => (
            <div className="ask-turn" key={turn.id}>
              <p className="ask-question">{turn.question}</p>
              <div className="ask-answer">
                <AgentAnswer body={turn.answer.body} />
                <AgentReplySources
                  sources={turn.answer.sources}
                  label="依据与相关记录"
                  disabled={sourceBusy}
                  onOpen={(source: AskSource) => void showSource(source)}
                />
                {notesEnabled &&
                  turn.answer.mode === 'model' &&
                  canOrganizeAnswerAsNote(turn.answer.sources) && (
                    <button
                      className="text-button"
                      disabled={busy || Boolean(noteSaving)}
                      title="按当前授权来源重新整理为本人草稿，过目保存后才供同事和 Agent 使用"
                      onClick={() => void organizeTurnAsNote(turn)}
                    >
                      {noteSaving === turn.id ? '正在整理…' : '整理为笔记'}
                    </button>
                  )}
              </div>
            </div>
          ))}
        {!!pending && (
          <div className="ask-turn">
            <p className="ask-question">{pending}</p>
            {draftAnswer ? (
              <div className="ask-answer" aria-busy="true">
                {reconnecting && <small role="status">正在恢复连接，任务继续处理中</small>}
                <AgentAnswer body={draftAnswer} />
              </div>
            ) : !error && (!run || activeAgentRun(run)) ? (
              <p className="ask-pending" role="status">
                {reconnecting
                  ? '正在恢复连接，任务继续处理中'
                  : run?.status === 'cancelling'
                    ? '正在停止…'
                    : '正在思考'}
              </p>
            ) : null}
            {run && activeAgentRun(run) && (
              <button
                className="text-button"
                disabled={accepting || run.status === 'cancelling'}
                onClick={() => void controlRun('cancel')}
              >
                {run.status === 'cancelling' ? '正在停止…' : '停止回复'}
              </button>
            )}
          </div>
        )}
        {!!error && (
          <div className="ask-error" role="alert">
            <p>{error}</p>
            {run && !activeAgentRun(run) && run.status !== 'completed' && (
              <button disabled={accepting} onClick={() => void controlRun('retry')}>
                重试
              </button>
            )}
            {!context && <button onClick={() => setRevision((v) => v + 1)}>重新加载</button>}
          </div>
        )}
        <div ref={end} />
      </div>
      <footer className="ask-panel-footer">
        {!!turns.length && !loading && (
          <div className="ask-followups">
            {context?.suggestions.map((s) => (
              <button key={s.action} disabled={busy} onClick={() => void send(s.text, s.action)}>
                {s.text}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            aria-label="向 Ask Typha 提问"
            placeholder="询问当前页面的记录与联系…"
            rows={2}
            maxLength={2000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={loading || !context}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div>
            <span>Enter 发送 · Shift Enter 换行</span>
            <button
              type="submit"
              className="ask-send"
              aria-label="发送问题"
              disabled={!question.trim() || busy || loading || !context}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </form>
        <p>
          {isDemoRuntime()
            ? '示例空间 · 在线体验不调用模型服务'
            : context?.model
              ? 'MiniMax M3.1 Flash · 回答请核对来源'
              : 'AI 服务暂未就绪 · 当前为本地查询'}
        </p>
      </footer>
      {evidence && (
        <Dialog
          title={evidence.title}
          className="ask-evidence-dialog"
          onClose={() => setEvidence(null)}
        >
          <div className="ask-evidence-body">{evidence.body}</div>
        </Dialog>
      )}
    </aside>
  );
}
