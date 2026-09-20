# Paste this file into the CCUI advanced Python Hook editor.
# No imports, import-allowlist changes, print(), or interactive input() are needed.


def result(decision, reason, tool_name="", tool_input=None, matched=False):
    return {"output": {
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
        "matched": matched,
        "toolName": tool_name,
        "toolInput": tool_input if isinstance(tool_input, dict) else {},
    }}


async def run(event, ccui):
    if not isinstance(event, dict):
        return result("deny", "调用事件格式无效，无法展示参数，本次调用已拒绝。")
    if event.get("hook_event_name") != "PreToolUse":
        return result("defer", "不是工具执行前事件，继续原有权限流程。")

    tool_name = event.get("tool_name")
    if not isinstance(tool_name, str) or not tool_name:
        return result("deny", "缺少有效工具名称，无法确认本次调用。")
    if not tool_name.startswith("mcp__"):
        return result("defer", "不是 MCP 工具，继续原有权限流程。", tool_name)

    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return result("deny", "MCP 工具参数必须是 JSON 对象，无法确认本次调用。",
                      tool_name, matched=True)

    # The host records structured parameters before forwarding the ask decision.
    # Its permission UI displays the current call and waits for the user's choice.
    await ccui.log.info("MCP 调用前参数确认", {
        "toolName": tool_name,
        "toolInput": tool_input,
    })
    return result("ask", "即将调用 MCP 工具，参数已展示。请确认是否执行本次调用。",
                  tool_name, tool_input, matched=True)
