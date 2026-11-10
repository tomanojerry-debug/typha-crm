import { useEffect, useState } from 'react';
import { AlertCircle, FileText, Mail, MessageSquare, PencilLine, Workflow } from 'lucide-react';
import type { HomeOverview as Overview, HomeOverviewItem } from '../shared/home-overview';
import { api } from './api';
import './home-overview.css';

const icons = {
  mail: Mail,
  draft: PencilLine,
  outgoing_issue: AlertCircle,
  document: FileText,
  wechat: MessageSquare,
  workflow: Workflow,
};
const timeLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

export function HomeOverview({
  workspace,
  refresh,
  onItem,
}: {
  workspace: string;
  refresh: number;
  onItem: (item: HomeOverviewItem) => void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [loadedWorkspace, setLoadedWorkspace] = useState(workspace);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoadedWorkspace(workspace);
    setData(null);
    setError('');
    api<Overview>('/home/overview', { workspace, signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason.message || '工作概览加载失败');
      });
    return () => controller.abort();
  }, [workspace, refresh, retry]);
  if (loadedWorkspace !== workspace || (!error && !data?.items.length)) return null;
  return (
    <section className="home-work-overview" aria-labelledby="home-overview-heading">
      <header>
        <h2 id="home-overview-heading">工作概览</h2>
        {data && (
          <span>
            {data.total > data.items.length
              ? `显示前${data.items.length}项，共${data.total}项`
              : `${data.total}项`}
          </span>
        )}
      </header>
      {error ? (
        <div className="home-overview-error" role="alert">
          <span>{error}</span>
          <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : (
        <ul className="home-overview-list">
          {data!.items.map((item) => {
            const Icon = icons[item.kind];
            return (
              <li key={`${item.kind}:${item.id}`}>
                <Icon
                  size={17}
                  aria-hidden="true"
                  className={item.kind === 'outgoing_issue' ? 'home-overview-caution' : undefined}
                />
                <div className="home-overview-item-text">
                  <strong>{item.title || '无主题邮件'}</strong>
                  <p>
                    {item.subtitle}
                    <time dateTime={item.updated_at}>{timeLabel(item.updated_at)}</time>
                  </p>
                </div>
                <button className="secondary" onClick={() => onItem(item)}>
                  {item.action_label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
