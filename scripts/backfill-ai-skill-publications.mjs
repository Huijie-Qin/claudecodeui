#!/usr/bin/env node
// Standalone offline importer: no application boot, migrations or server imports.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const HISTORICAL_PUBLICATION_PREFIX = 'historical-skill-publication:';
const FIELDS = new Set(['tenantId', 'userId', 'username', 'skillId', 'skillName', 'firstPublishedAt']);
const MAX_RECORDS = 10000;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveId(value, label) {
  if (!/^[1-9]\d*$/.test(String(value ?? '')) || !Number.isSafeInteger(Number(value))) {
    throw failure('INVALID_ID', `${label} 必须是正整数`);
  }
  return Number(value);
}

function textValue(value, label, maxLength, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw failure('INVALID_TEXT', `${label} 必须是非空文本，且不超过 ${maxLength} 个字符`);
  }
  return value.trim();
}

export function historicalPublicationIdentity(tenantId, userId, skillName) {
  const hash = createHash('sha256').update(JSON.stringify([tenantId, userId, skillName.trim()])).digest('hex');
  return { operationId: `${HISTORICAL_PUBLICATION_PREFIX}${hash}`, historicalSkillId: `historical:${hash}` };
}

// Offset-free values deliberately mean Shanghai wall time, never host local time.
export function normalizePublicationTime(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
  if (!match) throw failure('INVALID_PUBLICATION_TIME', 'firstPublishedAt 格式为 YYYY-MM-DD HH:mm:ss（北京时间）或带 Z/±HH:mm 的 ISO 时间');
  const [, year, month, day, hour, minute, second, fraction = '', zone = '+08:00'] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, sec] = parts;
  const milliseconds = Number(fraction.padEnd(3, '0'));
  const wall = new Date(Date.UTC(y, m - 1, d, h, min, sec, milliseconds));
  if (y < 1000 || wall.getUTCFullYear() !== y || wall.getUTCMonth() + 1 !== m || wall.getUTCDate() !== d
    || h > 23 || min > 59 || sec > 59) throw failure('INVALID_PUBLICATION_TIME', `无效的发布时间：${value}`);
  const zh = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zm = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (zh > 14 || zm > 59 || (zh === 14 && zm !== 0)) throw failure('INVALID_PUBLICATION_TIME', `无效的时区偏移：${zone}`);
  const offset = (zh * 60 + zm) * (zone.startsWith('-') ? -1 : 1);
  return new Date(wall.getTime() - offset * 60000).toISOString();
}

function parseCsv(source) {
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  const pushField = () => { row.push(field); field = ''; afterQuote = false; };
  const pushRow = () => { pushField(); if (row.some(value => value !== '')) rows.push(row); row = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (source[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; afterQuote = true; }
    } else if (c === ',') pushField();
    else if (c === '\n' || c === '\r') { pushRow(); if (c === '\r' && source[i + 1] === '\n') i++; }
    else if (c === '"' && !field && !afterQuote) quoted = true;
    else {
      if (afterQuote || c === '"') throw failure('INVALID_CSV', 'CSV 引号格式错误');
      field += c;
    }
  }
  if (quoted) throw failure('INVALID_CSV', 'CSV 引号没有闭合');
  if (field || row.length || afterQuote) pushRow();
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.trim());
  if (new Set(headers).size !== headers.length || headers.some(value => !FIELDS.has(value))) {
    throw failure('INVALID_CSV', 'CSV 表头重复或未知；使用 tenantId,userId,username,skillId,skillName,firstPublishedAt');
  }
  return rows.map((values, i) => {
    if (values.length !== headers.length) throw failure('INVALID_CSV', `CSV 第 ${i + 2} 行列数与表头不一致`);
    return Object.fromEntries(headers.map((key, n) => [key, values[n]]));
  });
}

export function parsePublicationInput(source, format = 'json') {
  const text = source.replace(/^\uFEFF/, '');
  let rows;
  if (format === 'csv') rows = parseCsv(text);
  else if (format === 'json') {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : parsed?.publications;
  } else throw failure('INVALID_INPUT_FORMAT', '输入文件必须是 .json 或 .csv');
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_RECORDS) {
    throw failure('INVALID_INPUT', `需要 1 至 ${MAX_RECORDS} 条发布记录`);
  }
  return rows;
}

