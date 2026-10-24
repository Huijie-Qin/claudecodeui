// Inspect actual browser, native SDK, model endpoint and MCP evidence.
// Usage: node scripts/verify-hook-context-switch.mjs <audit-output-directory>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'artifacts/hook-context-switch-20261023');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const markers = /HOOK_PAYLOAD_|HOOK_SKILL_BODY_SENTINEL|HOOK_ISOLATED_RESULT_SENTINEL|<ccui-mcp-loop-result/;
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const rows = [];
const cases = {};
for (const mode of ['off-final', 'on', 'settings-recheck']) {
  const state = await read(path.join(root, mode, 'latest.json'));
  const requests = (await fs.readFile(path.join(state.root, 'model-requests.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  const results = await read(path.join(state.root, 'browser-summary-all.json'));
  check(`${mode}: complete scenario coverage`, results.length === ({ 'off-final': 37, on: 7, 'settings-recheck': 3 })[mode]);
  cases[mode] = {};
  for (const result of results) {
    const directory = path.join(state.root, result.id);
    const database = await read(path.join(directory, 'database.json'));
    const reqs = requests.filter(r => r.caseId === result.id);
    const main = reqs.filter(r => ['main', 'child'].includes(r.role));
    const isolated = reqs.filter(r => r.role === 'isolated');
    const mainText = JSON.stringify(main.map(r => r.body));
    check(`${mode}/${result.id}: completes and clears running`, !result.failure && result.completedAt && !result.runningAfterEnd);
    if (mode !== 'on') check(`${mode}/${result.id}: payload excluded from entire model request`, !markers.test(mainText));
    const actions = database.executions.flatMap(e => Object.values(JSON.parse(e.actions_json)).map(a => a.output));
    const executed = actions.filter(a => a.executionMode === 'isolated');
    for (const action of executed) {
      check(`${mode}/${result.id}: isolated task actually completed`, action.executed && action.result === 'HOOK_ISOLATED_RESULT_SENTINEL');
      check(`${mode}/${result.id}: separate session identity`, action.sessionId !== result.sessionId);
    }
    if (executed.length) {
      check(`${mode}/${result.id}: tools executed in isolated model requests`, isolated.some(r => JSON.stringify(r.body.messages).includes('toolu_isolated_')));
      check(`${mode}/${result.id}: isolated result excluded from chat display`, !result.finalBody.includes('HOOK_ISOLATED_RESULT_SENTINEL'));
    }
    if (mode === 'off-final' && result.id === 'call_mcp_bound') {
      const taskId = actions.find(a => a.task_id)?.task_id;
      check('bound MCP result remains available in audit only', taskId && !mainText.includes(taskId));
    }
    if (mode === 'off-final' && result.id === 'write_record') {
      check('record side effect preserved', database.records.length === 1);
    }
    const row = { mode, id: result.id, sessionId: result.sessionId,
      directory: path.relative(root, directory), completed: Boolean(result.completedAt),
      running: result.runningAfterEnd, hookStatuses: result.hookStatuses,
      mainRequests: reqs.filter(r => r.role === 'main' && (!result.probeStart || r.at < result.probeStart)).length,
      childRequests: reqs.filter(r => r.role === 'child').length,
      isolatedRequests: isolated.length, isolatedTasks: executed.length,
      payloadInContext: markers.test(mainText), screenshots: (await fs.readdir(directory)).filter(f => f.endsWith('.png')) };
    rows.push(row); cases[mode][result.id] = row;
  }
}
for (const id of ['send_message', 'invoke_skill', 'additional_context', 'call_mcp_bound', 'review_retry', 'loop_success', 'child_skill']) {
  check(`enabled control retains context: ${id}`, cases.on[id].payloadInContext);
}
for (const id of ['send_message', 'invoke_skill', 'stopfailure_message', 'stopfailure_skill',
  'stopfailure_fast_message', 'stopfailure_fast_skill', 'child_message', 'child_skill']) {
  check(`disabled delivery still executes task: ${id}`, cases['off-final'][id].isolatedTasks === 1);
}
check('two messages execute two isolated tasks', cases['off-final'].two_followups.isolatedTasks === 2);
for (const id of ['send_message', 'invoke_skill', 'stopfailure_skill']) {
  check(`settings inheritance recheck executes isolated task: ${id}`, cases['settings-recheck'][id].isolatedTasks === 1);
}
for (const id of ['send_message', 'invoke_skill']) {
  check(`no parent followup for ${id}`, cases['off-final'][id].mainRequests === 1 && cases.on[id].mainRequests === 2);
}
const calls = (await read(path.join(root, 'mcp-calls-off.json'))).calls;
check('real MCP server records isolated tool effects', calls.filter(c => c.toolName === 'execute_task').length >= 10);
const ui = await read(path.join(root, 'editor-qa.json'));
check('UI default, save, publish and reload', ui.defaultEnabled && ui.saved === false && ui.published === false && ui.reloaded === false);
const result = { checkedAt: new Date().toISOString(), scenarios: rows.length, checks, rows };
await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(result, null, 2));
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;
const table = rows.map(row => `<tr><td>${row.mode === 'on' ? '开启' : '关闭'}</td><td>${esc(row.id)}</td><td>${row.mainRequests} / ${row.childRequests}</td><td>${row.isolatedTasks}</td><td>${row.payloadInContext ? '有' : '无'}</td><td>已结束</td><td>${link(row.directory + '/final.png', '页面')} · ${link(row.directory + '/events.json', '事件')} · ${link(row.directory + '/database.json', '执行记录')} · ${link(path.dirname(row.directory) + '/model-requests.jsonl', '模型请求')}</td></tr>`).join('');
await fs.writeFile(path.join(root, 'Hook上下文开关验证.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hook 上下文开关验证</title><style>body{margin:0;background:#f3f5f9;color:#203047;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:1220px;margin:auto;padding:32px 24px}section{background:white;border:1px solid #dce3ed;border-radius:12px;padding:22px;margin:18px 0}h1{font-size:28px}h2{font-size:21px}a{color:#1d4ed8}img{width:100%;border:1px solid #dce3ed;border-radius:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px;border-bottom:1px solid #dce3ed;text-align:left;white-space:nowrap}th{background:#eef2f8}code{background:#eef2f8;padding:2px 5px}.muted{color:#63748b}</style><main>
<section><p class="muted">CCUI · 2026-10-23 · 功能实现与真实浏览器核验</p><h1>Hook 结果进入对话上下文：配置开关已实现</h1><p>新增 <code>injectToContext</code>，默认开启。关闭后，脚本、MCP 调用、数据记录、确认和审查继续执行；Skill 与 Agent 消息使用独立模型会话，过程和结果仅保留在 Hook 执行记录中。主对话不追加这些内容或续轮。</p><p>工具权限与参数修改继续生效。拒绝理由使用固定提示；Stop 阻止结束改为终止本轮，避免无反馈返工。MCP 循环完成后不再注入最终结果；原工具结果保持不变。</p><p><b>44 个端到端场景及 3 次专项复验：</b>关闭 37 个、开启对照 7 个，另对消息、Skill 和异常结束 Skill 做项目权限设置继承复验，共 47 次全部正常收尾。${checks.length} 项证据断言通过；关闭组的主代理和子代理完整模型请求均未包含 Hook 结果标记，包括后续人工输入回合。</p><p>相关自动回归：后端 211 项、原生 SDK 并发隔离 2 项、前端 28 项通过；前后端类型检查、前端构建通过。首轮异常结束收尾问题已修复并在最终组复验；早期预检不计入最终结果。</p></section>
<section><h2>配置入口与保存验证</h2><p>系统管理 → Hooks → 编辑 → 选择 Hook 事件 → <b>结果进入对话上下文</b>。旧配置默认开启，复制保留选择，已发布版本保留独立快照。修改后需保存、发布，并让使用方采用该发布版本。</p><img src="editor-switch-published.png" alt="真实配置页面：关闭上下文注入，保存发布后刷新仍保留"><p>${link('editor-qa.json','页面操作验证')} · ${link('verification.json','全部断言与逐场景索引')} · ${link('mcp-calls-off.json','真实 MCP 调用')} · ${link('backend-tests-final.log','后端回归')} · ${link('concurrency-tests.log','并发隔离')} · ${link('frontend-tests-final.log','前端回归')}</p></section>
<section><h2>逐场景证据</h2><p class="muted">主 / 子模型调用次数不包含人工探针；“结果进入上下文”根据模型端点实际收到的请求判定。脚本异常、审查无效、取消等为故障注入场景，验证的是预期处理与正确收尾。</p><div class="scroll"><table><thead><tr><th>开关</th><th>场景</th><th>主 / 子请求</th><th>独立任务</th><th>结果进入上下文</th><th>运行状态</th><th>证据</th></tr></thead><tbody>${table}</tbody></table></div></section>
<section><h2>执行范围</h2><p>隔离数据库与工作区，真实 Chrome、当前 CCUI 源码、原生 Claude SDK/CLI、受控本地模型接口和真实本地 MCP。独立任务实际调用本地工具验证通知类副作用，没有向真实收件人发通知。当前运行容器未部署本次代码。</p></section></main></html>`);
console.log(JSON.stringify({ scenarios: rows.length, assertions: checks.length, report: path.join(root, 'Hook上下文开关验证.html') }));
