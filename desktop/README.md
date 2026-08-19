# CloudCLI Desktop

This package is a small Electron shell for the hosted CloudCLI application. It does not package the CloudCLI server, SQLite, PTY support, agent CLIs, Docker, or any server-side environment variables. The web application and the desktop version are released independently.

## Configuration

Production builds require four non-secret URL values and accept one optional security override. Supply them as CI environment variables or copy `.env.desktop.example` to the ignored `.env.desktop` file:

```dotenv
DESKTOP_ALLOW_INSECURE_HTTP=false
DESKTOP_HOME_URL=https://cloudcli.example.com/
DESKTOP_UPDATE_BASE_URL=https://cloudcli.example.com/api/desktop-updates
DESKTOP_ALLOWED_ORIGINS=https://cloudcli.example.com
DESKTOP_AUTH_ORIGINS=https://auth.example.com
```

- Production URLs use HTTPS by default. Allowlist entries must be exact origins, separated by commas.
- An unsigned internal build may set `DESKTOP_ALLOW_INSECURE_HTTP=true` to permit HTTP for `DESKTOP_HOME_URL`, `DESKTOP_UPDATE_BASE_URL`, `DESKTOP_ALLOWED_ORIGINS`, and `DESKTOP_AUTH_ORIGINS`. This opt-in exposes authentication, application traffic, update metadata, and installers to interception and must not be used on untrusted networks.
- `DESKTOP_REQUIRE_SIGNING=true` rejects builds that enable insecure HTTP.
- `DESKTOP_HOME_URL` may include an initial path. Its origin is always included in the navigation allowlist.
- `DESKTOP_AUTH_ORIGINS` may be explicitly empty when the deployment has no cross-origin OAuth provider.
- Application origins and OAuth origins must be disjoint; overlapping entries fail the build.
- Only these five names are parsed from `.env.desktop`. The root `.env` is never read by the desktop build.
- Missing production values, credentials embedded in a URL, origin paths, and insecure URLs fail the build.

Development defaults to `http://127.0.0.1:5173/`, so run the normal web development server and the Electron shell in separate terminals:

```sh
npm run dev
npm run desktop:dev
```

The desktop offline renderer uses port `5174`. A local `.env.desktop` can override the remote development URL; loopback HTTP is accepted automatically in development mode, while other HTTP origins require the explicit insecure override. Packaged applications ignore `ELECTRON_RENDERER_URL` and always use the bundled, restricted offline page on load failure.

## Commands

```sh
npm run desktop:install
npm run desktop:test
npm run desktop:build
npm run desktop:package:mac
npm run desktop:package:win
```

`package:mac` produces a Universal DMG and ZIP. `package:win` produces an x64 NSIS installer. A production package is expected to be signed; CI sets `DESKTOP_REQUIRE_SIGNING=true`, which makes an absent signing identity a hard failure.

## Runtime security model

- The main window uses a persistent `persist:cloudcli` Chromium session, sandboxing, context isolation, and no Node integration or `<webview>` support.
- Main-frame navigation is limited to configured application origins. Configured OAuth origins use a restricted child window. Other HTTPS and `mailto:` URLs go to the system browser; unconfigured HTTP, `file:`, `data:`, `javascript:`, and unknown schemes are rejected.
- Certificate errors fail closed. Web permissions default to denied, with notifications and clipboard access available only to the exact application origins.
- The preload exposes only the typed notification bridge. The main process rechecks the main-frame origin and validates/rate-limits every notification.
- Closing the main window hides it in the tray. Explicit Quit ends notifications but does not cancel cloud tasks.
- Electron fuses disable RunAsNode, `NODE_OPTIONS`, CLI inspect flags, and non-ASAR application loading, while enabling cookie encryption and embedded ASAR integrity checks.
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

The `desktop-release.yml` workflow expects repository variables for the four desktop settings and deployment coordinates:

- `DESKTOP_HOME_URL`, `DESKTOP_UPDATE_BASE_URL`, `DESKTOP_ALLOWED_ORIGINS`, `DESKTOP_AUTH_ORIGINS`
- `DESKTOP_DEPLOY_HOST`, `DESKTOP_DEPLOY_USER`, `DESKTOP_UPDATE_ROOT`

It expects these secrets:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`
- Deployment: `DESKTOP_DEPLOY_SSH_KEY`, `DESKTOP_DEPLOY_KNOWN_HOSTS`

The workflow signs and notarizes/staples the macOS application before producing the signed DMG/ZIP, and signs both the Windows application and NSIS installer. CI verifies fuses, signatures, the macOS app ticket, and local/remote SHA-256 hashes. Deployment is serialized, refuses an older version or different bytes under an existing versioned filename, uploads artifacts first, and publishes both updater YAML files last with rollback on failure. The update host needs Bash, `sha256sum`, and GNU `sort -V`.

## Release acceptance

Before enabling a version for all users, keep signed `N-1` installers and perform one installed `N-1 → N` update on both macOS and Windows. Verify signature/notarization, differential download, restart/install, persistent login state, tray behavior, notification activation, and that cloud tasks remain active across the desktop restart. A fully quit application does not promise background push delivery in V1.
