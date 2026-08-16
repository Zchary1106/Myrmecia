---
name: api-contract-design
description: Design clear, consistent, extensible API contracts: REST resources, request/response schemas, OpenAPI spec, error codes, and auth strategy.
---

# API Contract Design

## Deliverables
1. **API 概览** — 资源列表与关系
2. **接口定义** — 每个端点的 method、path、请求/响应 schema（TypeScript interface）
3. **OpenAPI Spec** — 完整 YAML 规范
4. **错误处理** — 统一错误码与错误响应格式
5. **认证方案** — 鉴权策略与 rate limiting / 缓存建议

## Rules
- 遵循 RESTful 最佳实践（资源命名、HTTP 方法语义）。
- 分页用 cursor-based（大数据集）或 offset-based。
- 版本管理策略明确（不静默改变旧数据含义）。
