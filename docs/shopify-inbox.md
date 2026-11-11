# 导入 Shopify Inbox 顾客消息

Shopify Inbox 是独立站页面上的客服聊天。Typha 接收工作人员已核对的顾客文字消息，将原话归档到明确选择的客户下。聊天里显示的姓名和邮箱可以随原话保存；访客没有提供时可以省略，Typha 不用这些字段自动匹配或创建联系人。[Shopify Inbox 会话说明](https://help.shopify.com/en/manual/inbox/conversations)

当前入口供已登录的工作台或授权导入工具使用，每次提交一条顾客消息。工作人员先从 Inbox 取得原话，再确认归属的 CRM 客户和可选项目。导入完成后可在客户档案的「记录」中回看，也可在 Ask Typha 中查看记录；配置模型后可结合原话提问。归档不自动创建活动、待办或回复。

## 接口

`POST /api/customers/:customerId/shopify/messages`

沿用工作台登录会话、`X-Workspace-Id` 和同源请求规则。调用者须有目标客户的编辑权限；如果指定项目，项目须属于该客户且未归档。以下请求体为虚构示例：

```json
{
  "shop_domain": "example-store.myshopify.com",
  "conversation_id": "inbox-thread-42",
  "message_id": "inbox-message-105",
  "occurred_at": "2026-11-10T15:30:00+08:00",
  "sender_name": "示例访客",
  "sender_email": "visitor@example.invalid",
  "project_id": null,
  "text": "请问这款练功服的肩带可以调节吗？"
}
```

- `shop_domain` 使用店铺的 `myshopify.com` 域名。`conversation_id` 和 `message_id` 是导入方维护的稳定编号；能取得原平台编号时可使用原编号。没有编号时，由导入方为同一会话和消息分配并保存编号，重试沿用原编号。
- `occurred_at` 需要原消息时间及明确时区，精度最多到毫秒；`sender_name`、`sender_email` 和 `project_id` 可省略。`text` 保留顾客原话，原话与来源信息合计最多 10,000 字符。首版接收文字，不接收附件或客服发言。
- 成功返回 `record_id` 及 `reused`。同一导入账号再次提交相同店铺、会话、消息编号且内容及归属一致时，返回原记录；内容或归属冲突时返回 `409`，不覆盖已保存原话。当前不跨导入账号去重。

这是 Typha 的消息导入口。当前未接入 Shopify Inbox 的自动同步和站内回复；公开的 [Shopify webhook 主题列表](https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic)中未查到 Inbox 聊天主题。后续接入有授权的消息来源时，可由连接器将取得的文字整理为上述格式。不要把工作台会话凭据放在公开的店铺前端。

独立站的「联系我们」表单属于另一条通道。Shopify 会将表单留言发到店铺配置的发件邮箱；若该邮件进入 Typha 已连接的邮箱，可继续用现有邮件归档流程。[Shopify 联系表单说明](https://help.shopify.com/en/manual/online-store/themes/customizing-themes/common-customizations/add-contact-page#view-contact-form-submissions)
