import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ActivityTask, ActivityTaskStatus } from '../shared/business-activities';
import { api } from './api';
import { WorkspacePageHeader } from './WorkspacePage';
import { ProspectTasks } from './ProspectTasks';
import {
  ActivityDetailDialog,
  ActivityTaskActions,
  activityTime,
  taskLabels,
  useActivitiesChanged,
} from './BusinessActivities';
import './business-activities.css';

export function TeamTasks({ workspace, askButton }: { workspace: string; askButton?: ReactNode }) {
  const [items, setItems] = useState<ActivityTask[]>([]);
  const [status, setStatus] = useState<ActivityTaskStatus | ''>('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useActivitiesChanged(workspace, refresh);
  useEffect(() => {
    const c = new AbortController();
    setBusy(true);
    setError('');
    setItems([]);
    api<ActivityTask[]>(`/tasks${status ? `?status=${status}` : ''}`, {
      workspace,
      signal: c.signal,
    })
      .then((rows) => {
        setItems(rows);
        setBusy(false);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setError(e.message);
          setBusy(false);
        }
      });
    return () => c.abort();
  }, [workspace, status, revision]);
  return (
    <section className="ba-tasks-page workspace-page">
      <WorkspacePageHeader
        title="待办"
        description="需要你处理的客户咨询状态与同事交办事项，保留背景与处理结果。"
        actions={askButton}
      />
      <div className="ba-toolbar">
        <label className="ba-task-filter">
          状态
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ActivityTaskStatus | '')}
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
      <ProspectTasks workspace={workspace} status={status} />
      <h2>活动待办</h2>
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
      {busy && (
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
          <button className="text-button" onClick={() => setSelected(task.activity_id)}>
            查看原活动、客户背景与原文 →
          </button>
          {task.result && (
            <div className="ba-task-result">
              <strong>处理结果</strong>
              <p>{task.result}</p>
            </div>
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
