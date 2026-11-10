import type { Context } from './security.js';

export async function connectorBinding(ctx: Context) {
  return (
    await ctx.tx.query<{ bound_at: string; verified_account_key: string | null }>(
      'SELECT bound_at,verified_account_key FROM wechat_connectors WHERE workspace_id=$1 AND actor_id=$2',
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows[0];
}
