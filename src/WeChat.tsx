import { useState } from 'react';
import { api } from './api';
import type { WeChatRequest, WeChatQueryResult } from '../shared/wechat';
import './wechat.css';
export { WeChatReviewDialog } from './WeChatReview';
export { WeChatWorkspace } from './WeChatConversations';
export function WeChatQueryForm({
  workspace,
  initial,
  initialCandidates,
  chatId,
  workflowVersion,
  canRead = true,
  onResult,
}: {
  workspace: string;
  initial?: Partial<WeChatRequest>;
  initialCandidates?: WeChatQueryResult['candidates'];
  chatId?: string;
  workflowVersion?: number;
  canRead?: boolean;
  onResult: (r: WeChatQueryResult) => void;
}) {
  const [identity, setIdentity] = useState(initial?.identity || ''),
    [start, setStart] = useState(initial?.start || ''),
    [end, setEnd] = useState(initial?.end || ''),
    [candidates, setCandidates] = useState<WeChatQueryResult['candidates']>(initialCandidates),
    [talker, setTalker] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function read() {
    setBusy(true);
    setError('');
    try {
      const result = await api<WeChatQueryResult>(
        chatId
          ? `/chats/${chatId}/${workflowVersion ? 'workflow/wechat' : 'wechat'}`
          : '/wechat/queries',
        {
          workspace,
          method: 'POST',
          body: {
            request_id: crypto.randomUUID(),
            identity,
            start,
            end,
            ...(workflowVersion ? { version: workflowVersion } : {}),
            ...(talker ? { talker } : {}),
          },
        },
      );
      if (result.candidates) setCandidates(result.candidates);
      else {
        setCandidates(undefined);
        onResult(result);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="connection-form wechat-query-form"
      onSubmit={(e) => {
        e.preventDefault();
        void read();
      }}
    >
      <label>
        微信号、微信昵称或备注
        <input
          value={identity}
          onChange={(e) => {
            setIdentity(e.target.value);
            setCandidates(undefined);
            setTalker('');
          }}
          required
          maxLength={120}
          placeholder="例如：林老师"
          disabled={busy}
        />
      </label>
      <div className="wechat-field-pair">
        <label>
          开始日期
          <input
            type="date"
            required
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setCandidates(undefined);
              setTalker('');
            }}
            disabled={busy}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            required
            value={end}
            min={start}
            onChange={(e) => {
              setEnd(e.target.value);
              setCandidates(undefined);
              setTalker('');
            }}
            disabled={busy}
          />
        </label>
      </div>
      <small className="wechat-note">
        按北京时间读取，单次最多 31 天。只查询指定联系人和日期，不自动扫描或跟踪其他会话。
      </small>
      {candidates && (
        <fieldset className="wechat-candidates">
          <legend>匹配到多人，请选择具体微信身份</legend>
          {candidates.map((c) => (
            <label key={c.id}>
              <input
                type="radio"
                name="wechat-candidate"
                value={c.id}
                checked={talker === c.id}
                onChange={() => setTalker(c.id)}
              />
              <span>
                {c.remark || c.name}
                <small>{c.wechat_id || c.id}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={!canRead || busy || (!!candidates && !talker)}>
        {busy ? '正在读取指定对话…' : '读取并整理'}
      </button>
      {!canRead && <small className="wechat-note">完成本机连接检查后，才能读取指定对话。</small>}
    </form>
  );
}
