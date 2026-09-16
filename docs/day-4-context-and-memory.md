# 第 4 天：Context 与 Memory

## 学习目标

理解 Context 是本轮模型可见的信息集合，Memory 是跨轮或跨会话保存后再检索的信息。上下文不是越多越好：无选择地塞历史会提高成本、降低相关性，并增加提示注入风险。

## 当前实现

- 会话消息：PostgreSQL 的 `agent_sessions` 与 `messages`，用于前端历史展示。
- 长期记忆：PostgreSQL 的 `user_memories`。写入时使用 `nomic-embed-text` 生成向量；检索优先 pgvector 相似度，模型不可用时回落到 PostgreSQL 全文检索。
- Context 装配：`agentService.js` 只取命中的前三条记忆，再放入模型上下文。
- 知识库：`knowledgeService.js` 是独立于个人记忆的系统知识，用于回答 Agent 工程概念并保留证据来源。

## 动手步骤

1. 发送“记住：我偏好 TypeScript 和 Fastify”。
2. 新建会话后发送“我的技术偏好是什么？”。
3. 在工作台查看长期记忆数量增长，并查看 Trace 中 `memory_search` 或 `remember` Span。
4. 发送“Agent 的 Harness 如何做？”并比较它走的是系统知识库，而非个人偏好记忆。

## 设计取舍

当前实现使用 PostgreSQL + pgvector 保存记忆与知识分块，MinIO 保存上传原文件，不使用本地 JSON。生产环境仍应增加 tenant、ACL、过期时间、来源与删除能力。记忆写入应区分“用户明确要求记住”和“模型自行猜测的信息”。

## 验收标准

- 跨会话可以找回明确写入的偏好。
- 普通聊天历史不会被无上限地重复注入。
- 能说清个人记忆、系统知识、短期上下文和会话日志的边界。

## 面试口述要点

> 我把记忆分成短期 Context、会话日志、用户长期记忆和系统知识。模型每轮只收到经过检索和预算控制的信息，不直接接收全部历史。当前本地用 JSON 和 embedding 演示检索链路；生产会加租户隔离、ACL、TTL、来源追踪和删除机制。这样既控制 Token 成本，也避免把不相关或无权限数据送进模型。
