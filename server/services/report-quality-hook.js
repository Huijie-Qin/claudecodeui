// Executed inside the existing Hook sandbox; keep this function self-contained.
async function reportQualityStop(event, ccui) {
  const configPath = '.ccui/report-quality.json';
  const terminal = (message) => ({ output: {
    status: 'failed', continue: false,
    stopReason: `报告验收未通过：${message}`, systemMessage: `报告验收未通过：${message}`,
  } });
  const sessionId = String(event.session_id || ccui.env.sessionId || '');
  if (!sessionId || sessionId.length > 160) return terminal('缺少有效的会话 ID。');
  const statePath = `.ccui/report-quality-runs/${encodeURIComponent(sessionId)}.json`;
  let state = event.stop_hook_active && await ccui.workspace.exists(statePath)
    ? await ccui.workspace.readJson(statePath) : null;
  const pending = event.stop_hook_active && state && !state.closed;
  if (!(await ccui.workspace.exists(configPath))) {
    return pending ? terminal('修正过程中验收配置被移除。') : { output: { status: 'inactive' } };
  }
  const config = await ccui.workspace.readJson(configPath);
  if (config.enabled === false) {
    return pending ? terminal('修正过程中验收配置被禁用。') : { output: { status: 'inactive' } };
  }
  config.checkerScript ??= '.claude/skills/check-html-report/scripts/check_report.py';
  for (const key of ['reference', 'report', 'source', 'checkerSkill', 'checkerScript', 'verdict']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) return terminal(`配置缺少 ${key}。`);
    if (/^(?:\/|[A-Za-z]:)/.test(config[key]) || config[key].includes('\\')) {
      return terminal(`${key} 必须使用工作区内以 / 分隔的相对路径。`);
    }
    const parts = config[key].split('/').filter((part) => part && part !== '.');
    if (parts.includes('..') || parts.slice(0, 2).join('/') === '.ccui/report-quality-runs') {
      return terminal(`${key} 不能使用上级目录或 Hook 状态目录。`);
    }
    config[key] = parts.join('/');
  }
  const maxAttempts = config.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    return terminal('maxAttempts 必须是 1 到 20 的整数。');
  }
  const paths = {
    reference: config.reference, source: config.source, config: configPath,
    checkerSkill: config.checkerSkill, checkerScript: config.checkerScript,
  };
  if (new Set([...Object.values(paths), config.report, config.verdict]).size !== 7) {
    return terminal('示例、报告、数据、校验器、配置和验收结果必须使用不同文件。');
  }
  const baseline = {};
  for (const [key, filePath] of Object.entries(paths)) {
    if (!(await ccui.workspace.exists(filePath))) {
      return terminal(`缺少 ${filePath}。请补齐真实数据或安装校验 skill 后重新运行；不能编造数据通过验收。`);
    }
    baseline[key] = await ccui.workspace.sha256(filePath);
  }
  if (!event.stop_hook_active || !state || state.closed) {
    state = { sessionId, attempts: 0, baseline, token: '', closed: false };
  }
  for (const [key, hash] of Object.entries(baseline)) {
    if (state.baseline?.[key] !== hash) {
      return terminal(`${paths[key]} 在修正过程中发生变化。请确认验收标准/真实数据后发送新消息重新开始；不要修改标准来通过检查。`);
    }
  }
  let issues = ['尚未执行本轮报告验收。'];
  let verdict = null;
  if (await ccui.workspace.exists(config.verdict)) {
    try { verdict = await ccui.workspace.readJson(config.verdict); }
    catch { issues = ['验收结果不是有效 JSON，请重新运行校验 skill。']; }
  }
  const reportExists = await ccui.workspace.exists(config.report);
  const hashes = { ...baseline, report: reportExists ? await ccui.workspace.sha256(config.report) : null };
  const fresh = state.token && verdict?.version === 1 && verdict.sessionId === sessionId
    && verdict.attemptToken === state.token
    && Object.entries(hashes).every(([key, hash]) => hash && verdict.fingerprints?.[key] === hash);
  if (fresh && verdict.passed === true && Array.isArray(verdict.issues) && verdict.issues.length === 0
      && ['structure', 'completeness', 'data'].every((key) => verdict.checks?.[key] === true)) {
    await ccui.workspace.writeJson(statePath, { ...state, closed: true, status: 'passed' });
    await ccui.log.info('报告验收通过', { sessionId, attempts: state.attempts, fingerprints: hashes });
    return { output: { status: 'passed', systemMessage: 'HTML 报告的结构、样式约束和本次数据已通过校验。' } };
  }
  if (fresh && Array.isArray(verdict.issues)) {
    issues = verdict.issues.slice(0, 20).map((issue) => String(issue?.message || issue).slice(0, 600));
    if (issues.length === 0) issues = ['校验结果未通过全部检查项，请重新运行校验器。'];
  } else if (state.token) issues = ['报告或验收结果已变化，或结果不属于本轮。必须重新执行校验 skill。'];
  if (!reportExists) issues.unshift(`尚未生成报告文件 ${config.report}。`);
  if (state.attempts >= maxAttempts) {
    await ccui.workspace.writeJson(statePath, { ...state, closed: true, status: 'failed', issues });
    return terminal(`已修正 ${maxAttempts} 轮仍未通过。${issues.join('；')} 请补充数据/要求后重试。`);
  }
  state.attempts += 1;
  state.token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await ccui.workspace.writeJson(statePath, state);
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const command = `python3 ${quote(config.checkerScript)} --config ${quote(configPath)} --session-id ${quote(sessionId)} --attempt-token ${quote(state.token)}`;
  await ccui.log.info('报告需要校验或修正', { sessionId, attempt: state.attempts, issues });
  return { output: {
    status: 'repairing', decision: 'block',
    reason: [
      `报告尚未通过验收（第 ${state.attempts}/${maxAttempts} 轮），继续当前会话。`,
      ...issues.map((issue) => `- ${issue}`),
      `读取并遵循 ${config.checkerSkill}。必要时使用 .claude/skills/generate-html-report/SKILL.md 修复 ${config.report}。`,
      `以 ${config.reference} 为格式示例、${config.source} 为本次数据真源；保持示例、数据、配置和校验器不变。`,
      `修正后实际运行以下命令（不要手写验收结果）：\n${command}`,
      `检查 ${config.verdict} 中的 issues 并继续修复。通过后才能结束；缺少真实数据时明确报告阻塞，不编造数据。`,
    ].join('\n'),
  } };
}

export const REPORT_QUALITY_HOOK_EXAMPLE = {
  id: 'html-report-quality',
  name: 'HTML 报告验收与修正',
  description: '读取工作区 .ccui/report-quality.json；Stop 时核对校验 skill 的验收结果和文件指纹，未通过则继续同一 agent 修正报告。',
  eventName: 'Stop',
  matcher: {},
  extensionLogic: {
    language: 'javascript',
    failClosed: true,
    code: reportQualityStop.toString().replace('function reportQualityStop(', 'function run('),
    outputs: [
      { name: 'status', type: 'string' },
      { name: 'decision', type: 'string' },
      { name: 'reason', type: 'string' },
      { name: 'continue', type: 'boolean' },
      { name: 'stopReason', type: 'string' },
      { name: 'systemMessage', type: 'string' },
    ],
  },
  postActions: [],
  claudeResponse: {
    bindings: Object.fromEntries(['decision', 'reason', 'continue', 'stopReason', 'systemMessage'].map((key) => [
      key, { source: 'reference', path: `script.output.${key}` },
    ])),
  },
};
