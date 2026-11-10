# 可选本机知识组件

默认 `GRAPHITI_ENABLED=false`，基本CRM不需要启动独立PostgreSQL或图数据库服务。

本机知识组件通过Python桥接Graphiti、FalkorDBLite与FastEmbed；业务原文保存在CRM数据库，图和向量是可重建索引。模型负责受控抽取，本机MiniLM生成384维向量。知识任务依然可能调用所配置的外部模型API。

macOS下已使用Python 3.12验证该组件；其他系统尤其Windows的原生图组件仍需独立验收。新环境的准备步骤：

```bash
uv python install 3.12
uv venv --python 3.12 .local/graphiti-venv
uv pip install --python .local/graphiti-venv/bin/python --only-binary falkordblite -r scripts/graphiti/requirements.txt
.local/graphiti-venv/bin/python scripts/graphiti/download-model.py
```

准备完成后，在自己的.env中设置：

```dotenv
GRAPHITI_ENABLED=true
GRAPHITI_PYTHON=.local/graphiti-venv/bin/python
GRAPHITI_DATA_DIR=.local/graphiti
```

Python依赖按requirements固定版本，模型需要单独下载。图索引按workspace、客户和代次组织，服务端控制可读取的来源和当前版本；不是开放给浏览器的图数据库接口。

备份仍应包含业务数据库和必要配置。仅保存图文件无法恢复邮件、文档原件或业务状态。
