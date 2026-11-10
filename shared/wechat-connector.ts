export interface WeChatConnectorState {
  state: 'paused' | 'unbound' | 'waiting' | 'scanned' | 'need_code' | 'expired' | 'bound';
  message: string;
  session_id?: string;
  qr_image?: string;
  expires_at?: string;
  bound_at?: string;
  account_verified: boolean;
}

export const wechatBotBindingPausedMessage =
  '机器人扫码绑定已停用。请使用本机微信读取器，无需产品扫码认证。';
