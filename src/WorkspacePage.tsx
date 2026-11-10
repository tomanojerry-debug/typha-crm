import { Children, Fragment, cloneElement, isValidElement, type ReactNode } from 'react';

function tabStops(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (
      !isValidElement<{ children?: ReactNode; tabIndex?: number; 'aria-selected'?: boolean }>(child)
    )
      return child;
    if (child.type === Fragment) return cloneElement(child, {}, tabStops(child.props.children));
    return 'aria-selected' in child.props
      ? cloneElement(child, { tabIndex: child.props['aria-selected'] ? 0 : -1 })
      : child;
  });
}

/** Shared chrome for the seven workspaces in the main navigation. */
export function WorkspacePageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="workspace-page-header">
      <div className="workspace-page-copy">
        <div className="workspace-page-title-row">
          <h1>{title}</h1>
          {meta && <div className="workspace-page-meta">{meta}</div>}
        </div>
        {description && <p className="workspace-page-description">{description}</p>}
      </div>
      {actions && <div className="workspace-page-actions">{actions}</div>}
    </header>
  );
}

export function WorkspacePageTabs({
  children,
  label,
  className = '',
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={`workspace-page-tabs ${className}`}
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
        );
        const current = tabs.indexOf(event.target as HTMLButtonElement);
        if (current < 0 || !tabs.length) return;
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault();
        tabs[next].focus();
        tabs[next].click();
      }}
    >
      {tabStops(children)}
    </div>
  );
}
