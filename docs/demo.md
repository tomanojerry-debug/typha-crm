# 产品导览

在线入口：https://tomanojerry-debug.github.io/typha-crm/

产品导览由 `site/` 下的原生HTML、CSS和JavaScript组成，部署于GitHub Pages。截图从独立虚构数据环境中的真实CRM界面捕获；场景切换和步骤说明在浏览器内执行，无模型、邮箱或数据库请求。

源码仓库同时提供完整Node应用，按[本机运行](getting-started.md)使用自己的空白数据环境。该页面不提供多人共享的真实CRM后端。

本机预览导览：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

从仓库根目录启动后访问 http://127.0.0.1:4173/site/ 。页面使用相对资源路径，支持GitHub项目站点的仓库子路径。
