# CloudCLI Desktop

CloudCLI Desktop is a self-contained local distribution of the CloudCLI web application. The installer includes the built React UI, Node backend and its hook runner, production dependencies, SQLite and PTY native modules, an isolated official Node.js/npm plugin toolchain, and the official Claude CLI. It does not require a system Node.js/npm installation, a system Claude CLI, Docker, or a separately deployed CloudCLI server.

The local backend listens only on loopback and always uses local Claude execution. Application data remains in `~/.cloudcli`, while Claude authentication and sessions remain in `~/.claude`. Claude is the only provider bundled and supported by the desktop release; the Codex, Cursor, and Gemini entries may still use CLIs already installed on the host.

Loopback binding is not an outbound-network restriction. Automatic updates, Skill Market, GitHub/CodeHub, remote MCP servers, Web Push, and model traffic remain available when configured.

## Configuration

Production builds require only the non-secret HTTPS updater URL. Supply it as a CI environment variable or copy `.env.desktop.example` to the ignored `.env.desktop` file:

```dotenv
DESKTOP_UPDATE_BASE_URL=https://cloudcli.example.com/api/desktop-updates
```

- The updater URL must be absolute HTTPS without credentials, a query, or a fragment.
- Only `DESKTOP_UPDATE_BASE_URL` is parsed from `.env.desktop`; root server secrets are never embedded in the Electron code.
- The application origin is selected dynamically after the bundled loopback backend reports ready, so no remote home URL or origin allowlist is configured at build time.

Installed Desktop runtime settings belong in `~/.cloudcli/.env` (on Windows,
`%USERPROFILE%\.cloudcli\.env`). The project-root `.env` is intentionally not
embedded in an installer because it may contain credentials. User settings override
packaged defaults, while Desktop always forces `HOST=127.0.0.1`,
`CLAUDE_EXECUTION_MODE=local`, its private database/runtime paths, bundled toolchain
paths, and normal JWT authentication. `desktop/.env.desktop` remains build-only and
configures the updater URL; it is not a backend runtime environment file.

Desktop development builds the root frontend/backend, prepares `desktop/.runtime`, rebuilds the native dependencies for the installed Electron version, and starts Electron:

```sh
npm run desktop:dev
```

The generated runtime is intentionally ignored by Git because it contains installed production dependencies and a large platform executable. Run `npm run desktop:prepare-runtime` to refresh it for the current host without compiling the Electron sources. macOS packages include only the two Darwin executables needed by the Universal app; Windows packages include only the Windows x64 executable.

## Commands

```sh
npm run desktop:install
npm run desktop:test
npm run desktop:build
npm run desktop:package:mac
npm run desktop:package:win
```

`package:mac` produces a Universal DMG and ZIP. Local macOS builds without a
Developer ID are ad-hoc signed so they remain runnable after Universal merging and
fuse changes; they are not trusted or notarized for distribution. `package:win`
produces an x64 NSIS installer. A production package is expected to be signed; CI
sets `DESKTOP_REQUIRE_SIGNING=true`, which makes an absent signing identity a hard
failure.

Every build performs the root web/server build with `VITE_IS_PLATFORM=false` before compiling Electron. Runtime preparation uses the root lock file, installs required production dependencies with lifecycle scripts disabled via `--ignore-scripts` and optional platform packages omitted via `--omit=optional`, and then bundles the exact selected Claude platform packages locked alongside `@anthropic-ai/claude-agent-sdk`. Both the package archive integrity and the executable checksum from the SDK manifest are verified. It also downloads the official Node.js 24.18.1 distributions (including their npm CLI) for the selected targets and verifies their archives against pinned hashes from Node.js's published `SHASUMS256.txt`; this version is checked against Electron's embedded Node version during preparation. Target-local `npm` and `npx` launchers use that standalone Node runtime, while keeping npm inside the desktop-only package avoids increasing normal Web installations. `better-sqlite3`, `bcrypt`, and `node-pty` are rebuilt for Electron in the packaged app once per target architecture.

Node distributions are cached under `desktop/.cache/node/v24.18.1/`. An offline
Windows build can place the official `node-v24.18.1-win-x64.zip` in that directory
before running `npm run desktop:package:win`; the archive is still checked against
the pinned official SHA-256 and a mismatched cache entry fails closed. Successful
online downloads populate the same ignored cache automatically for later builds.

## Runtime security model

