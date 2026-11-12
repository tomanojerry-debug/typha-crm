import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AssignedActivityTask, ActivityTaskStatus } from '../shared/business-activities';
import { api, HttpError } from './api';
import { WorkspacePageHeader } from './WorkspacePage';
import { ProspectTasks } from './ProspectTasks';
import {
  ActivityDetailDialog,
  ActivityTaskActions,
  CollaborationTaskAttachment,
  activityTime,
  taskLabels,
  useActivitiesChanged,
} from './BusinessActivities';
import './business-activities.css';

export function TeamTasks({
  workspace,
  askButton,
  taskOnly = false,
  onUnauthorized,
}: {
  workspace: string;
  askButton?: ReactNode;
  taskOnly?: boolean;
  onUnauthorized?: () => void;
}) {
  const [items, setItems] = useState<AssignedActivityTask[]>([]);
  const [status, setStatus] = useState<ActivityTaskStatus | ''>('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  useActivitiesChanged(workspace, refresh);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 15_000);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const c = new AbortController();
    setBusy(true);
    setError('');
    api<AssignedActivityTask[]>(`/tasks${status ? `?status=${status}` : ''}`, {
      workspace,
      signal: c.signal,
    })
      .then((rows) => {
        if (c.signal.aborted) return;
        setItems(taskOnly ? rows.filter((task) => task.task_only) : rows);
        setBusy(false);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setItems([]);
          setSelected(null);
          if (e instanceof HttpError && [401, 403, 404].includes(e.status))
            unauthorized.current?.();
          setError(e.message);
          setBusy(false);
        }
      });
    return () => c.abort();
  }, [workspace, status, revision, taskOnly]);
  return (
    <section className="ba-tasks-page workspace-page">
      <WorkspacePageHeader
        title={taskOnly ? '协作待办' : '待办'}
        description={
          taskOnly
            ? '查看交接要求，提交处理结果和所需文件。'
            : '需要你处理的客户咨询状态与同事交办事项，保留背景与处理结果。'
        }
        actions={askButton}
      />
      <div className="ba-toolbar">
        <label className="ba-task-filter">
          状态
          <select
            value={status}
            onChange={(e) => {
              setItems([]);
              setStatus(e.target.value as ActivityTaskStatus | '');
            }}
          >
            <option value="">全部</option>
            <option value="open">待处理</option>
            <option value="in_progress">处理中</option>
            <option value="completed">已完成</option>
          </select>
        </label>
        <button className="icon-button" aria-label="刷新待办" disabled={busy} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      {!taskOnly && (
        <>
          <ProspectTasks workspace={workspace} status={status} />
          <h2>活动待办</h2>
        </>
      )}
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
      {busy && !items.length && (
        <p className="ba-empty" role="status">
          正在读取待办…
        </p>
      )}
      {!busy && !items.length && !error && <p className="ba-empty">当前没有符合条件的待办。</p>}
      {items.map((task) => (
        <article className="ba-task-card" key={task.id}>
          <div className="ba-toolbar">
            <h3>{task.title}</h3>
            <span className="ba-tag">{taskLabels[task.status]}</span>
          </div>
          <p className="ba-muted ba-small">
            创建于 {activityTime(task.created_at)}
            {task.due_date ? ` · 截止 ${task.due_date}` : ' · 未设截止日期'}
          </p>
          {task.task_only ? (
            <div className="ba-task-result">
              <strong>交接要求</strong>
              <p>{task.collaboration_brief}</p>
              {task.attachment_required && <small>完成时须提交文件</small>}
            </div>
          ) : 'activity_id' in task ? (
            <button className="text-button" onClick={() => setSelected(task.activity_id)}>
              查看原活动、客户背景与原文 →
            </button>
          ) : null}
          {task.result && (
            <div className="ba-task-result">
              <strong>处理结果</strong>
              <p>{task.result}</p>
            </div>
          )}
          {task.task_only && task.attachment && (
            <CollaborationTaskAttachment
              workspace={workspace}
              task={task}
              onUnavailable={refresh}
            />
          )}
          <ActivityTaskActions workspace={workspace} task={task} onChanged={refresh} />
        </article>
      ))}
      {selected && (
        <ActivityDetailDialog
          workspace={workspace}
          activityId={selected}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </section>
  );
}
