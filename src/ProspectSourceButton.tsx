import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import { ProspectIntake } from './ProspectIntake';
import { prospectsChanged } from './prospect-events';
import { useProspectEditorState } from './useProspectEditorState';

export function useProspectsAvailable(workspace: string) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setAvailable(false);
    api<{ prospects?: boolean }>('/agent/capabilities', { workspace, signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setAvailable(value.prospects === true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [workspace]);
  return available;
}

/** Every source opens the same explicit AI recommendation and acceptance flow. */
export function ProspectSourceButton({
  workspace,
  customerId,
  sourceRecordIds,
  sourceKind,
  sourceId,
  disabled = false,
}: {
  workspace: string;
  customerId?: string | null;
  sourceRecordIds?: string[];
  sourceKind?: string;
  sourceId?: string;
  disabled?: boolean;
}) {
  const available = useProspectsAvailable(workspace);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [created, setCreated] = useState(false);
  const sourceKey = JSON.stringify([
    workspace,
    customerId,
    sourceId,
    sourceKind,
    sourceRecordIds || [],
  ]);
  useProspectEditorState(workspace, open && dirty, open && busy);
  useEffect(() => {
    setOpen(false);
    setDirty(false);
    setBusy(false);
    setLeaving(false);
    setCreated(false);
  }, [sourceKey]);
  const close = () => {
    if (busy) return;
    if (dirty) setLeaving(true);
    else setOpen(false);
  };
  if (!available) return null;
  return (
    <>
      <button
        type="button"
        disabled={disabled || !customerId}
        title={customerId ? 'AI先整理推荐，由你确认新建或关联' : '先确认客户归属，再识别本次咨询'}
        onClick={() => {
          setCreated(false);
          setOpen(true);
        }}
      >
        <Sparkles size={14} />
        录入潜在客户
      </button>
      {created && (
        <span className="muted" role="status">
          已录入，可在资料库“潜在客户”查看。
        </span>
      )}
      {open && customerId && (
        <Dialog title="AI整理咨询与跟进状态" onClose={close} className="prospect-intake-dialog">
          <ProspectIntake
            key={sourceKey}
            workspace={workspace}
            customerId={customerId}
            sourceRecordIds={sourceRecordIds}
            sourceKind={sourceKind}
            sourceId={sourceId}
            onDirty={setDirty}
            onBusy={setBusy}
            onCreated={() => {
              prospectsChanged(workspace);
              setDirty(false);
              setOpen(false);
              setCreated(true);
            }}
            onClose={close}
          />
        </Dialog>
      )}
      {leaving && (
        <Dialog title="本次推荐尚未录入" onClose={() => setLeaving(false)}>
          <p className="dialog-copy">本次候选尚未写入正式跟进状态。</p>
          <footer className="form-footer">
            <button onClick={() => setLeaving(false)}>继续整理</button>
            <button
              onClick={() => {
                setLeaving(false);
                setDirty(false);
                setOpen(false);
              }}
            >
              放弃本次编辑并关闭
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}
