import { useEffect, useRef, type ReactNode } from 'react';
import { X, ChevronDown, Bookmark, Save, Copy } from 'lucide-react';
export function Dialog({
  title,
  children,
  onClose,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    el.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      el.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭弹窗">
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Popover({
  label,
  icon,
  children,
  className = '',
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) ref.current?.removeAttribute('open');
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  return (
    <details ref={ref} className={`popover ${className}`}>
      <summary>
        {icon}
        {label}
        <ChevronDown size={12} />
      </summary>
      <div className="popover-panel">{children}</div>
    </details>
  );
}
export function closeMenus() {
  document.querySelectorAll<HTMLDetailsElement>('.popover[open]').forEach((el) => {
    el.open = false;
  });
}

export function ViewSaveMenu({
  canUpdate,
  busy,
  onSave,
  onSaveAs,
}: {
  canUpdate: boolean;
  busy: boolean;
  onSave: () => void;
  onSaveAs: () => void;
}) {
  return (
    <Popover
      label={busy ? '保存中…' : '保存视图'}
      icon={<Bookmark size={13} />}
      className="view-save"
    >
      <button
        className="menu-item"
        disabled={busy || !canUpdate}
        onClick={() => {
          closeMenus();
          onSave();
        }}
      >
        <Save size={14} />
        保存当前视图
      </button>
      <button
        className="menu-item"
        disabled={busy}
        onClick={() => {
          closeMenus();
          onSaveAs();
        }}
      >
        <Copy size={14} />
        另存为新视图
      </button>
      {!canUpdate && <p className="view-save-hint">默认视图请另存为新视图。</p>}
    </Popover>
  );
}
