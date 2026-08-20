import { createWriteStream, type WriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import {
  createDesktopBootstrapSessionRequest,
  isValidBackendPort,
  parseDesktopBackendMessage,
  parseDesktopBootstrapSessionResponse,
  type DesktopBackendReadyMessage,
  type DesktopBackendStatus,
  type DesktopBootstrapSession,
} from '../shared/backend-protocol';
import {
  assertDesktopRuntimeExists,
  createDesktopBackendEnvironment,
  type DesktopRuntimePaths,
} from './runtime-paths';

const DEFAULT_BACKEND_PORT = 3001;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_BOOTSTRAP_SESSION_TIMEOUT_MS = 10_000;
const PORT_STATE_FILE_NAME = 'desktop-backend-port.json';
const LOG_FILE_NAME = 'desktop-backend.log';

export class DesktopBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopBackendError';
  }
}

export interface BackendProcess {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(
    event: 'error',
    listener: (type: string, location: string, report: string) => void,
  ): this;
  removeListener(event: 'message', listener: (message: unknown) => void): this;
  removeListener(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export interface DesktopBackendControllerOptions {
  utilityEntry: string;
  runtimePaths: DesktopRuntimePaths;
  stateDirectory: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  bootstrapSessionTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  forkProcess?: (
    entry: string,
    options: Electron.ForkOptions,
  ) => BackendProcess;
  assertRuntime?: (paths: DesktopRuntimePaths) => void;
  isPortAvailable?: (port: number) => Promise<boolean>;
  allocatePort?: () => Promise<number>;
}

type StatusListener = (status: DesktopBackendStatus) => void;

interface PendingBootstrapSessionRequest {
  child: BackendProcess;
  resolve: (session: DesktopBootstrapSession) => void;
  reject: (error: DesktopBackendError) => void;
  timeout: NodeJS.Timeout;
}

function normalizeProcessExitError(code: number): DesktopBackendError {
  return new DesktopBackendError(
    'BACKEND_EXITED',
    `The local backend exited before it was ready (exit code ${code}).`,
  );
}

export async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  if (!isValidBackendPort(port)) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Unable to allocate a loopback port.'));
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

export async function readPersistedBackendPort(stateDirectory: string): Promise<number | null> {
  try {
    const contents = await readFile(join(stateDirectory, PORT_STATE_FILE_NAME), 'utf8');
    const candidate = JSON.parse(contents) as { port?: unknown };
    return isValidBackendPort(candidate.port) ? candidate.port : null;
  } catch {
    return null;
  }
}

export async function persistBackendPort(
  stateDirectory: string,
  port: number,
): Promise<void> {
  if (!isValidBackendPort(port)) {
    throw new TypeError('Backend port must be an integer between 1 and 65535.');
  }

  await mkdir(stateDirectory, { recursive: true });
  const destination = join(stateDirectory, PORT_STATE_FILE_NAME);
  const temporary = join(
    stateDirectory,
    `.${PORT_STATE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify({ port })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, destination);
}

export async function selectBackendPort(options: {
  persistedPort: number | null;
  defaultPort?: number;
  isAvailable?: (port: number) => Promise<boolean>;
  allocate?: () => Promise<number>;
}): Promise<number> {
  const isAvailable = options.isAvailable ?? isLoopbackPortAvailable;
  const allocate = options.allocate ?? allocateLoopbackPort;
  const preferred = options.persistedPort ?? options.defaultPort ?? DEFAULT_BACKEND_PORT;
  return await isAvailable(preferred) ? preferred : allocate();
}

function defaultForkProcess(
  entry: string,
  options: Electron.ForkOptions,
): BackendProcess {
  return utilityProcess.fork(entry, [], options) as UtilityProcess;
}

export class DesktopBackendController {
  private readonly listeners = new Set<StatusListener>();
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly bootstrapSessionTimeoutMs: number;
  private readonly logPath: string;
  private readonly pendingBootstrapSessions = new Map<
    string,
    PendingBootstrapSessionRequest
  >();
  private child: BackendProcess | null = null;
  private logStream: WriteStream | null = null;
  private startPromise: Promise<DesktopBackendReadyMessage> | null = null;
  private stopPromise: Promise<void> | null = null;
  private startGeneration = 0;
  private expectedExit = false;
  private ready: DesktopBackendReadyMessage | null = null;
  private status: DesktopBackendStatus = { state: 'stopped' };

  constructor(private readonly options: DesktopBackendControllerOptions) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.bootstrapSessionTimeoutMs = options.bootstrapSessionTimeoutMs
      ?? DEFAULT_BOOTSTRAP_SESSION_TIMEOUT_MS;
    this.logPath = join(options.stateDirectory, 'logs', LOG_FILE_NAME);
  }

  getStatus(): DesktopBackendStatus {
    return { ...this.status };
  }

  getOrigin(): string | null {
    return this.ready?.origin ?? null;
  }

  getLogPath(): string {
    return this.logPath;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<DesktopBackendReadyMessage> {
    if (this.ready) {
      return Promise.resolve({ ...this.ready, session: null });
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const generation = ++this.startGeneration;
    this.startPromise = this.startInternal(generation).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async restart(): Promise<DesktopBackendReadyMessage> {
    const pendingStartup = this.startPromise;
    await this.stop();
    if (pendingStartup) {
      await pendingStartup.catch(() => undefined);
    }
    return this.start();
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.startGeneration += 1;
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  requestBootstrapSession(): Promise<DesktopBootstrapSession> {
    const child = this.child;
    if (!child || !this.ready || this.expectedExit) {
      return Promise.reject(new DesktopBackendError(
        'BACKEND_NOT_READY',
        'The local backend is not ready to create a desktop session.',
      ));
    }

    const requestId = randomUUID();
    const request = createDesktopBootstrapSessionRequest(requestId);
    return new Promise<DesktopBootstrapSession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingBootstrapSessions.delete(requestId);
        reject(new DesktopBackendError(
          'BOOTSTRAP_SESSION_TIMEOUT',
          'Timed out waiting for a fresh desktop session.',
        ));
      }, this.bootstrapSessionTimeoutMs);
      timeout.unref();

      this.pendingBootstrapSessions.set(requestId, {
        child,
        resolve,
        reject,
        timeout,
      });
      try {
        child.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingBootstrapSessions.delete(requestId);
        reject(new DesktopBackendError(
          'BOOTSTRAP_SESSION_REQUEST_FAILED',
          error instanceof Error ? error.message : 'Unable to request a desktop session.',
        ));
      }
    });
  }

  private updateStatus(status: DesktopBackendStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      listener(this.getStatus());
    }
  }

  private async startInternal(generation: number): Promise<DesktopBackendReadyMessage> {
    this.expectedExit = false;
    this.ready = null;
    this.updateStatus({
      state: 'starting',
      message: '正在启动本地 CloudCLI 服务…',
    });

    try {
      await mkdir(dirname(this.logPath), { recursive: true });
      await this.appendLogLine(
        `Running desktop backend preflight for ${this.options.runtimePaths.backendEntry}`,
      );
      if (this.options.assertRuntime) {
        this.options.assertRuntime(this.options.runtimePaths);
      } else {
        assertDesktopRuntimeExists(this.options.runtimePaths);
      }
      this.assertStartupCurrent(generation);

      const persistedPort = await readPersistedBackendPort(this.options.stateDirectory);
      this.assertStartupCurrent(generation);
      const port = await selectBackendPort({
        persistedPort,
        isAvailable: this.options.isPortAvailable,
        allocate: this.options.allocatePort,
      });
      this.assertStartupCurrent(generation);

      try {
        return await this.launch(port, generation);
      } catch (error) {
        if (error instanceof DesktopBackendError && error.code === 'EADDRINUSE') {
          const fallbackPort = await (this.options.allocatePort ?? allocateLoopbackPort)();
          this.assertStartupCurrent(generation);
          return await this.launch(fallbackPort, generation);
        }
        throw error;
      }
    } catch (error) {
      if (generation !== this.startGeneration) {
        throw new DesktopBackendError(
          'BACKEND_START_CANCELLED',
          'Local backend startup was cancelled.',
        );
      }
      const normalized = error instanceof DesktopBackendError
        ? error
        : new DesktopBackendError(
          'BACKEND_START_FAILED',
          error instanceof Error ? error.message : 'The local backend failed to start.',
        );
      this.closeLogStream();
      await this.appendLogLine(
        `Startup failed [${normalized.code}]: ${normalized.message}`,
      ).catch((logError) => {
        console.warn('[desktop] Failed to persist the backend startup error.', logError);
      });
      this.updateStatus({
        state: 'error',
        code: normalized.code,
        message: normalized.message,
      });
      throw normalized;
    }
  }

  private assertStartupCurrent(generation: number): void {
    if (generation !== this.startGeneration) {
      throw new DesktopBackendError(
        'BACKEND_START_CANCELLED',
        'Local backend startup was cancelled.',
      );
    }
  }

  private launch(
    port: number,
    generation: number,
  ): Promise<DesktopBackendReadyMessage> {
    this.terminateCurrentChild();
    this.expectedExit = false;
    const forkProcess = this.options.forkProcess ?? defaultForkProcess;
    const environment = createDesktopBackendEnvironment(
      this.options.runtimePaths,
      port,
      this.options.environment,
    );

    let child: BackendProcess;
    try {
      child = forkProcess(this.options.utilityEntry, {
        cwd: this.options.runtimePaths.runtimeRoot,
        env: environment,
        serviceName: 'CloudCLI Local Backend',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new DesktopBackendError(
        'BACKEND_SPAWN_FAILED',
        error instanceof Error ? error.message : 'Unable to start the local backend process.',
      );
    }

    this.child = child;
    this.attachLogs(child);

    return new Promise<DesktopBackendReadyMessage>((resolve, reject) => {
      let settled = false;
      const finish = (
        callback: (value: DesktopBackendReadyMessage) => void,
        value: DesktopBackendReadyMessage,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.removeListener('message', handleMessage);
        callback(value);
      };
      const fail = (error: DesktopBackendError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.removeListener('message', handleMessage);
        child.removeListener('exit', handleStartupExit);
        if (this.child === child) {
          this.expectedExit = true;
          child.kill();
          this.child = null;
        }
        this.closeLogStream();
        reject(error);
      };
      const handleMessage = (value: unknown): void => {
        if (
          generation !== this.startGeneration
          || this.child !== child
          || this.expectedExit
        ) {
          fail(new DesktopBackendError(
            'BACKEND_START_CANCELLED',
            'Local backend startup was cancelled.',
          ));
          return;
        }
        const message = parseDesktopBackendMessage(value);
        if (!message) {
          console.warn('[desktop] Ignored an invalid backend process message.');
          return;
        }
        if (message.type === 'startup-error') {
          fail(new DesktopBackendError(message.code, message.message));
          return;
        }

        if (message.port !== port) {
          fail(new DesktopBackendError(
            'BACKEND_PORT_MISMATCH',
            'The local backend reported a different port than Electron assigned.',
          ));
          return;
        }

        // A bootstrap JWT received from an older backend build must never become
        // the renderer's long-lived cached credential. Renderer bootstrap always
        // asks the live backend to sign a fresh session over the private channel.
        this.ready = { ...message, session: null };
        this.expectedExit = false;
        this.updateStatus({ state: 'ready', origin: message.origin });
        void persistBackendPort(this.options.stateDirectory, message.port).catch((error) => {
          console.warn('[desktop] Failed to persist the backend port.', error);
        });
        child.removeListener('exit', handleStartupExit);
        child.on('message', (runtimeMessage) => {
          this.handleRuntimeMessage(child, runtimeMessage);
        });
        child.on('exit', (code) => this.handleRuntimeExit(child, code));
        finish(resolve, { ...message, session: null });
      };
      const handleStartupExit = (code: number): void => {
        if (this.child === child) {
          this.child = null;
        }
        fail(normalizeProcessExitError(code));
      };
      const timeout = setTimeout(() => {
        fail(new DesktopBackendError(
          'BACKEND_START_TIMEOUT',
          'Timed out waiting for the local backend to become ready.',
        ));
      }, this.startupTimeoutMs);
      timeout.unref();

      child.on('message', handleMessage);
      child.on('exit', handleStartupExit);
      child.on('error', (type, location) => {
        console.error(`[desktop] Backend utility process error (${type}) at ${location}.`);
      });
    });
  }

  private attachLogs(child: BackendProcess): void {
    this.logStream?.end();
    const stream = createWriteStream(this.logPath, {
      flags: 'a',
      encoding: 'utf8',
      mode: 0o600,
    });
    this.logStream = stream;
    stream.on('error', (error) => {
      console.warn('[desktop] Failed to write the backend log.', error);
      if (this.logStream === stream) {
        this.logStream = null;
      }
    });
    stream.write(
      `\n[${new Date().toISOString()}] Starting ${basename(this.options.runtimePaths.backendEntry)}\n`,
    );
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
  }

  private async appendLogLine(message: string): Promise<void> {
    const singleLine = message.replace(/[\r\n]+/gu, ' ');
    await appendFile(
      this.logPath,
      `[${new Date().toISOString()}] ${singleLine}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  private handleRuntimeMessage(child: BackendProcess, value: unknown): void {
    if (this.child !== child || this.expectedExit) {
      return;
    }

    const message = parseDesktopBootstrapSessionResponse(value);
    if (!message) {
      return;
    }
    const pending = this.pendingBootstrapSessions.get(message.requestId);
    if (!pending || pending.child !== child) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingBootstrapSessions.delete(message.requestId);
    if (message.type === 'bootstrap-session-result') {
      pending.resolve({
        user: { ...message.session.user },
        token: message.session.token,
      });
      return;
    }
    pending.reject(new DesktopBackendError(message.code, message.message));
  }

  private handleRuntimeExit(child: BackendProcess, code: number): void {
    if (this.child !== child) {
      return;
    }
    this.rejectPendingBootstrapSessions(new DesktopBackendError(
      'BACKEND_EXITED',
      `The local backend exited while creating a desktop session (exit code ${code}).`,
    ), child);
    this.child = null;
    this.ready = null;
    this.closeLogStream();
    if (this.expectedExit) {
      this.updateStatus({ state: 'stopped' });
      return;
    }
    this.updateStatus({
      state: 'error',
      code: 'BACKEND_CRASHED',
      message: `本地 CloudCLI 服务意外退出（退出码 ${code}）。`,
    });
  }

  private async stopInternal(): Promise<void> {
    const child = this.child;
    this.ready = null;
    if (!child) {
      this.updateStatus({ state: 'stopped' });
      return;
    }

    this.expectedExit = true;
    this.rejectPendingBootstrapSessions(new DesktopBackendError(
      'BACKEND_STOPPING',
      'The local backend is stopping.',
    ), child);
    this.updateStatus({
      state: 'stopping',
      message: '正在等待本地任务完成并安全退出…',
    });

    if (this.startPromise) {
      child.kill();
      if (this.child === child) {
        this.child = null;
      }
      this.closeLogStream();
      this.updateStatus({ state: 'stopped' });
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const complete = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        console.warn('[desktop] Backend graceful shutdown timed out; terminating it.');
        child.kill();
        complete();
      }, this.shutdownTimeoutMs);
      timeout.unref();
      child.on('exit', complete);
      child.postMessage({ type: 'shutdown' });
    });

    if (this.child === child) {
      this.child = null;
    }
    this.closeLogStream();
    this.updateStatus({ state: 'stopped' });
  }

  private terminateCurrentChild(): void {
    if (!this.child) {
      return;
    }
    this.expectedExit = true;
    this.rejectPendingBootstrapSessions(new DesktopBackendError(
      'BACKEND_RESTARTING',
      'The local backend is restarting.',
    ), this.child);
    this.child.kill();
    this.child = null;
    this.closeLogStream();
  }

  private closeLogStream(): void {
    this.logStream?.end();
    this.logStream = null;
  }

  private rejectPendingBootstrapSessions(
    error: DesktopBackendError,
    child?: BackendProcess,
  ): void {
    for (const [requestId, pending] of this.pendingBootstrapSessions) {
      if (child && pending.child !== child) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingBootstrapSessions.delete(requestId);
      pending.reject(error);
    }
  }
}
