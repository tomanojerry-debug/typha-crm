import { useEffect, useState } from 'react';
import { ArrowUpRight, Folder } from 'lucide-react';
import { api } from './api';
import type { Member } from '../shared/domain';
import type { ProjectList, ProjectRow } from '../shared/views';
import { homeProjectFilters } from '../shared/home-overview';
import './home-overview.css';

const dateLabel = (date: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));

export function HomeProjects({
  workspace,
  refresh,
  onOpen,
  onAll,
}: {
  workspace: string;
  refresh: number;
  members: Member[];
  onOpen: (project: ProjectRow) => void;
  onAll: () => void;
}) {
  const [projects, setProjects] = useState<ProjectList | null>(null);
  const [loadedWorkspace, setLoadedWorkspace] = useState(workspace);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoadedWorkspace(workspace);
    setProjects(null);
    setError('');
    const params = new URLSearchParams({
      sort: 'due_date',
      direction: 'asc',
      filters: JSON.stringify(homeProjectFilters()),
    });
    api<ProjectList>(`/projects?${params}`, { workspace, signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setProjects(result);
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason.message || '项目加载失败');
      });
    return () => controller.abort();
  }, [workspace, refresh, retry]);
  if (loadedWorkspace !== workspace || (!error && !projects?.items.length)) return null;
  return (
    <section className="home-recent-projects" aria-labelledby="home-projects-heading">
      <header>
        <h2 id="home-projects-heading">近期项目</h2>
        <button className="text-button" onClick={onAll}>
          全部项目 <ArrowUpRight size={12} />
        </button>
      </header>
      {error ? (
        <div className="home-overview-error" role="alert">
          <span>{error}</span>
          <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : (
        <ul className="home-recent-project-list">
          {projects!.items.slice(0, 3).map((project) => (
            <li key={project.id}>
              <button onClick={() => onOpen(project)} aria-label={`打开项目：${project.name}`}>
                <Folder size={15} aria-hidden="true" />
                <span className="home-recent-project-name">
                  <strong>{project.name}</strong>
                  <small>{project.customer_name}</small>
                </span>
                <time dateTime={project.due_date!}>目标日期 {dateLabel(project.due_date!)}</time>
                <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
