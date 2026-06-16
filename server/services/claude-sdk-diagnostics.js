import { spawn as spawnChildProcess } from 'node:child_process';

const DEFAULT_TAIL_LIMIT = 64 * 1024;
const SECRET_ENV_NAME_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE)/i;
const SECRET_VALUE_MIN_LENGTH = 6;

function appendTail(current, chunk, limit) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  const next = `${current || ''}${text}`;
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactKnownValue(text, value, label) {
  const secret = String(value || '');
  if (secret.length < SECRET_VALUE_MIN_LENGTH) {
    return text;
  }
  return text.replace(new RegExp(escapeRegExp(secret), 'g'), `[REDACTED:${label}]`);
}

export function redactClaudeDiagnosticText(input, env = {}) {
  let output = String(input || '');

  for (const [name, value] of Object.entries(env || {})) {
    if (!SECRET_ENV_NAME_PATTERN.test(name) || value == null) {
      continue;
    }
    output = redactKnownValue(output, value, name);
  }

  return output
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/(x-api-key\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/(auth[_-]?token\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/(private[_-]?token\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/(user[_-]?key\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]');
}

export function redactClaudeDiagnosticValue(input, env = {}, seen = new WeakSet()) {
  if (typeof input === 'string') {
    return redactClaudeDiagnosticText(input, env);
  }
  if (input == null || typeof input !== 'object') {
    return input;
  }
  if (seen.has(input)) {
    return '[Circular]';
  }
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((entry) => redactClaudeDiagnosticValue(entry, env, seen));
  }
  if (input instanceof Date) {
    return input.toISOString();
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      redactClaudeDiagnosticValue(value, env, seen),
    ]),
  );
}

export function createClaudeProcessDiagnostics({
  tailLimit = DEFAULT_TAIL_LIMIT,
  spawnImpl = spawnChildProcess,
  env = {},
  logger = console,
} = {}) {
  let context = {};
  let redactionEnv = { ...env };
  let stdoutTail = '';
  let stderrTail = '';
  let lastSpawn = null;

  const updateContext = (nextContext = {}) => {
    context = {
      ...context,
      ...Object.fromEntries(
        Object.entries(nextContext).filter(([, value]) => value !== undefined),
      ),
    };
  };

  const addRedactionEnv = (nextEnv = {}) => {
    redactionEnv = { ...redactionEnv, ...nextEnv };
  };

  const appendOutput = (streamName, chunk) => {
    if (streamName === 'stderr') {
      stderrTail = appendTail(stderrTail, chunk, tailLimit);
      return;
    }
    stdoutTail = appendTail(stdoutTail, chunk, tailLimit);
  };

  const attachToChild = (child, spawnRecord) => {
    if (!child) {
      return child;
    }

    child.stdout?.on?.('data', (chunk) => appendOutput('stdout', chunk));
    child.stderr?.on?.('data', (chunk) => appendOutput('stderr', chunk));
    child.on?.('error', (error) => {
      spawnRecord.spawnError = error?.message || String(error);
      spawnRecord.endedAt = new Date().toISOString();
    });
    child.on?.('exit', (code, signal) => {
      spawnRecord.exitCode = code;
      spawnRecord.signal = signal;
      spawnRecord.endedAt = new Date().toISOString();
    });

    return child;
  };

  const createSpawn = (delegate) => {
    return (options = {}) => {
      const args = Array.isArray(options.args) ? options.args : [];
      const spawnRecord = {
        command: options.command,
        args,
        cwd: options.cwd,
        startedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        spawnError: null,
        endedAt: null,
      };
      lastSpawn = spawnRecord;

      try {
        const child = delegate
          ? delegate(options)
          : spawnImpl(options.command, args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        return attachToChild(child, spawnRecord);
      } catch (error) {
        spawnRecord.spawnError = error?.message || String(error);
        spawnRecord.endedAt = new Date().toISOString();
        throw error;
      }
    };
  };

  const snapshot = (extraContext = {}) => {
    const redactedStdoutTail = redactClaudeDiagnosticText(stdoutTail, redactionEnv).trimEnd();
    const redactedStderrTail = redactClaudeDiagnosticText(stderrTail, redactionEnv).trimEnd();
    const redactedSpawnError = redactClaudeDiagnosticText(lastSpawn?.spawnError || '', redactionEnv).trimEnd();

    const diagnostics = redactClaudeDiagnosticValue({
      ...context,
      ...extraContext,
      command: lastSpawn?.command || extraContext.command || context.command || null,
      args: Array.isArray(lastSpawn?.args)
        ? lastSpawn.args.map((arg) => redactClaudeDiagnosticText(arg, redactionEnv))
        : [],
      cwd: lastSpawn?.cwd || extraContext.cwd || context.cwd || null,
      startedAt: lastSpawn?.startedAt || null,
      endedAt: lastSpawn?.endedAt || null,
      exitCode: lastSpawn?.exitCode ?? null,
      signal: lastSpawn?.signal ?? null,
      spawnError: redactedSpawnError || null,
      stdoutTail: redactedStdoutTail || null,
      stderrTail: redactedStderrTail || null,
    }, redactionEnv);

    if (!diagnostics.stdoutTail) {
      delete diagnostics.stdoutTail;
    }
    if (!diagnostics.stderrTail) {
      delete diagnostics.stderrTail;
    }
    if (!diagnostics.spawnError) {
      delete diagnostics.spawnError;
    }

    return diagnostics;
  };

  return {
    updateContext,
    addRedactionEnv,
    appendOutput,
    createSpawn,
    redactText: (value) => redactClaudeDiagnosticText(value, redactionEnv),
    redactValue: (value) => redactClaudeDiagnosticValue(value, redactionEnv),
    snapshot,
    logSnapshot(reason, extraContext = {}) {
      try {
        logger?.warn?.('[claude-sdk] process diagnostics', {
          reason,
          diagnostics: snapshot(extraContext),
        });
      } catch {
        // Diagnostic logging must never mask the original SDK failure.
      }
    },
  };
}
