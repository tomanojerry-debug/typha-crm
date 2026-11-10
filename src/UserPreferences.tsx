import { useEffect, useRef, useState } from 'react';
import { Brain, MessageSquare, Pencil, Settings2, Trash2 } from 'lucide-react';
import { userPreferenceOptions, type UserPreferenceSetting } from '../shared/user-preferences';
import { api, HttpError, isDemoRuntime } from './api';
import { Dialog } from './WorkspaceUI';
import { ActivitySettings } from './ActivitySettings';

const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const updatedTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '时间暂不可用'
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
};

type Edit = { id: string; value: string; originalValue: string; version: string };
type ActionError = { id: string; message: string; conflict?: boolean };

export function UserPreferences({
  workspace,
  workspaceName,
  admin = false,
  onClose,
  onOpenChat,
}: {
  workspace: string;
  workspaceName: string;
  admin?: boolean;
  onClose: () => void;
  onOpenChat: (id: string) => void;
}) {
  const [section, setSection] = useState<'memory' | 'activities'>('memory');
  const [preferences, setPreferences] = useState<UserPreferenceSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [busy, setBusy] = useState<{ id: string; kind: 'save' | 'delete' } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [revision, setRevision] = useState(0);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState('');
  const mutation = useRef<AbortController | null>(null);
  const leavePrompt = useRef<HTMLDivElement>(null);
  const editControl = useRef<HTMLSelectElement>(null);
  const dirty = !!edit && edit.value !== edit.originalValue;
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    if (pendingAction) leavePrompt.current?.scrollIntoView({ block: 'nearest' });
  }, [pendingAction]);
  useEffect(() => {
    if (edit?.id) editControl.current?.focus();
  }, [edit?.id]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    api<UserPreferenceSetting[]>('/agent/preferences', { workspace, signal: controller.signal })
      .then((items) => {
        setPreferences(items);
        setLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(errorText(error));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [workspace, revision]);
  function requestAction(action: () => void) {
    if (busy) return;
    if (dirty) setPendingAction(() => action);
    else action();
  }
  function beginEdit(preference: UserPreferenceSetting) {
    requestAction(() => {
      setEdit({
        id: preference.id,
        value: preference.value,
        originalValue: preference.value,
        version: preference.version,
      });
      setActionError(null);
      setNotice('');
    });
  }
  async function save() {
    if (!edit || busy || !dirty) return;
    const current = edit;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy({ id: current.id, kind: 'save' });
    setActionError(null);
    setNotice('');
    try {
      const updated = await api<UserPreferenceSetting>(`/agent/preferences/${current.id}`, {
        workspace,
        method: 'PATCH',
        body: { value: current.value, expected_version: current.version },
        signal: controller.signal,
      });
      setPreferences((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setEdit(null);
      setPendingAction(null);
      setNotice(
        isDemoRuntime()
          ? '示例偏好已更新，仅在当前页面保留。'
          : '偏好已更新，后续回答将使用新偏好。',
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setActionError({
          id: current.id,
          message: errorText(error),
          conflict: error instanceof HttpError && [404, 409].includes(error.status),
        });
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function forget(id: string) {
    if (busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy({ id, kind: 'delete' });
    setActionError(null);
    setNotice('');
    try {
      await api(`/agent/preferences/${id}`, {
        workspace,
        method: 'DELETE',
        body: {},
        signal: controller.signal,
      });
      setPreferences((items) => items.filter((item) => item.id !== id));
      if (edit?.id === id) setEdit(null);
      setNotice(
        isDemoRuntime()
          ? '示例偏好已删除，重置后恢复。'
          : '偏好已删除，后续回答将不再使用这条偏好。',
      );
    } catch (error) {
      if (!controller.signal.aborted) setActionError({ id, message: errorText(error) });
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  function reload() {
    setEdit(null);
    setPendingAction(null);
    setActionError(null);
    setNotice('');
    setRevision((value) => value + 1);
  }
  return (
    <Dialog title="设置" className="user-preferences-dialog" onClose={() => requestAction(onClose)}>
      <div className="personal-settings-layout">
        <nav className="personal-settings-nav" aria-label="设置分类">
          <button
            className={section === 'memory' ? 'active' : ''}
            aria-current={section === 'memory' ? 'page' : undefined}
            onClick={() => requestAction(() => setSection('memory'))}
          >
            <Brain size={15} aria-hidden="true" />
            记忆偏好
          </button>
          <button
            className={section === 'activities' ? 'active' : ''}
            aria-current={section === 'activities' ? 'page' : undefined}
            onClick={() => requestAction(() => setSection('activities'))}
          >
            <Settings2 size={15} />
            活动与 Schema
          </button>
        </nav>
        {section === 'activities' ? (
          <ActivitySettings workspace={workspace} admin={admin} />
        ) : (
          <section className="personal-settings-content" aria-labelledby="memory-settings-title">
            <div className="personal-settings-heading">
              <div className="memory-settings-icon" aria-hidden="true">
                <Settings2 size={19} />
              </div>
              <div>
                <p className="personal-settings-eyebrow">个人设置</p>
                <h3 id="memory-settings-title">记忆偏好</h3>
              </div>
            </div>
            <p className="personal-settings-description">
              在对话中明确说“记住”或“以后都这样”时保存。你可以在这里修改或删除已保存的偏好。
            </p>
            <p className="personal-settings-scope">
              仅供你本人在「{workspaceName}」工作空间使用。编辑会保留最初的来源会话。
            </p>
            {pendingAction && (
              <div className="memory-settings-leave" ref={leavePrompt} role="alert">
                <p>当前偏好有未保存的修改。</p>
                <div>
                  <button onClick={() => setPendingAction(null)}>继续编辑</button>
                  <button
                    onClick={() => {
                      const action = pendingAction;
                      setPendingAction(null);
                      setEdit(null);
                      action();
                    }}
                  >
                    放弃修改并继续
                  </button>
                </div>
              </div>
            )}
            {notice && (
              <p className="memory-settings-notice" role="status">
                {notice}
              </p>
            )}
            {loading ? (
              <p className="user-preferences-empty" role="status">
                正在读取记忆偏好…
              </p>
            ) : loadError ? (
              <div className="memory-settings-load-error" role="alert">
                <p>{loadError}</p>
                <button onClick={reload}>重新加载</button>
              </div>
            ) : preferences.length ? (
              <ul className="user-preferences-list">
                {preferences.map((preference) => {
                  const definition = userPreferenceOptions[preference.category];
                  const editing = edit?.id === preference.id;
                  return (
                    <li key={preference.id}>
                      <div className="memory-preference-summary">
                        <div>
                          <p className="memory-preference-category">{definition.label}</p>
                          <p className="memory-preference-content">{preference.content}</p>
                        </div>
                        {!editing && (
                          <div className="memory-preference-actions">
                            <button
                              disabled={!!busy || !!pendingAction}
                              onClick={() => beginEdit(preference)}
                              aria-label={`编辑偏好：${preference.content}`}
                            >
                              <Pencil size={13} aria-hidden="true" />
                              编辑
                            </button>
                            <button
                              disabled={!!busy || !!pendingAction}
                              onClick={() => requestAction(() => void forget(preference.id))}
                              aria-label={`删除偏好：${preference.content}`}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                              {busy?.id === preference.id && busy.kind === 'delete'
                                ? '删除中…'
                                : '删除'}
                            </button>
                          </div>
                        )}
                      </div>
                      <dl className="memory-preference-metadata">
                        <div>
                          <dt>来源会话</dt>
                          <dd>
                            {preference.source_chat ? (
                              <button
                                className="memory-preference-source"
                                disabled={!!busy || !!pendingAction}
                                onClick={() =>
                                  requestAction(() => onOpenChat(preference.source_chat!.id))
                                }
                              >
                                <MessageSquare size={12} aria-hidden="true" />
                                <span>{preference.source_chat.title || '未命名会话'}</span>
                              </button>
                            ) : (
                              <span className="memory-preference-unavailable">无法访问</span>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>更新时间</dt>
                          <dd>
                            <time dateTime={preference.updated_at}>
                              {updatedTime(preference.updated_at)}
                            </time>
                          </dd>
                        </div>
                      </dl>
                      {editing && (
                        <form
                          className="memory-preference-edit"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                          }}
                        >
                          <label htmlFor={`memory-preference-${preference.id}`}>
                            {definition.label}
                          </label>
                          <select
                            ref={editControl}
                            id={`memory-preference-${preference.id}`}
                            value={edit.value}
                            disabled={!!busy || !!pendingAction}
                            onChange={(event) => {
                              setEdit({ ...edit, value: event.target.value });
                              setActionError(null);
                            }}
                          >
                            {definition.options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <p className="memory-preference-edit-hint">
                            {definition.options.length === 1
                              ? '这类偏好当前仅支持此选项。你可以保留或删除这条偏好。'
                              : '点击“保存修改”后，后续回答将使用新偏好。'}
                          </p>
                          <div className="memory-preference-edit-actions">
                            <button
                              type="button"
                              disabled={!!busy || !!pendingAction}
                              onClick={() => {
                                setEdit(null);
                                setActionError(null);
                              }}
                            >
                              取消
                            </button>
                            <button
                              type="submit"
                              className="primary"
                              disabled={!!busy || !!pendingAction || !dirty}
                            >
                              {busy?.id === preference.id && busy.kind === 'save'
                                ? '保存中…'
                                : '保存修改'}
                            </button>
                          </div>
                        </form>
                      )}
                      {actionError?.id === preference.id && (
                        <div className="memory-preference-error" role="alert">
                          <p>{actionError.message}</p>
                          {actionError.conflict && (
                            <button onClick={() => requestAction(reload)}>重新加载最新偏好</button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="user-preferences-empty">
                <Brain size={26} aria-hidden="true" />
                <p>还没有保存记忆偏好</p>
                <span>在对话中说“记住：回答简短一点”即可保存。</span>
              </div>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
