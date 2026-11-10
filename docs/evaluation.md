# 测试范围

本公开预览包提供114份工程测试，覆盖客户权限、来源版本、取消和迟到结果、持久Run、邮件模板、草稿幂等、活动及售后统计等路径。

```bash
npm run typecheck
npm test
npm run build
```

测试以虚构fixture、隔离内存数据库、可注入模型transport和fake邮件传输执行。不会要求真实邮箱授权码或模型API密钥。完整结果以仓库Actions为准。

`evals/light-crm-v1/fixtures.json`和少量test-support用于这些工程测试。完整90场景的产品采集器、裁判校准、人工批准及企业内部capture不包含在本包中；不能从单元／接口检查通过推断业务语义质量通过。

## 适合阅读的用例

- `tests/agent-runs.test.ts`：持久运行、取消与恢复。
- `tests/agent-execution.test.ts`：预算和停止。
- `tests/chat-source-unavailable.test.ts`：来源失权后的停止。
- `tests/activity-analysis.test.ts`：去重、日期、未知值和冲突。
- `tests/activity-analysis-api.test.ts`：报告配置、权限和人工来源改版。

在线产品导览展示使用虚构资料的真实UI截图与预设流程，不执行实际模型调用，也不冒充新的模型质量评测。
