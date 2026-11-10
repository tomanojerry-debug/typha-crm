import { useEffect, useRef, useState } from 'react';
import type { OutgoingMail } from '../shared/outgoing';
import { api } from './api';
import {
  createWorkflowMailMonitor,
  workflowMailScopeKey,
  type WorkflowMailReadState,
  type WorkflowMailScope,
} from './workflow-mail-status';

export function useWorkflowMailStatus(scope: WorkflowMailScope | null, revision: string) {
  const key = scope ? workflowMailScopeKey(scope) : '';
  const [result, setResult] = useState<{ key: string; state: WorkflowMailReadState } | null>(null);
  const monitor = useRef<ReturnType<typeof createWorkflowMailMonitor> | null>(null);
  useEffect(() => {
    if (!scope) {
      monitor.current = null;
      setResult(null);
      return;
    }
    const current = createWorkflowMailMonitor({
      scope,
      read: (currentScope, signal) =>
        api<OutgoingMail>(`/outgoing/${currentScope.draftId}`, {
          workspace: currentScope.workspace,
          signal,
        }),
      onState: (state) => setResult({ key, state }),
    });
    monitor.current = current;
    setResult({ key, state: { phase: 'loading', mail: null, error: '' } });
    void current.refresh();
    const visibility = () => current.setVisible(document.visibilityState !== 'hidden');
    const focus = () => {
      if (document.visibilityState !== 'hidden') void current.refresh();
    };
    current.setVisible(document.visibilityState !== 'hidden');
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      current.dispose();
      if (monitor.current === current) monitor.current = null;
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [key]);
  useEffect(() => {
    void monitor.current?.refresh();
  }, [key, revision]);
  // Hide the previous scope synchronously, before effect cleanup can run.
  const state: WorkflowMailReadState | undefined = !scope
    ? undefined
    : result?.key === key
      ? result.state
      : { phase: 'loading', mail: null, error: '' };
  return { state, refresh: () => void monitor.current?.refresh() };
}
