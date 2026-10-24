// Controlled inputs for real CCUI + native Claude SDK + browser verification.
const literal = value => ({ source: 'literal', value });
const ref = path => ({ source: 'reference', path });
const action = (type, config) => ({ id: type, type, config });
const marker = id => `HOOK_PAYLOAD_${id.toUpperCase()}`;
const script = (extra = '', outputs = []) => ({ language: 'javascript',
  code: `async function run(event, ccui) { const until = Date.now() + 600; while (Date.now() < until) {} ${extra || 'return {output:{}};'} }`, outputs });
const toolMatcher = { mode: 'exact', value: 'mcp__processing_repro__execute_task' };
const base = (id, eventName = 'Stop', extra = {}) => ({ id, mode: 'plain', marker: marker(id),
  hook: { name: `Audit ${id}`, eventName, includeSubagents: false, matcher: {},
    extensionLogic: script(), postActions: [], claudeResponse: { bindings: {} }, ...extra } });
const toolCase = (id, extra = {}) => ({ ...base(id, 'PostToolUse', { matcher: toolMatcher, ...extra }), mode: 'tool' });
const mcpAction = action('call_mcp_tool', { mcpServerId: 'processing_repro',
  toolName: 'mcp__processing_repro__execute_task', inputs: { should_fail: literal(false) } });