- The main window uses a persistent `persist:cloudcli` Chromium session, sandboxing, context isolation, and no Node integration or `<webview>` support.
- The local backend rejects non-loopback Host headers and requires its exact dynamic loopback origin for browser HTTP and WebSocket requests. This protects inbound access to the local service without blocking outbound HTTPS/WSS used by model APIs, updates, Git services, Skill Market, or remote MCP. External HTTPS and `mailto:` navigation opens in the system browser; unsafe schemes are rejected.
- Certificate errors fail closed. Web permissions default to denied, with notifications and clipboard access available only to the exact application origins.
- The preload exposes a narrow typed bridge, including the private bootstrap session delivered directly by the local backend process. There is no public passwordless-login HTTP endpoint.
- Closing the main window hides it in the tray and keeps the local backend and Claude tasks running. Explicit Quit drains active work before stopping the backend.
- The Electron executable disables RunAsNode, `NODE_OPTIONS`, CLI inspect flags, and non-ASAR application loading, while enabling cookie encryption and embedded ASAR integrity checks. Plugin processes use the separately bundled standalone Node.js runtime, so the application fuse does not need to be weakened.
- The packaged fallback page is served only through the private `cloudcli-offline://app/` protocol; `file://` receives no extra privileges.

## Update repository

Set the server's `DESKTOP_UPDATE_ROOT` to an absolute directory with this layout:

```text
<root>/latest/mac/universal/latest-mac.yml
<root>/latest/mac/universal/CloudCLI-Desktop-1.0.0-mac-universal.zip
<root>/latest/mac/universal/CloudCLI-Desktop-1.0.0-mac-universal.zip.blockmap
<root>/latest/mac/universal/CloudCLI-Desktop-1.0.0-mac-universal.dmg
<root>/latest/mac/universal/CloudCLI-Desktop-1.0.0-mac-universal.dmg.blockmap
<root>/latest/win/x64/latest.yml
<root>/latest/win/x64/CloudCLI-Desktop-1.0.0-win-x64.exe
<root>/latest/win/x64/CloudCLI-Desktop-1.0.0-win-x64.exe.blockmap
```

The application checks 30 seconds after startup and every six hours. Downloaded updates offer “restart now” or “later”; a normal explicit exit installs a downloaded update.

For Nginx, large artifact delivery can be offloaded after the application validates the target. Set `DESKTOP_UPDATE_ACCEL_REDIRECT_PREFIX=/_internal/cloudcli-desktop-updates` and map the same absolute update root to an internal-only alias:

```nginx
location /_internal/cloudcli-desktop-updates/ {
    internal;
    alias /var/lib/cloudcli/desktop-updates/;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header X-Content-Type-Options "nosniff" always;
}
```

The prefix accepts only a restricted absolute internal URI path. It must match the Nginx `location`, and the `alias` must point to the same content as `DESKTOP_UPDATE_ROOT`. Invalid prefixes make the update endpoint unavailable instead of emitting an unsafe redirect. Leave the variable unset when Nginx offload is not configured; Express continues serving metadata and artifacts directly with HEAD and Range support. Metadata remains served by Express with `no-store`; offloaded versioned artifacts retain immutable cache headers and Nginx handles their Range requests.

## Release secrets and variables

The `desktop-release.yml` workflow expects the updater setting and deployment coordinates as repository variables:

- `DESKTOP_UPDATE_BASE_URL`
- `DESKTOP_DEPLOY_HOST`, `DESKTOP_DEPLOY_USER`, `DESKTOP_UPDATE_ROOT`

It expects these secrets:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`
- Deployment: `DESKTOP_DEPLOY_SSH_KEY`, `DESKTOP_DEPLOY_KNOWN_HOSTS`

The workflow installs both root and desktop lock files, builds the complete runtime, signs and notarizes/staples the macOS application, and signs the Windows application and NSIS installer. CI verifies the bundled frontend/backend, Claude executables, native dependency packages, fuses, signatures, the macOS app ticket, and local/remote SHA-256 hashes. Deployment is serialized, refuses an older version or different bytes under an existing versioned filename, uploads artifacts first, and publishes both updater YAML files last with rollback on failure. The update host needs Bash, `sha256sum`, and GNU `sort -V`.

## Release acceptance

Before enabling a version for all users, keep signed `N-1` installers and perform one installed `N-1 → N` update on both macOS and Windows. Test on a machine without Node.js, Claude CLI, or Docker. Verify signature/notarization, bundled `claude --version`, first authentication, a new and resumed Claude session, tool use, persistent login/history, differential update, tray behavior, graceful local-task draining, and update restart.