function readSchema(db, apply) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of ['tenants', 'users', 'tenant_users', 'ai_skill_publications', 'ai_usage_source_changes']) {
    if (!tables.has(table)) throw failure('MISSING_SCHEMA', `缺少 ${table}，请指定服务业务数据库并先部署新版服务完成迁移`);
  }
  if (apply) {
    const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ai_skill_publications'").all().map(row => row.name));
    for (const name of ['ai_usage_publication_insert', 'ai_usage_publication_update']) {
      if (!triggers.has(name)) throw failure('MISSING_SOURCE_TRIGGER', `缺少 ${name}；请先启动新版服务完成迁移，再回补`);
    }
  }
  return tables;
}

function knownPublications(db, tables, tenantId) {
  const rows = db.prepare(`SELECT user_id,skill_id,skill_name,first_published_at FROM ai_skill_publications
    WHERE tenant_id=? AND status='confirmed' AND skill_id IS NOT NULL`).all(tenantId);
  if (tables.has('ai_skill_publish_events')) rows.push(...db.prepare(`SELECT user_id,skill_id,skill_name,published_at AS first_published_at
    FROM ai_skill_publish_events WHERE tenant_id=? AND status='succeeded' AND publish_kind='create' AND skill_id IS NOT NULL`).all(tenantId));
  return rows;
}

