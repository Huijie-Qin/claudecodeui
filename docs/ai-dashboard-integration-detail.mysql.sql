-- 非当前项目实施方案：此稿曾误按外部 MySQL 建表理解，仅留作备选参考。
-- 项目内正式设计请用同目录 ai-dashboard-integration-detail.sql（SQLite）。
-- 本备选稿适用 MySQL 8.0.16+。
-- 尚未接入自动写入；不要用此文件替换现有 SQLite 报表表。
-- 本备选稿时间约定亦统一 Asia/Shanghai，DATETIME 格式 YYYY-MM-DD HH:mm:ss。
-- 无 dataset、event_type、partition_id 或 JSON 指标字段。
-- 一条来源事实一行；跨日 AI 时长按业务日期切片。
-- 每行只填一组事实指标，不适用或未知字段为 NULL，真实零值保留 0。

CREATE TABLE ai_dashboard_integration_detail (
  tenant_id BIGINT NOT NULL COMMENT '租户 ID；查询必须限定租户',
  detail_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
    COMMENT '稳定明细键：可信来源事实身份及必要日期切片的 SHA-256；重跑不变',
  stat_date DATE NOT NULL COMMENT '统计日期，Asia/Shanghai；看板起止日期筛选字段',
  occurred_at DATETIME NULL COMMENT '事实发生时间，Asia/Shanghai；未知留空，不使用导入时间代替',
  user_id BIGINT NULL COMMENT '实际行为用户；Skill 发布为发布者，Skill 调用为调用者',
  user_name VARCHAR(255) NULL COMMENT '用户名快照；未知留空，以 user_id 归组',
  workspace_id BIGINT NULL COMMENT '事实所属工作区；无法确认时为空',
  workspace_name VARCHAR(255) NULL COMMENT '工作区名称快照；以 workspace_id 归组',

  ai_session_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT '可信逻辑 AI 会话身份的 SHA-256；含租户、用户、工作区、提供方和原始会话身份',
  has_ai_interaction TINYINT UNSIGNED NULL
    COMMENT '1=本行证明该业务日有有效用户交互；其他事实为空；不是消息条数',
  ai_active_duration_ms BIGINT UNSIGNED NULL
    COMMENT '已完成请求在本业务日的有效时长，毫秒；仅时长事实填写',

  skill_id VARCHAR(255) NULL COMMENT '业务 Skill ID；同名不同 ID 不合并',
  skill_name VARCHAR(255) NULL COMMENT 'Skill 名称快照',
  publisher_user_id BIGINT NULL COMMENT 'Skill 的可信发布用户 ID；不能用调用者兜底',
  publisher_user_name VARCHAR(255) NULL COMMENT '发布用户名快照',
  skill_publish_count TINYINT UNSIGNED NULL
    COMMENT '确认首次发布记 1；同租户同 Skill 只保留一次首次发布；其他事实为空',
  skill_call_count TINYINT UNSIGNED NULL
    COMMENT '一次去重后的有效调用发起记 1；不要求成功；其他事实为空',

  sql_record_id VARCHAR(255) NULL COMMENT 'SQL 行数记录的原始 Hook 业务记录 ID',
  generated_sql_lines BIGINT UNSIGNED NULL
    COMMENT '指定 SQL 行数记录的有效 sqlLineCount 原值；不是所有生成代码行数',

  code_submission_id VARCHAR(255) NULL COMMENT '可信代码提交事实 ID；采集粒度须在对接时确认',
  repository_url VARCHAR(2048) NULL COMMENT '提交代码所属仓库 URL；不由 SQL 记录推测',
  commit_sha VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT '可确认的 Git commit SHA；MR 头 SHA 不能替代完整 commit 集合',
  submitted_code_lines BIGINT UNSIGNED NULL
    COMMENT '按双方确认提交口径采集的新增代码行数；未接入或无法确认时为空',

  refreshed_at DATETIME NOT NULL COMMENT '本次完整结果发布时间，Asia/Shanghai；不是业务事件时间',

  PRIMARY KEY (tenant_id, detail_id),
  KEY idx_integration_date (tenant_id, stat_date),
  KEY idx_integration_user_date (tenant_id, user_id, stat_date),
  KEY idx_integration_workspace_date (tenant_id, workspace_id, stat_date),
  KEY idx_integration_skill_date (tenant_id, skill_id, stat_date),
  KEY idx_integration_publisher_date (tenant_id, publisher_user_id, stat_date),
  CONSTRAINT chk_integration_ai_marker
    CHECK (has_ai_interaction IS NULL OR has_ai_interaction = 1),
  CONSTRAINT chk_integration_publish_count
    CHECK (skill_publish_count IS NULL OR skill_publish_count = 1),
  CONSTRAINT chk_integration_call_count
    CHECK (skill_call_count IS NULL OR skill_call_count = 1),
  CONSTRAINT chk_integration_one_fact
    CHECK (
      (has_ai_interaction IS NOT NULL) +
      (ai_active_duration_ms IS NOT NULL) +
      (skill_publish_count IS NOT NULL) +
      (skill_call_count IS NOT NULL) +
      (sql_record_id IS NOT NULL) +
      (code_submission_id IS NOT NULL) = 1
    ),
  CONSTRAINT chk_integration_ai_identity
    CHECK ((has_ai_interaction IS NULL AND ai_active_duration_ms IS NULL) OR ai_session_id IS NOT NULL),
  CONSTRAINT chk_integration_skill_identity
    CHECK ((skill_publish_count IS NULL AND skill_call_count IS NULL) OR skill_id IS NOT NULL),
  CONSTRAINT chk_integration_sql_identity
    CHECK (generated_sql_lines IS NULL OR sql_record_id IS NOT NULL),
  CONSTRAINT chk_integration_code_identity
    CHECK (submitted_code_lines IS NULL OR code_submission_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  COMMENT='AI 看板对外明细：AI 使用、Skill 发布调用、SQL 生成、代码提交；仅已发布完整结果';
