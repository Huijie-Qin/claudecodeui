import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { recordProviderSession } from './services/session-ownership.js';
import { createNormalizedMessage } from './shared/utils.js';

// Use cross-spawn on Windows for better command execution
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

let activeCursorProcesses = new Map(); // Track active processes by session ID

const WORKSPACE_TRUST_PATTERNS = [
  /workspace trust required/i,
  /do you trust the contents of this directory/i,
  /working with untrusted contents/i,
  /pass --trust,\s*--yolo,\s*or -f/i
];

function isWorkspaceTrustPrompt(text = '') {
  if (!text || typeof text !== 'string') {
    return false;
  }

  return WORKSPACE_TRUST_PATTERNS.some((pattern) => pattern.test(text));
}

async function spawnCursor(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, skipPermissions, model, sessionSummary } = options;
    const clientSessionId = typeof options.clientSessionId === 'string' ? options.clientSessionId : null;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    let hasRetriedWithTrust = false;
    let settled = false;

    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedShellCommands: [],
      skipPermissions: false
    };

    // Build Cursor CLI command
    const baseArgs = [];

    // Build flags allowing both resume and prompt together (reply in existing session)
    // Treat presence of sessionId as intention to resume, regardless of resume flag
    if (sessionId) {
      baseArgs.push('--resume=' + sessionId);
    }

    if (command && command.trim()) {
      // Provide a prompt (works for both new and resumed sessions)
      baseArgs.push('-p', command);

      // Add model flag if specified (only meaningful for new sessions; harmless on resume)
      if (!sessionId && model) {
        baseArgs.push('--model', model);
      }

      // Request streaming JSON when we are providing a prompt
      baseArgs.push('--output-format', 'stream-json');
    }

    // Add skip permissions flag if enabled
    if (skipPermissions || settings.skipPermissions) {
      baseArgs.push('-f');
      console.log('Using -f flag (skip permissions)');
    }

    // Use cwd (actual project directory) instead of projectPath
    const workingDir = cwd || projectPath || process.cwd();

    // Store process reference for potential abort
    const processKey = capturedSessionId || Date.now().toString();
    recordProviderSession({ options, provider: 'cursor', providerSessionId: capturedSessionId, status: 'active' });

    const settleOnce = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const runCursorProcess = (args, runReason = 'initial') => {
      const isTrustRetry = runReason === 'trust-retry';
      let runSawWorkspaceTrustPrompt = false;
      let stdoutLineBuffer = '';
      let terminalResult = null;
      let stderrBuffer = '';
      let terminalNotificationSent = false;
      let processErrored = false;
      let runningProcessError = null;

      const notifyTerminalState = ({ code = null, error = null } = {}) => {
        if (terminalNotificationSent) {
          return;
        }

        terminalNotificationSent = true;

        const finalSessionId = capturedSessionId || sessionId || processKey;
        if (cursorProcess.wasAborted) {
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'cursor',
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            stopReason: 'aborted'
          });
          return;
        }
        if (code === 0 && !error) {
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'cursor',
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
          return;
        }

        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'cursor',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          error: error || `Cursor CLI exited with code ${code}`
        });
      };

      if (isTrustRetry) {
        console.log('Retrying Cursor CLI with --trust after workspace trust prompt');
      }

      console.log('Spawning Cursor CLI:', 'cursor-agent', args.join(' '));
      console.log('Working directory:', workingDir);
      console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);

      const cursorProcess = spawnFunction('cursor-agent', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env } // Inherit all environment variables
      });

      activeCursorProcesses.set(capturedSessionId || processKey, cursorProcess);

      const shouldSuppressForTrustRetry = (text) => {
        if (hasRetriedWithTrust || args.includes('--trust')) {
          return false;
        }
        if (!isWorkspaceTrustPrompt(text)) {
          return false;
        }

        runSawWorkspaceTrustPrompt = true;
        return true;
      };

      const processCursorOutputLine = (line) => {
        if (!line || !line.trim()) {
          return;
        }

        try {
          const response = JSON.parse(line);
          console.log('Parsed JSON response:', response);

          // Handle different message types
          switch (response.type) {
            case 'system':
              if (response.subtype === 'init') {
                // Capture session ID
                if (response.session_id && !capturedSessionId) {
                  capturedSessionId = response.session_id;
                  console.log('Captured session ID:', capturedSessionId);
                  recordProviderSession({ options, provider: 'cursor', providerSessionId: capturedSessionId, status: 'active' });

                  // Update process key with captured session ID
                  if (processKey !== capturedSessionId) {
                    activeCursorProcesses.delete(processKey);
                    activeCursorProcesses.set(capturedSessionId, cursorProcess);
                  }

                  // Set session ID on writer (for API endpoint compatibility)
                  if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                    ws.setSessionId(capturedSessionId);
                  }

                  // Send session-created event only once for new sessions
                  if (!sessionId && !sessionCreatedSent) {
                    sessionCreatedSent = true;
                    ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, model: response.model, cwd: response.cwd, sessionId: capturedSessionId, clientSessionId, provider: 'cursor' }));
                  }
                }

                // System info — no longer needed by the frontend (session-lifecycle 'created' handles nav).
              }
              break;

            case 'user':
              // User messages are not displayed in the UI — skip.
              break;

            case 'assistant':
              // Accumulate assistant message chunks
              if (response.message && response.message.content && response.message.content.length > 0) {
                const normalized = sessionsService.normalizeMessage('cursor', response, capturedSessionId || sessionId || null);
                for (const msg of normalized) ws.send(msg);
              }
              break;

            case 'result': {
              // The CLI can emit its result before the child process exits.
              // Keep the UI active until the close event releases the slot.
              console.log('Cursor session result:', response);
              terminalResult = response;
              break;
            }

            default:
              // Unknown message types — ignore.
          }
        } catch (parseError) {
          console.log('Non-JSON response:', line);

          if (shouldSuppressForTrustRetry(line)) {
            return;
          }

          // If not JSON, send as stream delta via adapter
          const normalized = sessionsService.normalizeMessage('cursor', line, capturedSessionId || sessionId || null);
          for (const msg of normalized) ws.send(msg);
        }
      };

      // Handle stdout (streaming JSON responses)
      cursorProcess.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        console.log('Cursor CLI stdout:', rawOutput);

        // Stream chunks can split JSON objects across packets; keep trailing partial line.
        stdoutLineBuffer += rawOutput;
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processCursorOutputLine(line.trim());
        });
      });

      // Handle stderr
      cursorProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        console.error('Cursor CLI stderr:', stderrText);

        if (shouldSuppressForTrustRetry(stderrText)) {
          return;
        }

        stderrBuffer = `${stderrBuffer}${stderrText}`.slice(-10000);
      });

      // Handle process completion
      cursorProcess.on('close', async (code) => {
        if (processErrored) return;
        console.log(`Cursor CLI process exited with code ${code}`);

        // Flush any final unterminated stdout line before completion handling.
        if (stdoutLineBuffer.trim()) {
          processCursorOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeCursorProcesses.delete(finalSessionId);
        const aborted = Boolean(cursorProcess.wasAborted);
        const resultFailed = Boolean(terminalResult && (
          terminalResult.subtype !== 'success' || terminalResult.is_error === true
        ));
        const effectiveExitCode = !aborted && code === 0 && resultFailed ? 1 : code;
        recordProviderSession({
          options,
          provider: 'cursor',
          providerSessionId: finalSessionId,
          status: aborted ? 'aborted' : effectiveExitCode === 0 && !runningProcessError ? 'completed' : 'failed',
        });

        if (runningProcessError) {
          ws.send(createNormalizedMessage({ kind: 'error', content: runningProcessError.message, sessionId: finalSessionId, clientSessionId, provider: 'cursor' }));
          notifyTerminalState({ error: runningProcessError });
          settleOnce(() => reject(runningProcessError));
          return;
        }

        if (
          runSawWorkspaceTrustPrompt &&
          code !== 0 &&
          !hasRetriedWithTrust &&
          !args.includes('--trust')
        ) {
          hasRetriedWithTrust = true;
          runCursorProcess([...args, '--trust'], 'trust-retry');
          return;
        }

        const failureText = !aborted && effectiveExitCode !== 0
          ? stderrBuffer || (resultFailed && typeof terminalResult.result === 'string' ? terminalResult.result : '') || `Cursor CLI exited with code ${effectiveExitCode}`
          : null;
        if (failureText) {
          ws.send(createNormalizedMessage({ kind: 'error', content: failureText, sessionId: finalSessionId, clientSessionId, provider: 'cursor' }));
        }
        ws.send(createNormalizedMessage({
          kind: 'complete',
          exitCode: effectiveExitCode,
          resultText: typeof terminalResult?.result === 'string' ? terminalResult.result : '',
          isError: !aborted && effectiveExitCode !== 0,
          aborted,
          isNewSession: !sessionId && !!command,
          sessionId: finalSessionId,
          clientSessionId,
          provider: 'cursor',
        }));

        if (effectiveExitCode === 0 || aborted) {
          notifyTerminalState({ code: effectiveExitCode });
          settleOnce(() => resolve());
        } else {
          notifyTerminalState({ code: effectiveExitCode });
          settleOnce(() => reject(new Error(`Cursor CLI exited with code ${effectiveExitCode}`)));
        }
      });

      // Handle process errors
      cursorProcess.on('error', async (error) => {
        if (cursorProcess.pid) {
          runningProcessError = error;
          return;
        }
        processErrored = true;
        console.error('Cursor CLI process error:', error);

        // Clean up process reference on error
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeCursorProcesses.delete(finalSessionId);
        recordProviderSession({ options, provider: 'cursor', providerSessionId: finalSessionId, status: 'failed' });

        // Check if Cursor CLI is installed for a clearer error message
        const installed = await providerAuthService.isProviderInstalled('cursor');
        const errorContent = !installed
          ? 'Cursor CLI is not installed. Please install it from https://cursor.com'
          : error.message;

        ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: finalSessionId, clientSessionId, provider: 'cursor' }));
        notifyTerminalState({ error });
        settleOnce(() => reject(error));
      });

      // Close stdin since Cursor doesn't need interactive input
      cursorProcess.stdin.end();
    };

    runCursorProcess(baseArgs, 'initial');
  });
}

function abortCursorSession(sessionId) {
  const process = activeCursorProcesses.get(sessionId);
  if (process) {
    console.log(`Aborting Cursor session: ${sessionId}`);
    if (!process.kill('SIGTERM')) return false;
    process.wasAborted = true;
    // Keep the process visible until its close/error handler settles the
    // command and releases the user's concurrency slot.
    setTimeout(() => {
      if (activeCursorProcesses.get(sessionId) === process) {
        process.kill('SIGKILL');
      }
    }, 2000).unref?.();
    return true;
  }
  return false;
}

function isCursorSessionActive(sessionId) {
  return activeCursorProcesses.has(sessionId);
}

function getActiveCursorSessions() {
  return Array.from(activeCursorProcesses.keys());
}

export {
  spawnCursor,
  abortCursorSession,
  isCursorSessionActive,
  getActiveCursorSessions,
};
