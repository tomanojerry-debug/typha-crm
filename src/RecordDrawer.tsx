import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Expand, X } from 'lucide-react';

/** Shared record preview, full-page layout and keyboard/focus behavior. */
export function RecordDrawer({
  full = false,
  title,
  ariaLabel = title,
  expandLabel = '展开完整档案',
  children,
  onClose,
  onExpand,
  previous,
  next,
  askButton,
  askPanel,
  busy = false,
  className = '',
}: {
  full?: boolean;
  title: string;
  ariaLabel?: string;
  expandLabel?: string;
  children: ReactNode;
  onClose: () => void;
  onExpand?: () => void;
  previous?: () => void;
  next?: () => void;
  askButton?: ReactNode;
  askPanel?: ReactNode;
  busy?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = ref.current!;
    const returnFocus = document.activeElement as HTMLElement | null;
    const media = window.matchMedia('(max-width: 1100px)');
    const open = () => {
      element.close();
      if (media.matches && !full) element.showModal();
      else element.show();
    };
    open();
    media.addEventListener('change', open);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.modal[open]')) {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      media.removeEventListener('change', open);
      document.removeEventListener('keydown', escape);
      element.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [full]);
  return (
    <dialog
      ref={ref}
      className={`detail-drawer ${full ? 'full-drawer' : ''} ${className}`}
      aria-label={ariaLabel}
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <header className="drawer-toolbar">
        <button
          className={full ? 'back-to-view' : 'icon-button'}
          disabled={busy}
          onClick={onClose}
          aria-label="返回原视图"
        >
          {full ? (
            <>
              <ArrowLeft size={15} />
              返回原视图
            </>
          ) : (
            <X size={18} />
          )}
        </button>
        <span>{title}</span>
        <div className="drawer-pagination">
          <button
            className="icon-button"
            disabled={busy || !previous}
            onClick={previous}
            aria-label="上一条记录"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            disabled={busy || !next}
            onClick={next}
            aria-label="下一条记录"
          >
            <ChevronRight size={16} />
          </button>
          {!full && onExpand && (
            <button
              className="icon-button"
              disabled={busy}
              onClick={onExpand}
              aria-label={expandLabel}
              title="展开完整档案"
            >
              <Expand size={15} />
            </button>
          )}
          {askButton}
        </div>
      </header>
      <div className="drawer-body">
        <div className="drawer-scroll">{children}</div>
        {askPanel}
      </div>
    </dialog>
  );
}
