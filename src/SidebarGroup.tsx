import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function SidebarGroup({
  id,
  label,
  navLabel = label,
  action,
  items,
  itemsId = `${id}-items`,
  itemsClassName = '',
  busy,
  hasMore = items.length > 5,
  revealKey,
  onExpandedChange,
  children,
}: {
  id: string;
  label: string;
  navLabel?: string;
  action?: ReactNode;
  items: ReactNode[];
  itemsId?: string;
  itemsClassName?: string;
  busy?: boolean;
  hasMore?: boolean;
  revealKey?: string;
  onExpandedChange?: (expanded: boolean) => void;
  children?: (expanded: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (revealKey) {
      setOpen(true);
      setExpanded(true);
    }
  }, [revealKey]);
  function showMore(next: boolean) {
    setExpanded(next);
    onExpandedChange?.(next);
  }
  return (
    <>
      <div className="nav-label label-with-action">
        <button
          className="sidebar-group-toggle"
          aria-label={label}
          aria-expanded={open}
          aria-controls={`${id}-content`}
          title={`${open ? '收起' : '展开'}${label}`}
          onClick={() => {
            setOpen(!open);
            showMore(false);
          }}
        >
          <ChevronDown size={11} aria-hidden="true" />
          <span>{label}</span>
        </button>
        {action}
      </div>
      <div id={`${id}-content`} className="sidebar-group-content" hidden={!open}>
        <nav id={id} aria-label={navLabel} className="saved-views">
          <div id={itemsId} className={`sidebar-group-items ${itemsClassName}`} aria-busy={busy}>
            {expanded ? items : items.slice(0, 5)}
            {children?.(expanded)}
          </div>
          {hasMore && (
            <button
              className="sidebar-group-more"
              aria-expanded={expanded}
              aria-controls={itemsId}
              onClick={() => showMore(!expanded)}
            >
              <span>{expanded ? '收起显示' : '展开显示'}</span>
            </button>
          )}
        </nav>
      </div>
    </>
  );
}
