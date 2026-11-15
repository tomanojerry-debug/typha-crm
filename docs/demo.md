# 在线体验

[打开 Typha CRM](https://tomanojerry-debug.github.io/typha-crm/) · [产品介绍](https://tomanojerry-debug.github.io/typha-crm/about.html)

在线体验复用完整应用的 React 入口和页面组件。选择老板、外贸业务员、国内业务员或设计师，即可浏览对应角色的空白工作空间。

浏览器体验没有业务数据，也不连接模型、邮箱或微信。业务资料和外部服务可在[本机完整应用](getting-started.md)中配置。

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

空白工作空间的 API 初始状态由 `demo/generate-fixture.ts` 从新建的内存数据库采集。运行 `npm run demo:fixtures` 可以更新这份配置。工程回归输入由 `npm run demo:test` 独立生成，不进入浏览器构建。
