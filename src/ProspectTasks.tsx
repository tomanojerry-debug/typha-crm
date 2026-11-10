import { useCallback, useEffect, useState } from 'react';
import type { ProspectTaskListResponse } from '../shared/prospects';
import { prospectRequirementStatuses, prospectWaitingOn } from '../shared/prospects';
import { api } from './api';
import { useProspectsAvailable } from './ProspectSourceButton';
import { openProspect, prospectChangedEvent } from './prospect-events';

export function ProspectTasks({ workspace, status }: { workspace: string; status: string }) {
  const available = useProspectsAvailable(workspace);
  const [data, setData] = useState<ProspectTaskListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    setPage(1);
  }, [workspace, status]);
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<{ workspace: string }>).detail.workspace === workspace) refresh();
    };
    window.addEventListener(prospectChangedEvent, listener);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(prospectChangedEvent, listener);
      window.removeEventListener('focus', refresh);
    };
  }, [workspace, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    if (!available) return () => controller.abort();
    const query = new URLSearchParams({ page: String(page), page_size: '20' });
    if (status) query.set('status', status);
    api<ProspectTaskListResponse>(`/prospects/tasks?${query}`, {
      workspace,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败');
      });
    return () => controller.abort();
  }, [workspace, available, status, page, revision]);
  if (!available) return null;
  return (
    <section className="prospect-task-section" aria-label="客户跟进状态">
      <div className="ba-toolbar">
        <h2>客户跟进状态</h2>
        <button className="text-button" onClick={refresh}>
          刷新状态
        </button>
      </div>
      <p className="ba-muted ba-small">
        来自潜在客户的同一份状态，显示指派给你的未满足条件和待做事项。
      </p>
      {error ? (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p role="status">正在读取客户状态…</p>
      ) : (
        <>
          {!data.items.length && <p className="ba-empty">当前没有符合条件的客户跟进状态。</p>}
          {data.items.map((state) => (
            <article className="ba-task-card" key={`${state.prospect_id}:${state.id}`}>
              <div className="ba-toolbar">
                <h3>{state.title}</h3>
                <span className="ba-tag">{prospectRequirementStatuses[state.status]}</span>
              </div>
              <p className="ba-muted ba-small">
                {state.customer_name} · {state.prospect_name}
              </p>
              <p className="ba-muted ba-small">
                {state.waiting_on
                  ? `当前等待${prospectWaitingOn[state.waiting_on]}`
                  : '尚未明确等待方'}
                {state.due_date ? ` · 跟进日期 ${state.due_date}` : ' · 日期待安排'}
              </p>
              {state.result && (
                <div className="ba-task-result">
                  <strong>处理结果</strong>
                  <p>{state.result}</p>
                </div>
              )}
              <button
                className="text-button"
                onClick={() => openProspect(workspace, state.prospect_id)}
              >
                查看当前状态并处理 →
              </button>
            </article>
          ))}
          {data.total > data.page_size && (
            <div className="ba-toolbar">
              <button disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
                上一页
              </button>
              <span>
                第 {page} 页 · 共 {data.total} 项
              </span>
              <button
                disabled={page * data.page_size >= data.total}
                onClick={() => setPage((n) => n + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
