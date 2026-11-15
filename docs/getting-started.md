# 本机运行

需要 Node.js 22.13 或更新版本。以下步骤适用于全新克隆的工作目录。

```bash
git clone https://github.com/tomanojerry-debug/typha-crm.git
cd typha-crm
npm ci
cp -n .env.example .env
npm run setup
npm run dev
```

打开 http://127.0.0.1:3100 。初始账号与随机密码由setup写入本机 `.local/initial-login.txt`，请在自己的电脑上查看该文件登录。默认初始化空白工作空间，未配置模型密钥时可使用资料管理与确定性报告，AI生成需配置模型服务。

已有账号时，`setup` 会保留账号和资料，并执行迁移。日常启动请使用上面的启动命令。

Windows用户可手动将 `.env.example` 复制为 `.env` 后运行相同的npm命令。不要覆盖已有配置。所有路径相对于项目根目录。完整CRM的正文Web字体可能请求Google Fonts；标题字体已本地打包，在线体验使用随包字体与系统回退字体。

## 邮箱设置

工作空间管理员可连接网易个人邮箱，包括 `@163.com`、`@126.com` 和 `@yeah.net`。登录后，从「邮件管理 → 邮箱设置」进入，按指引生成网易客户端授权码并完成首次同步。 [邮箱连接指引](connect-email.md)

## 模型与知识组件

配置名称见 [环境变量示例](../.env.example)。当前模型适配器使用 `MINIMAX_API_KEY`、区域及固定端点选择；尚未提供任意Base URL、任意模型或普通用户切换界面。密钥由服务端读取，选定的任务上下文会发送至所配置服务。

Graphiti默认关闭。需要本机知识检索时，按[知识组件](knowledge.md)准备Python环境和嵌入模型，再启用对应配置。关闭Graphiti不会关闭全部邮件或文档worker。

## 构建与检查

```bash
npm run typecheck
npm test
npm run build
```

`npm run dev`提供开发服务器；`npm start`是生产模式，要求HTTPS APP_ORIGIN、相应密钥配置与部署验收。本机直达账号 `LOCAL_ACCESS_EMAIL`仅支持回环地址、开发模式、本地PGlite。

已有实例升级前应停止唯一服务、备份最新业务库及必要配置，在副本验证迁移后再升级。不要并发打开同一个PGlite目录，不要以旧备份覆盖后来的资料。

企业自租云服务器的部署方式仍在规划中。本指南适用于企业本机。

## 在线体验

[在线体验](https://tomanojerry-debug.github.io/typha-crm/)运行实际产品前端，进入后可浏览空白工作空间。录入资料和连接服务请按上面的步骤在本机运行。在线体验的构建方式见[说明](demo.md)。