function planBackfill(db, records, { tenantId, updateExisting, now, tables }) {
  const plan = [];
  const byOperation = new Map();
  const knownByTenant = new Map();
  const ownerBySkill = new Map();
  for (const [index, input] of records.entries()) {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.has(key))) {
        throw failure('INVALID_INPUT', '每条记录必须是仅包含支持字段的对象');
      }
      const tenant = positiveId(input.tenantId == null || input.tenantId === '' ? tenantId : input.tenantId, 'tenantId');
      if (tenantId != null && tenant !== positiveId(tenantId, '--tenant-id')) throw failure('TENANT_MISMATCH', '记录 tenantId 与 --tenant-id 不一致');
      if (!db.prepare('SELECT 1 FROM tenants WHERE id=?').get(tenant)) throw failure('TENANT_NOT_FOUND', `租户 ${tenant} 不存在`);
      const username = textValue(input.username, 'username', 200, true);
      let user;
      if (input.userId != null && input.userId !== '') user = db.prepare('SELECT id,username FROM users WHERE id=?').get(positiveId(input.userId, 'userId'));
      else if (username) {
        const matches = db.prepare(`SELECT u.id,u.username FROM users u JOIN tenant_users t ON t.user_id=u.id
          WHERE t.tenant_id=? AND u.username=? COLLATE BINARY`).all(tenant, username);
        if (matches.length !== 1) throw failure('USER_NOT_UNIQUE', `租户 ${tenant} 中用户名 ${username} 没有唯一匹配`);
        [user] = matches;
      }
      if (!user) throw failure('USER_NOT_FOUND', '未找到用户；请提供 userId 或 username');
      if (username && username !== user.username) throw failure('USER_MISMATCH', 'userId 与 username 不对应');
      if (!db.prepare('SELECT 1 FROM tenant_users WHERE tenant_id=? AND user_id=?').get(tenant, user.id)) {
        throw failure('USER_NOT_IN_TENANT', `用户 ${user.id} 不属于租户 ${tenant}`);
      }
      const skillName = textValue(input.skillName, 'skillName', 200);
      const publishedAt = normalizePublicationTime(input.firstPublishedAt);
      if (publishedAt > now) throw failure('FUTURE_PUBLICATION', '历史发布时间不能晚于当前时间');
      const { operationId, historicalSkillId } = historicalPublicationIdentity(tenant, user.id, skillName);
      const previous = db.prepare('SELECT * FROM ai_skill_publications WHERE operation_id=?').get(operationId);
      if (previous && (previous.tenant_id !== tenant || previous.user_id !== user.id || previous.skill_name !== skillName)) {
        throw failure('OPERATION_COLLISION', '历史回补标识与已有记录归属不一致');
      }
      if (!knownByTenant.has(tenant)) knownByTenant.set(tenant, knownPublications(db, tables, tenant));
      const known = knownByTenant.get(tenant);
      let skillId = textValue(input.skillId, 'skillId', 500, true);
      if (skillId?.startsWith('historical:') && skillId !== historicalSkillId) throw failure('INVALID_HISTORICAL_ID', 'historical: 是脚本保留的统计标识前缀');
      let identitySource = skillId ? 'provided' : previous ? 'existing_backfill' : 'historical';
      if (!skillId && previous) skillId = previous.skill_id;
      if (!skillId) {
        const publishedIds = known.filter(row => row.user_id === user.id && row.skill_name === skillName
          && !row.skill_id.startsWith('historical:')).map(row => row.skill_id);
        // Only a positively identified local publisher is ownership evidence.
        // External account IDs and unowned imports cannot identify the author.
        const bindingIds = tables.has('ai_skill_binding_history') ? db.prepare(`SELECT DISTINCT remote_skill_id
          FROM ai_skill_binding_history WHERE tenant_id=? AND publisher_user_id=? AND local_name=? COLLATE BINARY`)
          .all(tenant, user.id, skillName).map(row => row.remote_skill_id)
          .filter(id => typeof id === 'string' && id.trim() && !id.startsWith('historical:')) : [];
        const candidates = [...new Set([...publishedIds, ...bindingIds])];
        if (candidates.length > 1) throw failure('SKILL_ID_AMBIGUOUS', '同发布者同名 Skill 的已确认发布或可信绑定对应多个 ID，无法自动选择；请核对清单');
        skillId = candidates[0] || historicalSkillId;
        if (candidates.length) identitySource = publishedIds.includes(skillId) ? 'confirmed_publication' : 'trusted_binding';
      }
      if (known.some(row => row.skill_id === skillId && row.user_id !== user.id)) {
        throw failure('SKILL_PUBLISHER_CONFLICT', `Skill ${skillId} 已有其他发布者，不能覆盖`);
      }
      if (tables.has('ai_skill_binding_history') && db.prepare(`SELECT 1 FROM ai_skill_binding_history
        WHERE tenant_id=? AND remote_skill_id=? AND publisher_user_id IS NOT NULL AND publisher_user_id<>? LIMIT 1`).get(tenant, skillId, user.id)) {
        throw failure('SKILL_PUBLISHER_CONFLICT', `Skill ${skillId} 的历史绑定指向其他发布者`);
      }
      const skillKey = JSON.stringify([tenant, skillId]);
      if (ownerBySkill.has(skillKey) && ownerBySkill.get(skillKey) !== user.id) throw failure('SKILL_PUBLISHER_CONFLICT', '输入清单将同一 Skill ID 分配给多个发布者');
      ownerBySkill.set(skillKey, user.id);
      const record = { tenantId: tenant, userId: user.id, username: user.username, skillName, skillId, firstPublishedAt: publishedAt, operationId, identitySource };
      if (byOperation.has(operationId)) {
        const other = byOperation.get(operationId);
        if (other.skillId !== skillId || other.firstPublishedAt !== publishedAt) throw failure('DUPLICATE_INPUT_CONFLICT', '输入清单中同一发布者同名 Skill 的 ID 或发布时间不一致');
        plan.push({ ...record, inputRow: index + 1, action: 'duplicate_input' });
        continue;
      }
      let action = 'insert';
      if (previous) {
        const unchanged = previous.skill_id === skillId && previous.first_published_at === publishedAt && previous.status === 'confirmed';
        if (!unchanged && !updateExisting) throw failure('EXISTING_BACKFILL_CONFLICT', '已回补记录与本次输入不同；核对后使用 --update-existing 更正脚本自己的历史记录');
        action = unchanged ? 'unchanged' : 'update';
      }
      byOperation.set(operationId, record);
      plan.push({ ...record, inputRow: index + 1, action });
    } catch (error) {
      error.message = `第 ${index + 1} 条：${error.message}`;
      throw error;
    }
  }
  return plan;
}

