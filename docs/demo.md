# 在线体验

[打开 Typha CRM](https://tomanojerry-debug.github.io/typha-crm/) · [产品介绍](https://tomanojerry-debug.github.io/typha-crm/about.html)

在线体验直接复用完整应用的React入口、Workbench、客户档案、待办与报告组件。客户列表、表格／卡片、右侧预览、全页详情、活动原话和报告界面与本机产品共用实现。

体验空间包含示例客户、联系人、项目、沟通记录、业务笔记、活动与待办。可以搜索、筛选、修改示例客户资料、开始与完成待办，或按款式、问题与尺码筛选售后看板、查看原活动和导出当前页明细。页面刷新或使用“重置”后恢复初始资料。

AI流程使用准备好的示例对话；在线体验不连接真实模型、邮箱或微信。部分管理和连接操作需要在[本机完整应用](getting-started.md)中使用。浏览器演示不承载企业真实数据，也不代表服务端权限与真实模型质量验收。

## 本机预览

```bash
npm ci
npm run demo:test
npm run demo:build
python3 -m http.server 4173 --bind 127.0.0.1 --directory .pages-build
```

访问 http://127.0.0.1:4173/ 。生成目录`.pages-build`不提交Git，GitHub Actions构建后将其发布到Pages；相对资源路径支持仓库子路径。

## 实现与数据

`demo/main.tsx`挂载实际`App`，专用Vite配置仅在此构建中将前端API入口替换为浏览器适配器。未实现的请求明确拒绝，没有真实网络回退；页面通过CSP禁止连接请求，并使用随包字体。普通应用构建仍使用原服务端API。

固定JSON由`demo/generate-fixture.ts`在全新内存库中通过真实服务与隔离API生成，不读取`.env`或日常数据库，不启动后台worker。反馈筛选和聚合用服务端固定查询结果进行对照验证；演示仅支持预设反馈字段映射。重新准备示例可运行`npm run demo:fixtures`，它只写入演示JSON。
