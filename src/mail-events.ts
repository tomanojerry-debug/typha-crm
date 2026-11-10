import { useEffect, useState } from 'react';
import { api } from './api';
export const mailChanged = () => window.dispatchEvent(new Event('crm-mail-changed'));
export function useMailTrackingSummary(workspace: string) {
  const [summary, setSummary] = useState<{ unread: number; pending: number } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true,
      controller: AbortController | undefined;
    async function load() {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await api<{ unread: number; pending: number }>('/mail/tracking/summary', {
          workspace,
          signal: controller.signal,
        });
        if (active) {
          setSummary(next);
          setRevision((x) => x + 1);
        }
      } catch (e) {
        if (active && (e as Error).name !== 'AbortError') setSummary(null);
      }
    }
    setSummary(null);
    void load();
    const timer = window.setInterval(load, 30000);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', load);
    window.addEventListener('crm-mail-changed', load);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', load);
      window.removeEventListener('crm-mail-changed', load);
    };
  }, [workspace]);
  return { summary, revision };
}
