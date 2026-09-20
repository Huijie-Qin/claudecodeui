-- 项目内 SQLite 专用明细表；与现有业务表使用同一个 DATABASE_PATH。
-- 当前实例：/Users/da-group/.cloudcli/ccui/data/auth.db。
-- 本文件仅提供 DDL，不自动执行，不替换 ai_usage_report_rows。
-- SQLite 日期和时间均用 TEXT；写入程序统一转换为 Asia/Shanghai。
-- 日期：YYYY-MM-DD；时间：YYYY-MM-DD HH:mm:ss（如 2026-09-17 11:56:06）。
-- 时间不带 T、Z 或偏移；时长仍保留原始毫秒整数，不由秒精度文本反算。
-- 没有 dataset、event_type、partition_id、value_json。

CREATE TABLE ai_dashboard_integration_detail (
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  occurred_at TEXT,
  user_id INTEGER,
  user_name TEXT,
  workspace_id INTEGER,
  workspace_name TEXT,

  -- AI 使用：有效交互证明与已完成请求的当日时长分别写行。
  ai_session_id TEXT,
  has_ai_interaction INTEGER,
  ai_active_duration_ms INTEGER,

  -- Skill 调用行的 user_id 是调用者，publisher_user_id 是发布者。
  skill_id TEXT,
  skill_name TEXT,
  publisher_user_id INTEGER,
  publisher_user_name TEXT,
  skill_publish_count INTEGER,
  skill_call_count INTEGER,

  -- 只取指定 SQL 行数记录的 sqlLineCount。
  sql_record_id TEXT,
  generated_sql_lines INTEGER,

  -- ai_mr_submissions：仅 status='merged'，按 merged_at 的上海日期归属，取 additions。
  -- 先进入旧报表，再投影到本表；按提交记录 ID 去重，不按 commit_sha 去重。
  code_submission_id TEXT,
  repository_url TEXT,
  commit_sha TEXT,
  submitted_code_lines INTEGER,

  refreshed_at TEXT NOT NULL,

  PRIMARY KEY (tenant_id, id)
);
