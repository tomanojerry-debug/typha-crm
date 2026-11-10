import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from './api';
import type { KnowledgeView } from '../shared/knowledge';
import type { Selection } from './Workbench';
import { RecordEvidence } from './RecordEvidence';

const states: Record<KnowledgeView['state'], string> = {
  not_synced: '尚未同步',
  pending: '等待同步',
  syncing: '正在整理',
  ready: '已同步',
  failed: '同步失败',
  disabled: '尚未启用',
};
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function KnowledgeChanges({
  workspace,
  customerId,
  projectId,
  personId,
}: {
  workspace: string;
  customerId: string;
  projectId?: string;
  personId?: string;
  onSelect?: (s: Selection) => void;
}) {
  const [data, setData] = useState<KnowledgeView | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState(false),
    [refresh, setRefresh] = useState(0),
    [record, setRecord] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setData(null);
    setError('');
    const load = async () => {
      try {
        const params = new URLSearchParams({
          ...(projectId ? { project_id: projectId } : {}),
          ...(personId ? { person_id: personId } : {}),
        });
        const result = await api<KnowledgeView>(`/customers/${customerId}/knowledge?${params}`, {
          workspace,
          signal: controller.signal,
        });
        if (disposed) return;
        setData(result);
        if (['pending', 'syncing'].includes(result.state))
          timer = setTimeout(() => void load(), 5000);
      } catch (e) {
        if (!disposed) {
          setData(null);
          setError(e instanceof Error ? e.message : '读取失败');
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspace, customerId, projectId, personId, refresh]);
  async function sync() {
    setBusy(true);
    setError('');
    try {
      await api(`/customers/${customerId}/knowledge/sync`, { workspace, method: 'POST', body: {} });
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '同步请求失败');
    } finally {
      setBusy(false);
    }
  }
  const facts = expanded ? data?.facts : data?.facts.slice(0, 8);
  return (
    <section className="knowledge-changes" aria-label="沟通变化追踪">
      <header>
        <div>
          <strong>沟通变化</strong>
          <span>{data ? states[data.state] : '正在读取'}</span>
        </div>
        <div>
          <button aria-label="刷新沟通变化" onClick={() => setRefresh((v) => v + 1)}>
            <RefreshCw size={13} />
          </button>
          {data?.can_sync && (
            <button disabled={busy || data.state === 'syncing'} onClick={() => void sync()}>
              {busy ? '已提交…' : data.state === 'failed' ? '重试' : '同步'}
            </button>
          )}
        </div>
      </header>
      <p className="muted">保留时间和来源。以下是模型提取的候选信息，档案字段需另行核对更新。</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data?.error && (
        <p role="status" className="error">
          {data.error}
        </p>
      )}
      {data?.state === 'disabled' && <p className="muted">文字知识运行器尚未启用。</p>}
      {data?.state === 'ready' && !data.facts.length && (
        <p className="muted">当前范围尚无可提取的沟通事实。</p>
      )}
      {facts?.map((f) => (
        <article key={f.id}>
          <div className="knowledge-fact-meta">
            <span>{f.invalid_at ? '历史信息' : '当前候选'}</span>
            <span>
              {f.trust === 'company_confirmed'
                ? '来自公司确认记录'
                : f.trust === 'inference'
                  ? '来自内部推断'
                  : '来自沟通原话'}
            </span>
          </div>
          <p>{f.fact}</p>
          <small>
            {f.valid_at ? `生效：${date(f.valid_at)}` : '生效时间待核对'}
            {f.invalid_at && ` · 截止：${date(f.invalid_at)}`}
          </small>
          <div className="knowledge-sources">
            {f.sources.map((s) => (
              <button key={s.id} onClick={() => setRecord(s.record_id)}>
                {s.channel === 'email' ? '邮件' : s.channel === 'wechat' ? '微信' : '记录'} ·{' '}
                {s.speaker} · {s.title} · {date(s.occurred_at)}
              </button>
            ))}
          </div>
          {f.sources
            .filter((s) => s.excerpt)
            .map((s) => (
              <details key={s.id}>
                <summary>查看已分享的微信依据 · {s.speaker}</summary>
                <blockquote>{s.excerpt}</blockquote>
              </details>
            ))}
        </article>
      ))}
      {!!data && data.facts.length > 8 && (
        <button onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `查看全部 ${data.facts.length} 条`}
        </button>
      )}
      {data?.synced_at && <small className="muted">上次完成：{date(data.synced_at)}</small>}
      {record && (
        <RecordEvidence
          recordId={record}
          customerId={customerId}
          workspace={workspace}
          onClose={() => setRecord(null)}
        />
      )}
    </section>
  );
}
