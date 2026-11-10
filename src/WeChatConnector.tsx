import { Monitor, RefreshCw } from 'lucide-react';
import type { WeChatStatus } from '../shared/wechat';

export function WeChatConnector({
  status,
  checking,
  admin,
  nativeName,
  onCheck,
  onOpen,
}: {
  status: WeChatStatus | null;
  checking: boolean;
  admin: boolean;
  nativeName: string;
  onCheck(): void;
  onOpen(): void;
}) {
  return (
    <div className="wechat-connect-card">
      <div className="wechat-qr-entry">
        <Monitor size={42} strokeWidth={1.35} />
      </div>
      <h2>连接本机微信</h2>
      <p>{status?.message || '正在检查本机微信与读取器…'}</p>
      <button className="wechat-green-button" onClick={onCheck} disabled={checking || !admin}>
        <RefreshCw size={14} className={checking ? 'wechat-spin' : ''} />
        {checking ? '正在检查…' : '检查本机连接'}
      </button>
      <button className="wechat-quiet-button" onClick={onOpen} disabled={checking || !admin}>
        打开{nativeName}
      </button>
      <small>通过本机读取器查询，指定联系人和日期后才读取聊天。</small>
    </div>
  );
}
