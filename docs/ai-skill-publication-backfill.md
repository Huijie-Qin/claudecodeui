# 历史 Skill 发布回补

脚本：`scripts/backfill-ai-skill-publications.mjs`。适用于提供“租户、发布用户、历史 Skill 名称、首次发布时间”的清单。**不需要提供 Skill ID**。它把人工确认的历史事实写入 `ai_skill_publications`，不会直接改看板结果，也不重新发布 Skill 到市场。

## 输入清单

可以使用 JSON 或 CSV；模板位于 `examples/ai-usage/skill-publications.json` 和 `examples/ai-usage/skill-publications.csv`。

```json
[
  {
    "tenantId": 1,
    "username": "alice",
    "skillName": "sql-review",
    "firstPublishedAt": "2026-08-01 09:30:00"
  }
]
```

- `tenantId`：服务数据库中的租户 ID。整份清单属于同一租户时，可从每行省略，在命令中传 `--tenant-id 1`。如果同时提供，两处必须一致。
- `userId` 或 `username`：发布用户；填写本系统用户 ID 或精确用户名。若同时填写，必须对应同一用户。脚本校验 `tenant_users` 成员关系，允许仍保留关系的停用／待启用历史成员。已完全移除成员关系的用户不会根据全系统用户名猜测租户归属。
- `skillName`：Skill 历史名称，首尾空白会去掉，区分大小写。应与历史会话实际调用名称一致；不自动去前缀、不模糊匹配、不根据相似名称合并。
- `firstPublishedAt`：首次发布时间，必须含日期、时分秒。`2026-08-01 09:30:00` 明确按北京时间（Asia/Shanghai）解析；也接受 `2026-08-01T09:30:00+08:00` 或 `2026-08-01T01:30:00Z`。数据库保存 UTC ISO 时间，夜间统计按业务时区归日。非法日期和未来时间会报错。
- `skillId`：可选。如果没有，脚本在同租户、同发布者、精确同名的已确认发布记录，以及明确记录该发布者本系统用户 ID 的历史绑定中查找真实 ID。两种来源合并后必须只有一个 ID 才复用；发现多个 ID 会报歧义错误。`publisher_user_id` 为空的导入绑定或仅有外部账号数字不会用来推断发布者。无法找到可信 ID 时生成稳定的 `historical:<hash>` 本地统计标识。它不是市场 Skill ID，不应用于市场接口。

同租户、同发布者、同名 Skill 对应同一回补标识。重复清单不会重复新增；不同发布者同名 Skill 可分别回补，但历史调用若无法唯一确定归属，会保持未确认，而不把一条调用分给多个发布者。同一发布者确实发布过多个同名且不同身份的 Skill 时，不能只凭名称还原，需要先核对并补充明确身份或名称。

## 运行

先把模板替换为真实清单。使用服务实际业务数据库的**绝对路径**，不要把脚本指向测试库或仅有报表表的副本。

```sh
# 在服务项目目录运行；默认只校验和预览。
node scripts/backfill-ai-skill-publications.mjs \
  --db /实际路径/auth.db \
  --input /实际路径/skill-publications.json \
  --tenant-id 1

# 校验清单后写入；同样支持 .csv。
node scripts/backfill-ai-skill-publications.mjs \
  --db /实际路径/auth.db \
  --input /实际路径/skill-publications.json \
  --tenant-id 1 --apply
```

脚本可以单独复制到服务器，只依赖服务已安装的 `better-sqlite3`，**不依赖 `server/services/` 下的其他文件**。如果脚本放在 `/root` 等服务目录外，指定项目目录以加载服务自己的数据库驱动：

```sh
node /root/backfill-ai-skill-publications.mjs \
  --project-root /实际服务项目目录 \
  --db /实际路径/auth.db \
  --input /root/skill-publications.csv \
  --tenant-id 1 --apply --json
```

使用与服务 `better-sqlite3` 安装版本兼容的 Node.js 运行。`--help` 不加载数据库驱动，可直接查看参数。

输出 `inserted`、`updated`、`unchanged`、`duplicateInput` 及每条解析后的用户 ID、Skill 统计 ID、UTC 发布时间。在预览模式下，`inserted`/`updated` 表示计划新增／更正数量，不代表已落库。若数据有问题，整份清单失败，不会部分写入。数据库被其他事务长期占用时会等待最多 5 秒后失败，解决占用后重试即可。

首次写入后，修改同一用户同名 Skill 的发布时间或身份会默认报 `EXISTING_BACKFILL_CONFLICT`。明确要更正本脚本已有记录时使用 `--update-existing --apply`。该选项只能更正以 `historical-skill-publication:` 开头、由此脚本生成的记录；系统原有发布事件和其他来源记录保留。批量导入中的同一身份出现互相矛盾的时间或 ID，仍会拒绝整份清单。

## 落库与看板刷新

- 原始发布事实：`ai_skill_publications`，状态为 `confirmed`；稳定 `operation_id` 前缀为 `historical-skill-publication:`。
- 数据库原有触发器将变化写入 `ai_usage_source_changes`，由夜间统计消费。脚本不会自行创建或迁移应用表；写入前要求新版发布触发器已经安装。
- 原始历史保留；之后 `AI_USAGE_INCREMENTAL_ENABLED=false` 全量重算仍会读取本次回补的发布事实。
- 看板和对外明细表在后续统计批次成功发布后更新，脚本执行完不等于看板已经刷新。已成功发布的同日批次不会因此自动重开。
- 历史调用次数仍从可信归属的会话记录中识别真实调用，并通过有效绑定或人工回补的唯一名称映射归属；发布清单本身不会凭空生成调用次数。

部署后 `calculation_version` 末尾应包含 `skill_history_v17`。首次升级会重读旧版本未识别的包装会话记录；暂停恢复和完成发布前，原有正式看板保持不变。后续导入／更正即使使用增量模式，也会重新归因已扫描的旧会话。发布时间之前的调用不归给该历史发布；已有有效远端绑定时，不用名称覆盖它。

没有唯一对应关系的实际工具调用可从 `ai_usage_fact_rows` 查看 `value_json.attributionReason`，例如 `historical_name_ambiguous`、`historical_mapping_missing`、`historical_publication_after_call` 或 `publisher_unresolved`。批次 `coverage_json.skillInvocationDiagnostics` 汇总这些已形成调用事实的未归因记录；未证实的纯 slash 命令不会作为调用事实进入该诊断，不能把诊断为 0 理解为已覆盖全部原始文件。

只读核对（把 `1` 改为实际租户 ID）：

```sql
SELECT tenant_id, user_id, skill_id, skill_name,
       first_published_at,
       datetime(first_published_at, '+8 hours') AS published_beijing,
       status, operation_id
FROM ai_skill_publications
WHERE tenant_id = 1
  AND operation_id LIKE 'historical-skill-publication:%'
ORDER BY first_published_at, user_id, skill_name;
```

## 验证

```sh
node --test scripts/backfill-ai-skill-publications.test.mjs
```

测试覆盖默认只读、幂等、整批预校验与事务回滚、跨租户隔离、用户名解析、发布者冲突、可信绑定复用与未知绑定排除、系统原记录保留、显式更正、时间解析、JSON/CSV 清单、来源队列，以及把脚本复制到项目外后通过 `--project-root` 独立执行。
