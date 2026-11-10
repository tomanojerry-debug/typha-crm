# 工程设计

本预览版本以单个Node.js / Express服务承载HTTP API、持久Agent运行和后台任务。React / Vite前端调用业务API，默认使用内嵌PGlite和pgvector，可选Python桥接本机知识组件。

## 从请求到交付

1. 服务端验证workspace、actor、客户ACL及项目归属。
2. 持久Run保存请求身份和运行状态，前端离页只退订，回来恢复；用户显式停止才取消。
3. TaskState表达当前条件，ContextPlan根据任务和权限装配原文、历史和任务输入。
4. Harness执行受限工具，模型输出通过结构、来源与新鲜度校验后才提交。
5. 问答与草稿按允许的业务路径保存；正式资料变更及发送仍按各自确认流程执行。

主要持久Home／Ask／工作流默认共用180秒／8次模型调用预算，明确原生瞬时故障且未显示正文时整次Run最多一次恢复；业务写入与发送不进入模型重试。其他独立AI入口尚未全部统一到同一合同。

## 为什么分开保存状态与原文

客户原文是依据，任务条件是用户本轮要做什么，Run是执行实例，图和向量是检索索引。各自有不同的有效期和权限，引用时回读当前原文，避免把旧回答或检索命中变成新的业务事实。

## 代码阅读入口

- `server/agent-runs.ts`：持久运行、订阅、取消、恢复。
- `server/agent-execution.ts`：预算与运行观测。
- `server/agent-task-state.ts`、`server/agent-context-plan.ts`：任务条件与上下文计划。
- `server/agent-harness.ts`、`server/agent-skills.ts`：工具合同与显式Skill注册。
- `server/security.ts`和迁移：事务角色、客户ACL、SQL RLS。
- `server/activity-analysis.ts`：确定性售后反馈聚合、可证明去重与来源有效性。

邮件Skill随代码审核和版本发布，不能通过上传业务文件替换执行方法。Graphiti与原文向量共用Record来源，进一步说明见[记忆与检索](memory.md)。

## 当前边界

公共源码包包含已发布业务能力与工程测试，未包含企业运行快照、真实数据、内部评测capture和完整裁判工具链。模块复用和已通过的工程检查不等于完整业务准确率或任意环境的生产部署承诺。
