const fs = require('fs');
const path = require('path');

let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    const toolName = event.tool_name || event.toolName || '';
    const toolInput = event.tool_input || event.toolInput || {};

    const match = toolName.match(/^mcp__(.+?)__(.+)$/);
    if (!match) {
      process.exit(0);
      return;
    }

    const [, serverName, mcpToolName] = match;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const configPath = path.join(projectDir, '.claude', 'mcp-tool-overrides.local.json');

    if (!fs.existsSync(configPath)) {
      process.exit(0);
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const params = config?.mcpServers?.[serverName]?.tools?.[mcpToolName]?.params || {};
    const mergedInput = { ...toolInput };

    for (const [key, entry] of Object.entries(params)) {
      if (!entry || entry.custom !== true) continue;

      // Keep explicit model/user supplied values for the puncture test.
      if (Object.prototype.hasOwnProperty.call(mergedInput, key)) continue;

      mergedInput[key] = entry.value;
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: mergedInput
      }
    }));
  } catch (error) {
    process.stderr.write(`mcp override hook failed: ${error.message}\n`);
    process.exit(0);
  }
});
