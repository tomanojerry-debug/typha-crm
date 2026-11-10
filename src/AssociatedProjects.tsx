import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Folder, RefreshCw } from 'lucide-react';
import { api } from './api';
import { projectStages } from '../shared/domain';
import type { AssociatedProjectsPage } from '../shared/connections';
import type { Selection } from './Workbench';
import './associated-projects.css';

export function AssociatedProjects(props: {
  workspace: string;
  object: 'customers' | 'people';
  id: string;
  refresh: number;
  onSelect: (selection: Selection) => void;
  onManage?: () => void;
}) {
  return <ProjectLinks key={`${props.workspace}:${props.object}:${props.id}`} {...props} />;
}

function ProjectLinks({
  workspace,
  object,
  id,
  refresh,
  onSelect,
  onManage,
}: Parameters<typeof AssociatedProjects>[0]) {
  const [data, setData] = useState<AssociatedProjectsPage | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    api<AssociatedProjectsPage>(`/relationships/records/${object}/${id}/projects?page=${page}`, {
      workspace,
      signal: controller.signal,
    })
      .then((result) => {
        const last = Math.max(1, Math.ceil(result.total / result.page_size));
        if (page > last) setPage(last);
        else setData(result);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [workspace, object, id, refresh, page, retry]);
  return (
    <details className="associated-projects" open aria-label="相关项目">
      <summary>
        <ChevronDown size={13} />
        <strong>相关项目</strong>
        {data && <span className="associated-project-count">{data.total}</span>}
      </summary>
      {error ? (
        <div className="associated-project-error" role="alert">
          <p>{error}</p>
          <button onClick={() => setRetry((n) => n + 1)}>
            <RefreshCw size={12} />
            重试
          </button>
        </div>
      ) : !data ? (
        <p className="associated-project-empty" role="status">
          正在加载项目…
        </p>
      ) : data.total === 0 ? (
        <p className="associated-project-empty">暂无相关项目</p>
      ) : (
        <div className="associated-project-list">
          {data.items.map((project) => (
            <button
              key={project.id}
              className="associated-project-link"
              onClick={() =>
                onSelect({ customerId: project.customer_id, projectId: project.id, full: true })
              }
            >
              <Folder size={14} />
              <span>
                <strong>{project.name}</strong>
                <small>
                  {project.archived_at ? '已归档' : projectStages[project.stage]}
                  {object === 'people' && (
                    <span>
                      {' '}
                      ·{' '}
                      {project.via_relationship
                        ? project.via_email
                          ? '项目与邮件关联'
                          : '项目关联'
                        : '邮件关联'}
                    </span>
                  )}
                </small>
              </span>
              <ChevronRight size={12} />
            </button>
          ))}
        </div>
      )}
      {data && data.total > data.page_size && (
        <div className="associated-project-pagination">
          <span>
            {page} / {Math.ceil(data.total / data.page_size)}
          </span>
          <button
            className="icon-button"
            aria-label="相关项目上一页"
            disabled={page === 1}
            onClick={() => setPage((n) => n - 1)}
          >
            <ChevronLeft size={13} />
          </button>
          <button
            className="icon-button"
            aria-label="相关项目下一页"
            disabled={page * data.page_size >= data.total}
            onClick={() => setPage((n) => n + 1)}
          >
            <ChevronRight size={13} />
          </button>
        </div>
      )}
      {onManage && (
        <button className="associated-project-manage" onClick={onManage}>
          {object === 'customers' ? '查看公司项目' : '管理项目关联'}
          <ChevronRight size={12} />
        </button>
      )}
    </details>
  );
}
