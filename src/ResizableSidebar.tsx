import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

const DEFAULT_WIDTH = 232;
const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const MAIN_MIN_WIDTH = 640;
const DRAWER_BREAKPOINT = MIN_WIDTH + MAIN_MIN_WIDTH;
const clamp = (width: number, max = MAX_WIDTH) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(max, width)));

function readWidth(key: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    if (typeof value === 'number' && Number.isFinite(value)) return clamp(value);
  } catch {
    // A local layout preference must not prevent opening the workspace.
  }
  return DEFAULT_WIDTH;
}

export function ResizableSidebar({
  storageKey,
  mobileOpen,
  children,
}: {
  storageKey: string;
  mobileOpen: boolean;
  children: ReactNode;
}) {
  const key = `light-crm:sidebar-width:${storageKey}`;
  const [saved, setSaved] = useState(() => ({ key, width: readWidth(key) }));
  const [viewport, setViewport] = useState(window.innerWidth);
  const [draft, setDraft] = useState<number | null>(null);
  const drag = useRef<{
    pointer: number;
    startX: number;
    startWidth: number;
    width: number;
    handle: HTMLElement;
  } | null>(null);
  const maximum = clamp(viewport - MAIN_MIN_WIDTH);
  const preferred = saved.key === key ? saved.width : readWidth(key);
  const width = clamp(draft ?? preferred, maximum);

  function persist(value: number) {
    const next = clamp(value, maximum);
    setSaved({ key, width: next });
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Resizing also works when browser storage is unavailable.
    }
  }
  function finish(cancel = false) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (!cancel) persist(current.width);
    setDraft(null);
    document.body.classList.remove('sidebar-resizing');
    if (current.handle.hasPointerCapture(current.pointer))
      current.handle.releasePointerCapture(current.pointer);
  }
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    finish(true);
    setDraft(null);
    return () => {
      const current = drag.current;
      drag.current = null;
      document.body.classList.remove('sidebar-resizing');
      if (current?.handle.hasPointerCapture(current.pointer))
        current.handle.releasePointerCapture(current.pointer);
    };
  }, [key, viewport]);

  return (
    <aside
      id="workbench-sidebar"
      className={`sidebar ${mobileOpen ? 'nav-open' : ''} ${draft !== null ? 'is-resizing' : ''}`}
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      {children}
      <div
        className="sidebar-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="调整侧栏宽度"
        aria-orientation="vertical"
        aria-controls="workbench-sidebar"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maximum}
        aria-valuenow={width}
        aria-valuetext={`${width} 像素`}
        title="拖动调整侧栏宽度，双击恢复默认"
        onPointerDown={(event) => {
          if (event.button !== 0 || viewport < DRAWER_BREAKPOINT) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointer: event.pointerId,
            startX: event.clientX,
            startWidth: width,
            width,
            handle: event.currentTarget,
          };
          setDraft(width);
          document.body.classList.add('sidebar-resizing');
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointer !== event.pointerId) return;
          current.width = clamp(current.startWidth + event.clientX - current.startX, maximum);
          setDraft(current.width);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointer === event.pointerId) finish();
        }}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish(true)}
        onDoubleClick={() => persist(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drag.current) {
            event.preventDefault();
            finish(true);
            return;
          }
          const step = event.shiftKey ? 32 : 8;
          const next =
            event.key === 'ArrowLeft'
              ? width - step
              : event.key === 'ArrowRight'
                ? width + step
                : event.key === 'Home'
                  ? MIN_WIDTH
                  : event.key === 'End'
                    ? maximum
                    : event.key === 'Enter'
                      ? DEFAULT_WIDTH
                      : null;
          if (next !== null) {
            event.preventDefault();
            persist(next);
          }
        }}
      />
    </aside>
  );
}
