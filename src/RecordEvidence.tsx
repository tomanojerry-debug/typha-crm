import { useEffect, useState } from 'react';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import { MailDialog } from './Mail';
import type { CustomerRecord } from '../shared/domain';
import type { KnowledgeSource, KnowledgeView } from '../shared/knowledge';

export function RecordEvidence({
  workspace,
  customerId,
  recordId,
  onClose,
}: {
  workspace: string;
  customerId: string;
  recordId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
      record: CustomerRecord;
      sources: KnowledgeSource[];
      graph_state: KnowledgeView['state'];
      extractions?: {
        entities: { name: string; kind: string }[];
        uncertainties: { description: string }[];
      }[];
      facts: KnowledgeView['facts'];
    } | null>(null),
    [error, setError] = useState(''),
    [mail, setMail] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    api<NonNullable<typeof data>>(`/customers/${customerId}/records/${recordId}/evidence`, {
      workspace,
      signal: c.signal,
    })
      .then(setData)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [workspace, customerId, recordId]);
  return (
    <Dialog title="记录与依据" onClose={onClose}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p>正在读取记录…</p>}
      {data && (
        <div className="knowledge-changes">
          <p style={{ whiteSpace: 'pre-wrap' }}>{data.record.body}</p>
          {data.sources.map((s) => (
            <article key={s.id}>
              <strong>{s.speaker}</strong>
              <small>
                {' '}
                · {new Date(s.occurred_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              </small>
              <p>{s.body}</p>
              {s.ref.kind === 'mail' && (
                <button onClick={() => setMail(s.ref.id)}>打开原始邮件</button>
              )}
            </article>
          ))}
          <h4>这条记录提取出的信息</h4>
          <p className="muted">以下候选来自同一条记录，不代表新增独立证据或公司确认。</p>
          {data.graph_state !== 'ready' && (
            <p className="muted">图知识尚未同步到当前版本，原始记录仍可核对。</p>
          )}
          {data.extractions?.map((extraction, index) => (
            <section key={index}>
              <p>识别对象：{extraction.entities.map((e) => e.name).join('、') || '暂无明确对象'}</p>
              {extraction.uncertainties.length > 0 && (
                <>
                  <strong>仍需核对</strong>
                  <ul>
                    {extraction.uncertainties.map((item, i) => (
                      <li key={i}>{item.description}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          ))}
          {data.facts.map((f) => (
            <article key={f.id}>
              <small>{f.invalid_at ? '历史信息' : '当前候选'}</small>
              <p>{f.fact}</p>
              {f.invalid_at && (
                <small>
                  截止：
                  {new Date(f.invalid_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </small>
              )}
            </article>
          ))}
        </div>
      )}
      {mail && <MailDialog id={mail} workspace={workspace} onClose={() => setMail(null)} />}
    </Dialog>
  );
}
