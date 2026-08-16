---
name: database-migration
description: Design and execute database schema changes with migration files, data migration scripts, impact analysis, index advice, and rollback plans. High-risk writes require an approval gate.
---

# Database Migration

## Deliverables
1. **Schema 变更** — DDL 或 ORM 迁移文件（Prisma / Drizzle / raw SQL）
2. **数据迁移** — 不丢数据的升级脚本，必须幂等
3. **影响分析** — 受影响的 API/查询
4. **回滚方案** — 如何安全回退
5. **索引建议** — 基于查询模式的优化

## Rules
- 始终提供回滚方案；不可逆操作（删列/删表）必须标红警告。
- 大表变更考虑锁等待与性能影响。
- 命名规范（snake_case、表名复数）。
- 高风险写操作（删数据/改生产 schema）默认 dry-run，需人工批准后执行。
