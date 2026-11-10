import { useState } from 'react';
import { Check, Copy, Pencil } from 'lucide-react';
import { Dialog } from './WorkspaceUI';
import { api } from './api';
import './email-address.css';

export function EmailAddress({
  email,
  editable,
  workspace,
  path,
  version,
  onCompose,
  onSaved,
}: {
  email: string;
  editable: boolean;
  workspace: string;
  path: string;
  version: number;
  onCompose: () => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(email),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  function edit() {
    setValue(email);
    setError('');
    setEditing(true);
  }
  return (
    <span className="email-address">
      {email ? (
        <>
          <button
            className="email-address-link"
            onClick={onCompose}
            disabled={!editable}
            title={editable ? `写邮件给 ${email}` : email}
          >
            {email}
          </button>
          <span className="email-address-actions">
            <button
              title={copied ? '已复制' : '复制邮箱'}
              aria-label={`复制邮箱 ${email}`}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(email);
                  setCopied(true);
                  setError('');
                } catch {
                  setError('复制失败，请选择邮箱文字手动复制');
                }
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            {editable && (
              <button title="编辑邮箱" aria-label={`编辑邮箱 ${email}`} onClick={edit}>
                <Pencil size={13} />
              </button>
            )}
          </span>
          <span className="sr-only" role="status">
            {copied ? '邮箱已复制' : ''}
          </span>
        </>
      ) : editable ? (
        <button className="email-address-empty" onClick={edit}>
          添加邮箱
        </button>
      ) : (
        <span>未填写邮箱</span>
      )}
      {error && !editing && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      {editing && (
        <Dialog
          title="编辑邮箱"
          onClose={() => {
            if (!busy) setEditing(false);
          }}
          className="email-edit-dialog"
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api(path, {
                  workspace,
                  method: 'PATCH',
                  body: { version, email: value.trim() },
                });
                setEditing(false);
                setCopied(false);
                onSaved();
              } catch (e) {
                setError(e instanceof Error ? e.message : '保存失败');
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="dialog-fields">
              <label>
                邮箱地址
                <input
                  type="email"
                  value={value}
                  maxLength={254}
                  autoComplete="off"
                  onChange={(e) => setValue(e.target.value)}
                  disabled={busy}
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="form-footer">
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存邮箱
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </span>
  );
}
