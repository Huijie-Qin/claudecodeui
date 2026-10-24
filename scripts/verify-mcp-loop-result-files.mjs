// Check persisted results, actual model requests, native Read results and UI completion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'artifacts/hook-loop-result-files-20261023');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const checks = [];
const rows = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
function strings(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
function references(body) {
  return [...new Set(strings(body).flatMap(text => [...text.matchAll(/\{"resultFile":("(?:[^"\\]|\\.)*")\}/g)]
    .map(match => JSON.parse(match[1]))))];
}
for (const mode of ['on', 'off', 'bound']) {
  const state = await read(path.join(root, mode, 'latest.json'));
  const results = await read(path.join(state.root, 'browser-summary-all.json'));
  const requests = (await fs.readFile(path.join(state.root, 'model-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  check(`${mode}: expected scenarios`, results.length === ({ on: 9, off: 3, bound: 1 })[mode]);
  for (const result of results) {
    const dir = path.join(state.root, result.id);
    const evidence = await read(path.join(dir, 'database.json'));
    const events = await read(path.join(dir, 'events.json'));
    const reqs = requests.filter(request => request.caseId === result.id);
    const refs = [...new Set(reqs.flatMap(request => references(request.body)))];
    const noDelivery = mode === 'off' || ['loop_abort', 'loop_write_failure'].includes(result.id);
    check(`${mode}/${result.id}: complete and clear running`, !result.failure && result.completedAt && !result.runningAfterEnd);
    check(`${mode}/${result.id}: no browser errors`, result.errors.length === 0);
    const finalStatus = (result.finalStatus || []).map(event => event.message);
    check(`${mode}/${result.id}: server confirms processing stopped`,
      finalStatus.some(message => message.type === 'session-status' && message.sessionId === result.sessionId && message.isProcessing === false));
    check(`${mode}/${result.id}: session and concurrency lease released`,
      finalStatus.some(message => message.type === 'active-sessions' && !message.sessions.claude.includes(result.sessionId)
        && message.concurrency.activeCount === 0 && message.concurrency.activeLeases.length === 0));
    check(`${mode}/${result.id}: loop really ran`, evidence.loops.length === (result.id === 'loop_parallel' ? 2 : 1));
    const files = [];
    const readCalls = new Map();
    const readResults = new Map();
    for (const request of reqs) {
      for (const block of request.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])) {
        if (block.type === 'tool_use' && block.name === 'Read' && block.id?.startsWith('toolu_read_loop_')) readCalls.set(block.id, block);
        if (block.type === 'tool_result' && block.tool_use_id?.startsWith('toolu_read_loop_')) readResults.set(block.tool_use_id, block);
      }
    }
    for (const job of evidence.loops) {
      const expectedStatus = ({ loop_failed: 'failed', loop_timeout: 'timed_out', loop_cancel: 'cancelled', loop_abort: 'cancelled' })[result.id] || 'succeeded';
      check(`${mode}/${result.id}/${job.id}: original session and terminal job preserved`,
        job.session_id === result.sessionId && job.status === expectedStatus);
      const file = path.join(state.workspace.path, '.cloudcli', 'hook-results', 'mcp-loops', `${job.id}.json`);
      if (['loop_abort', 'loop_write_failure'].includes(result.id)) continue;
      const payload = await read(file);
      check(`${mode}/${result.id}/${job.id}: file matches actual final MCP result`,
        JSON.stringify(payload.result) === JSON.stringify(JSON.parse(job.last_result_json)));
      check(`${mode}/${result.id}/${job.id}: file carries correct identity and terminal status`,
        payload.replacesToolUseId === job.tool_use_id && payload.status === job.status && payload.attempts === job.attempt_count);
      files.push(path.relative(root, file));
      if (!noDelivery) {
        check(`${mode}/${result.id}/${job.id}: delivered file exists in model request`, refs.includes(file));
        const call = [...readCalls.values()].find(block => block.input.file_path === file);
        const readResult = readResults.get(call?.id);
        check(`${mode}/${result.id}/${job.id}: exact file was read without a tool error`, call && readResult && !readResult.is_error);
        const content = (typeof readResult.content === 'string' ? readResult.content : strings(readResult.content).join('\n'))
          .replace(/^\s*\d+\t/gm, '').trim();
        check(`${mode}/${result.id}/${job.id}: actual Read returned the complete matching JSON`,
          JSON.stringify(JSON.parse(content)) === JSON.stringify(payload));
      }
    }
    for (const request of reqs) {
      // Legitimate Read tool results may contain the file body. Keep checking
      // every other message even after the first file in a parallel batch is read.
      const withoutReadResults = { ...request.body, messages: request.body.messages.map(message => ({
        ...message,
        content: Array.isArray(message.content) ? message.content.filter(block => !(
          block.type === 'tool_result' && readCalls.has(block.tool_use_id)
        )) : message.content,
      })) };
      check(`${mode}/${result.id}: no automatic result body outside actual Read results`,
        !strings(withoutReadResults).some(text => /"mcpLoop"\s*:\s*true/.test(text)));
      for (const job of evidence.loops) {
        const payload = JSON.parse(job.last_result_json);
        const finalResult = JSON.stringify(payload);
        if (job.status === 'succeeded' || job.status === 'failed') {
          check(`${mode}/${result.id}: final business result absent outside actual Read results`,
            !strings(withoutReadResults).some(text => text.includes(finalResult)));
          check(`${mode}/${result.id}: terminal-only value absent outside actual Read results`,
            payload.finished_at_ms != null
            && !JSON.stringify(withoutReadResults).includes(String(payload.finished_at_ms)));
        }
      }
    }
    const replacements = events.map(event => event.message).filter(message => message?.mcpLoopReplacement);
    for (const message of replacements) {
      check(`${mode}/${result.id}: chat replacement contains only a file path`,
        Object.keys(message.toolUseResult || {}).join(',') === 'resultFile');
    }
    if (noDelivery) {
      check(`${mode}/${result.id}: no result path injected`, refs.length === 0);
      check(`${mode}/${result.id}: no result file read triggered`, readCalls.size === 0);
    }
    else {
      check(`${mode}/${result.id}: file references belong only to this session's jobs`,
        refs.length === files.length && refs.every(file => files.includes(path.relative(root, file))));
      check(`${mode}/${result.id}: native Read actually succeeds`,
        reqs.some(request => strings(request.body).some(text => text.includes('"mcpLoop": true')))
        && reqs.some(request => strings(request.body).some(text => text.includes('AUDIT_RESULT_FILE_READ_OK'))));
      check(`${mode}/${result.id}: no failed file reads`, !JSON.stringify(reqs).includes('AUDIT_RESULT_FILE_READ_FAILED'));
    }
    if (result.id === 'loop_write_failure') check('write failure ends explicitly without a payload fallback',
      events.some(event => event.message?.code === 'MCP_LOOP_RESUME_FAILED'));
    if (['loop_cancel', 'loop_abort'].includes(result.id)) check(`${result.id}: cancellation was actually clicked`, result.interacted);
    rows.push({ mode, id: result.id, sessionId: result.sessionId, files, references: refs.length,
      nativeRead: !noDelivery, running: result.runningAfterEnd, directory: path.relative(root, dir) });
  }
}
const dockerLog = await fs.readFile(path.join(root, 'docker-read.log'), 'utf8');
check('Docker mapped path readable by non-root runtime user', dockerLog.includes('uid=10001') && dockerLog.includes('CONTAINER_FILE_READ_OK'));
const ui = await read(path.join(root, 'ui-qa.json'));
check('reloaded history result viewer contains only the file reference', ui.reloadedHistory && ui.dialogContainsOnlyFileReference);
const testLog = await fs.readFile(path.join(root, 'tests.log'), 'utf8');
const testCount = Number(testLog.match(/tests (\d+)/)?.[1]);
check('automated regressions pass', testCount > 150 && /fail 0/.test(testLog));
for (const log of ['typecheck.log', 'lint.log']) check(`${log}: clean`, !(await fs.readFile(path.join(root, log), 'utf8')).trim());
const sourceVerificationPath = path.join(root, 'source-verification.json');
const sourceVerification = await read(sourceVerificationPath).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (sourceVerification) check('tested source matches current workspace',
  sourceVerification.filesChecked > 0 && sourceVerification.mismatches.length === 0);
await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, rows, testCount }, null, 2));
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;
const table = rows.map(row => `<tr><td>${row.mode === 'off' ? '关闭' : row.mode === 'bound' ? '开启＋显式绑定' : '开启'}</td><td>${esc(row.id)}</td><td>${row.files.map(file => link(file, 'JSON')).join(' · ') || '停止或写入失败'}</td><td>${row.references}</td><td>${row.nativeRead ? '读取成功' : '未回传'}</td><td>已结束</td><td>${link(row.directory + '/final.png', '页面')} · ${link(row.directory + '/events.json', '事件')} · ${link(row.directory + '/database.json', '任务记录')} · ${link(path.dirname(row.directory) + '/model-requests.jsonl', '模型请求')}</td></tr>`).join('');
await fs.writeFile(path.join(root, '循环任务结果文件验证.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>循环任务结果文件验证</title><style>body{margin:0;background:#f3f5f9;color:#203047;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:1220px;margin:auto;padding:28px 24px}section{background:white;border:1px solid #dce3ed;border-radius:12px;padding:22px;margin:18px 0}h1{font-size:28px}h2{font-size:21px}a{color:#1d4ed8}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px;border-bottom:1px solid #dce3ed;text-align:left;white-space:nowrap}th{background:#eef2f8}code{background:#eef2f8;padding:2px 5px}img{max-width:100%;border:1px solid #dce3ed;border-radius:8px}.muted{color:#63748b}</style><main>
<section><p class="muted">CCUI · 2026-10-23 · 当前源码隔离验证</p><h1>循环终态存文件，主会话只收到路径</h1><p>完整终态 JSON 写入当前工作区 <code>.cloudcli/hook-results/mcp-loops/&lt;jobId&gt;.json</code>。主会话恢复消息、子代理工具替换和聊天页面结果只包含 <code>resultFile</code>；不会自动附带结果正文、错误正文或轮询过程。</p><p>主/子代理可按需使用 Read 读取文件，读取后内容作为正常工具结果进入上下文。关闭“结果进入对话上下文”时仍保存文件，但路径也不回传。用户停止整个会话后不续轮；文件写入失败明确报错收尾，不回退到正文注入。</p><p><b>${rows.length} 个浏览器场景、${checks.length} 项证据断言、${testCount} 项自动回归通过。</b>模型请求证实首次收到路径时未带入结果正文；原生 Read 实际读取成功。非 root Docker 用户也能读取映射后的 <code>/workspace/...</code> 路径。类型检查及 lint 通过。</p></section>
<section><h2>逐场景证据</h2><p>使用真实 Chrome、当前 CCUI、原生 Claude SDK/CLI、受控本地模型和真实本地 MCP。失败/超时/写入失败是主动故障注入，验收预期处理及 running 收尾。每个文件与数据库中的真实最终 MCP 结果逐一比对。</p><div class="scroll"><table><thead><tr><th>回传设置</th><th>场景</th><th>结果文件</th><th>路径数</th><th>Read</th><th>运行状态</th><th>证据</th></tr></thead><tbody>${table}</tbody></table></div></section>
<section><h2>历史页面实际展示</h2><p>重新加载原会话并打开“查看结果”，JSON 查看器中仅包含 resultFile。</p><img src="result-dialog.png" alt="历史会话的实际结果查看器，只显示结果文件路径"><p>${link('ui-qa.json','页面复验记录')}</p></section>
<section><h2>测试记录</h2><p>${link('verification.json','全部断言')} · ${link('tests.log','自动回归')} · ${link('docker-read.log','容器读取')} · ${link('typecheck.log','类型检查')} · ${link('lint.log','lint')}${sourceVerification ? ' · ' + link('source-verification.json','当前源码一致性') : ''}</p><p>本次未部署到正在运行的容器。此前“上下文开关验证”报告是改动前的历史证据，本报告记录新的文件回传行为。</p></section></main></html>`);
console.log(JSON.stringify({ scenarios: rows.length, assertions: checks.length, testCount }));
