import type { HTMLAttributes } from 'react';
import './kanban.css';

export function KanbanBoard({
  children,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div aria-label="记录卡片" {...props} className={`kanban-board ${className}`}>
      {children}
    </div>
  );
}

export function KanbanCard({ children, className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <article {...props} className={`kanban-card ${className}`}>
      {children}
    </article>
  );
}