const loop = id => ({ ...base(id, 'PostToolUse', {
  matcher: { mode: 'exact', value: 'mcp__processing_repro__get_task_status' },
  postActions: [action('mcp_loop_run', { pollIntervalMs: 1000, perCallTimeoutMs: 5000,
    maxWaitMs: id === 'loop_timeout' ? 3000 : 30000, waitingLabel: `Audit ${id}`,
    terminationScript: 'async def run(event, ccui):\n    status = (event.get("result") or {}).get("status")\n    return {"output":{"status":status if status in ("success","failed") else "running"}}\n' })],
}), mode: 'loop', interaction: id === 'loop_cancel' ? 'cancel-loop' : id === 'loop_abort' ? 'abort' : null });
export const AUDIT_CASES = [
  { id: 'baseline', mode: 'plain', hook: null },
  base('write_record', 'Stop', { postActions: [action('write_record', {
    recordType: 'hook-audit', fields: { payload: literal(marker('write_record')) } })] }),
  toolCase('call_mcp_unbound', { postActions: [mcpAction] }),
  toolCase('call_mcp_bound', { postActions: [mcpAction], claudeResponse: { bindings: {
    'hookSpecificOutput.additionalContext': { source: 'template', template: 'HOOK_PAYLOAD_CALL_MCP_BOUND {{actions.call_mcp_tool.output}}' },
  } } }),
  base('send_message', 'Stop', { postActions: [action('send_agent_message', {
    messageTemplate: marker('send_message') })] }),
  base('invoke_skill', 'Stop', { postActions: [action('invoke_skill', {
    skillId: 'builtin:hook-audit', skillName: 'hook-audit', argumentsTemplate: marker('invoke_skill') })] }),
  ...['review_pass', 'review_retry', 'review_cap', 'review_invalid'].map(id => base(id, 'Stop', {
    postActions: [action('review_completion', { maxReviews: 2, criteria: `Audit ${id}` })] })),
  ...['confirmation_allow', 'confirmation_deny'].map(id => ({ ...base(id, 'PreToolUse', {
    matcher: toolMatcher, postActions: [action('request_confirmation', { messageTemplate: marker(id) })],
  }), mode: 'tool', interaction: id.endsWith('allow') ? 'allow' : 'deny' })),
  ...['loop_success', 'loop_failed', 'loop_timeout', 'loop_cancel', 'loop_abort', 'loop_reload'].map(loop),
  { ...loop('loop_parallel'), mode: 'loop_parallel' },
  loop('loop_write_failure'),
  toolCase('additional_context', { claudeResponse: { bindings: {
    'hookSpecificOutput.additionalContext': literal(marker('additional_context')),
  } } }),
  toolCase('updated_output', { claudeResponse: { bindings: {
    'hookSpecificOutput.updatedMCPToolOutput': literal([{ type: 'text', text: marker('updated_output') }]),
  } } }),
  { ...base('updated_input', 'PreToolUse', { matcher: toolMatcher, claudeResponse: { bindings: {
    'hookSpecificOutput.updatedInput': literal({ should_fail: true }),
    'hookSpecificOutput.permissionDecision': literal('allow'),
  } } }), mode: 'tool' },
  { ...base('permission_deny', 'PreToolUse', { matcher: toolMatcher, claudeResponse: { bindings: {
    'hookSpecificOutput.permissionDecision': literal('deny'),
    'hookSpecificOutput.permissionDecisionReason': literal(marker('permission_deny')),
  } } }), mode: 'tool' },
  base('stop_block_once', 'Stop', { extensionLogic: script(
    'return {output:{decision: ccui.env.hookInvocationCount < 2 ? "block" : "approve"}};', [{ name: 'decision', type: 'string' }]),
    claudeResponse: { bindings: { decision: ref('script.output.decision'), reason: literal(marker('stop_block_once')) } } }),
  base('continue_false', 'Stop', { claudeResponse: { bindings: {
    continue: literal(false), stopReason: literal(marker('continue_false')),
  } } }),
  base('system_message', 'Stop', { claudeResponse: { bindings: { systemMessage: literal(marker('system_message')) } } }),
  base('script_error', 'Stop', { extensionLogic: script('throw new Error("HOOK_PAYLOAD_SCRIPT_ERROR");') }),
  base('condition_false', 'Stop', { postActions: [action('send_agent_message', {
    condition: literal(false), messageTemplate: marker('condition_false') })] }),
  base('two_followups', 'Stop', { postActions: [
    { ...action('send_agent_message', { messageTemplate: 'HOOK_PAYLOAD_TWO_FOLLOWUPS_A' }), id: 'first' },
    { ...action('send_agent_message', { messageTemplate: 'HOOK_PAYLOAD_TWO_FOLLOWUPS_B' }), id: 'second' },
  ] }),
  base('stop_block_repeated', 'Stop', { claudeResponse: { bindings: {
    decision: literal('block'), reason: literal(marker('stop_block_repeated')),
  } } }),
  base('submit_context', 'UserPromptSubmit', { claudeResponse: { bindings: {
    'hookSpecificOutput.additionalContext': literal(marker('submit_context')),
  } } }),
  base('stopfailure_message', 'StopFailure', { postActions: [action('send_agent_message', {
    messageTemplate: marker('stopfailure_message') })] }),
  base('stopfailure_skill', 'StopFailure', { postActions: [action('invoke_skill', {
    skillId: 'builtin:hook-audit', skillName: 'hook-audit', argumentsTemplate: marker('stopfailure_skill') })] }),
  base('stopfailure_fast_message', 'StopFailure', { extensionLogic: null,
    postActions: [action('send_agent_message', {messageTemplate:marker('stopfailure_fast_message')})] }),
  base('stopfailure_fast_skill', 'StopFailure', { extensionLogic: null,
    postActions: [action('invoke_skill', {skillId:'builtin:hook-audit',skillName:'hook-audit',argumentsTemplate:marker('stopfailure_fast_skill')})] }),
  ...['child_message', 'child_skill'].map(id => ({ ...base(id, 'Stop', {
    includeSubagents: true,
    extensionLogic: script('return {output:{child:Boolean(event.agent_id)}};', [{name:'child',type:'boolean'}]),
    postActions: [id === 'child_message'
      ? action('send_agent_message', {condition:ref('script.output.child'),messageTemplate:marker(id)})
      : action('invoke_skill', {condition:ref('script.output.child'),skillId:'builtin:hook-audit',skillName:'hook-audit',argumentsTemplate:marker(id)})],
  }), mode:'child' })),
  { ...loop('child_loop'), mode:'child_loop', hook:{...loop('child_loop').hook,includeSubagents:true} },
  { ...loop('child_loop_bound'), mode:'child_loop', hook:{...loop('child_loop_bound').hook,includeSubagents:true,
    claudeResponse: { bindings: { 'hookSpecificOutput.additionalContext': {
      source: 'template', template: 'Loop action reference: {{actions.mcp_loop_run.output}}',
    } } },
  } },
];