/** Validate the entire manifest and write only owned source records in one transaction. */
export function backfillSkillPublications(db, records, { tenantId, apply = false, updateExisting = false, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_RECORDS) throw failure('INVALID_INPUT', `需要 1 至 ${MAX_RECORDS} 条发布记录`);
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw failure('INVALID_TIME', '无效的当前时间');
  now = instant.toISOString();
  const perform = db.transaction(() => {
    const tables = readSchema(db, apply);
    const rows = planBackfill(db, records, { tenantId, updateExisting, now, tables });
    if (apply) {
      const insert = db.prepare(`INSERT INTO ai_skill_publications
        (operation_id,tenant_id,user_id,skill_id,skill_name,first_published_at,status,created_at,updated_at)
        VALUES(@operationId,@tenantId,@userId,@skillId,@skillName,@firstPublishedAt,'confirmed',@now,@now)`);
      const update = db.prepare(`UPDATE ai_skill_publications SET skill_id=@skillId,first_published_at=@firstPublishedAt,status='confirmed',updated_at=@now
        WHERE operation_id=@operationId AND tenant_id=@tenantId AND user_id=@userId`);
      for (const row of rows) {
        if (row.action === 'insert') insert.run({ ...row, now });
        else if (row.action === 'update') update.run({ ...row, now });
      }
    }
    return { mode: apply ? 'applied' : 'dry_run', inputCount: rows.length,
      inserted: rows.filter(row => row.action === 'insert').length,
      updated: rows.filter(row => row.action === 'update').length,
      unchanged: rows.filter(row => row.action === 'unchanged').length,
      duplicateInput: rows.filter(row => row.action === 'duplicate_input').length, rows,
      notes: ['只写 ai_skill_publications 原始发布事实；不会直接改看板结果，也不会触发立即执行。',
        '下次统计成功发布后看板更新；全量重算会保留这些历史发布事实。',
        'historical: ID 仅用于本地历史统计，不是 Skill 市场 ID；调用按历史名称唯一匹配，无法确定归属的记录不猜测。'] };
  });
  return apply ? perform.immediate() : perform();
}

async function loadDatabase(projectRoot) {
  const ownPath = fileURLToPath(import.meta.url);
  const roots = projectRoot ? [path.resolve(projectRoot)] : [process.cwd(), path.dirname(ownPath), path.dirname(path.dirname(ownPath))];
  for (const root of [...new Set(roots)]) {
    try { return createRequire(path.join(root, 'package.json'))('better-sqlite3'); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw failure('DATABASE_DRIVER_NOT_FOUND', '找不到 better-sqlite3。请在服务项目目录运行，或加 --project-root /实际服务项目目录；本脚本不依赖 server/ 下文件。');
}

const help = `历史 Skill 发布回补（默认只预览，不写库）
node backfill-ai-skill-publications.mjs --db /绝对路径/auth.db --input /绝对路径/skills.json --tenant-id 1 [--apply]
可选：--project-root /服务项目目录  --update-existing  --json
JSON 数组或 CSV；字段：tenantId,userId/username,skillName,firstPublishedAt,skillId（可选）。
不带时区的 YYYY-MM-DD HH:mm:ss 按 Asia/Shanghai；Skill 名称只去除首尾空白，区分大小写。
--update-existing 仅允许更正本脚本已写入的记录，不修改系统原有发布记录。
`;

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { db: { type: 'string' }, input: { type: 'string' },
    'tenant-id': { type: 'string' }, 'project-root': { type: 'string' }, apply: { type: 'boolean', default: false },
    'update-existing': { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log(help); return; }
  if (!values.db || !path.isAbsolute(values.db) || !values.input) throw failure('INVALID_ARGUMENTS', help);
  if ((await stat(values.input)).size > 10 * 1024 * 1024) throw failure('INPUT_TOO_LARGE', '清单文件不能超过 10 MiB');
  const records = parsePublicationInput(await readFile(values.input, 'utf8'), path.extname(values.input).slice(1).toLowerCase());
  const Database = await loadDatabase(values['project-root']);
  const db = new Database(values.db, { readonly: !values.apply, fileMustExist: true, timeout: 5000 });
  try {
    const result = backfillSkillPublications(db, records, { tenantId: values['tenant-id'], apply: values.apply, updateExisting: values['update-existing'] });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.mode === 'applied' ? '已写入' : '预览（未写入）'}：新增 ${result.inserted}，更正 ${result.updated}，不变 ${result.unchanged}，清单内重复 ${result.duplicateInput}`);
      for (const row of result.rows) console.log(`${row.action}\ttenant=${row.tenantId}\tuser=${row.userId} (${row.username})\t${row.skillName}\t${row.firstPublishedAt}\t${row.skillId}`);
      for (const note of result.notes) console.log(note);
    }
    return result;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`${error.code || 'BACKFILL_FAILED'}: ${error.message || error}`); process.exitCode = 1; });
}
