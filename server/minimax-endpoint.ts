/** Fixed server-side endpoints; the China alias never changes the account region. */
export function minimaxChatEndpoint(region: 'cn' | 'global'): string {
  if (region === 'global') return 'https://api.minimax.io/v1/chat/completions';
  const endpoint = process.env.MINIMAX_CN_ENDPOINT;
  if (endpoint === undefined || endpoint === 'official')
    return 'https://api.minimax.cn/v1/chat/completions';
  if (endpoint === 'compatible') return 'https://api.minimaxi.com/v1/chat/completions';
  throw new Error('MINIMAX_CN_ENDPOINT must be official or compatible');
}
