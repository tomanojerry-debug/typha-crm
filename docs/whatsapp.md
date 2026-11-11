# 接收 WhatsApp Business 消息

Typha 接收 Meta Cloud API 推送的新文字消息，并按商务账号、号码和消息 ID 去重。新消息先进入指定负责人的私有收件区。负责人确认客户及可选项目后，顾客原话会成为客户记录，可在档案和 Ask Typha 中回看。

首版提供后台收件和归档 API，支持 Cloud API 的单聊新文字消息。Meta 支持符合资格的 WhatsApp Business App 号码和 Cloud API 共存。 [Meta 收件示例](https://www.postman.com/meta/whatsapp-business-platform/request/cy6hnq7/received-text-message) · [Meta 共存说明](https://about.fb.com/news/2025/09/bringing-new-tools-to-help-businesses-boost-engagement-customer-support-and-discoverability/)

## 配置收件

1. 在 Meta 为企业配置 WhatsApp Cloud API。试用时可以使用 Meta 提供的测试号码。
2. 从 Typha 的已登录会话 `GET /api/session` 获取目标工作空间 ID 和负责人账号 ID。负责人须是该空间的有效成员，归档时须能编辑选定客户。
3. 在 Typha 服务环境配置下列六项，重启服务。全部留空时收件接口关闭。

| 环境变量                   | 用途                                             |
| -------------------------- | ------------------------------------------------ |
| `WHATSAPP_APP_SECRET`      | Meta App Secret，用于核验回调正文签名            |
| `WHATSAPP_VERIFY_TOKEN`    | 自选的随机验证值，在 Meta 回调设置中填写同一个值 |
| `WHATSAPP_WABA_ID`         | 允许收件的 WhatsApp Business Account ID          |
| `WHATSAPP_PHONE_NUMBER_ID` | 允许收件的 Meta Phone Number ID                  |
| `WHATSAPP_WORKSPACE_ID`    | Typha 工作空间 ID                                |
| `WHATSAPP_INTAKE_ACTOR_ID` | Typha 收件负责人账号 ID                          |

4. 在 Meta 设置公开 HTTPS 回调 `https://<your-host>/webhooks/whatsapp`，订阅 `messages`，并将 Meta App 订阅到该 WABA。回调验证会回传 Meta 的 `hub.challenge`。
5. 给测试号码发送一条文字，用收件负责人的账号在 Typha 查询待归属消息。

Meta 的回调地址必须从公网可访问。仅在 `localhost` 监听的 Typha 需要另行配置 HTTPS 转发。公网入口只转发 `GET` 和 `POST /webhooks/whatsapp`，保留 POST 请求原文及 `X-Hub-Signature-256`。工作台及 `/api` 通过原来的本地地址访问。 [Meta 回调要求](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/receivingMessages/)

## 接口

| 请求                                        | 用途                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /webhooks/whatsapp`                    | Meta 验证回调地址。按 `hub.mode`、`hub.verify_token`、`hub.challenge` 完成验证 |
| `POST /webhooks/whatsapp`                   | 接收 Meta 签名的 JSON。成功后返回新增消息数 `received`。重试投递按消息 ID 去重 |
| `GET /api/whatsapp/inbox?limit=30&offset=0` | 用收件负责人会话查看待归属消息及总数                                           |
| `POST /api/whatsapp/inbox/:id/archive`      | 提交 `customer_id` 和可选 `project_id`。返回 `record_id` 和 `reused`           |

每次 webhook 请求上限为 256 KiB，每条正文最多 8,000 个 UTF-16 代码单元。工作台接口使用登录会话和 `X-Workspace-Id`。归档请求沿用现有同源 JSON 规则。每条消息保留原话、发送者标识、可用的昵称和发送时间。项目须属于客户且仍有效。对同一归属重试会返回原记录，变更归属须另行处理。归档后原文保存在受客户权限保护的客户记录中。
