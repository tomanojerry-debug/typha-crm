import { useEffect, useId } from 'react';

/** Source dialogs and Home share the workbench's existing unsaved-navigation guard. */
export function useProspectEditorState(workspace: string, dirty: boolean, busy: boolean) {
  const token = useId();
  useEffect(() => {
    const publish = (nextDirty: boolean, nextBusy: boolean) =>
      window.dispatchEvent(
        new CustomEvent('crm:prospect-editor', {
          detail: { workspace, token, dirty: nextDirty, busy: nextBusy },
        }),
      );
    publish(dirty, busy);
    return () => {
      publish(false, false);
    };
  }, [workspace, token, dirty, busy]);
}
