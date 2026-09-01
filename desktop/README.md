# CloudCLI Desktop

This package is a small Electron shell for the hosted CloudCLI application. It does not package the CloudCLI server, SQLite, PTY support, agent CLIs, Docker, or any server-side environment variables. The web application and the desktop version are released independently.

## Configuration

Production builds require two URL values. Supply them as CI environment variables or copy `.env.desktop.example` to the ignored `.env.desktop` file:

```dotenv
DESKTOP_HOME_URL=https://cloudcli.example.com/
DESKTOP_UPDATE_BASE_URL=https://cloudcli.example.com/api/desktop-updates
```

- `DESKTOP_HOME_URL` is the page opened by the desktop window.
- `DESKTOP_UPDATE_BASE_URL` is the base URL used by the auto-updater.
- Only these two names are parsed from `.env.desktop`. The root `.env` is never read by the desktop build.

Development defaults to `http://127.0.0.1:5173/`, so run the normal web development server and the Electron shell in separate terminals:

```sh
npm run dev
npm run desktop:dev
```

`DESKTOP_HOME_URL` can also be supplied when the app starts. The command-line
option takes precedence over the environment variable, which takes precedence
over the URL embedded at build time:

```sh
DESKTOP_HOME_URL=https://cloudcli.example.com/ npm run desktop:dev
/Applications/CloudCLI.app/Contents/MacOS/CloudCLI --desktop-home-url=https://cloudcli.example.com/
```

The desktop application's dedicated browser session uses direct connections by
default, so `DESKTOP_HOME_URL` and resources loaded in that session do not use
the system proxy.

The desktop offline renderer uses port `5174`. A local `.env.desktop` can override the remote development URL. Packaged applications ignore `ELECTRON_RENDERER_URL` and load the bundled offline page on connection failure.

## Commands

```sh
npm run desktop:install
npm run desktop:test
npm run desktop:build
npm run desktop:package:mac
npm run desktop:package:win
```

`package:mac` produces a Universal DMG and ZIP. `package:win` produces an x64 NSIS installer.

## Runtime behavior

- The main window uses a persistent `persist:cloudcli` Chromium session.
- The preload connects browser events to native desktop notifications.
- Closing the main window hides it in the tray. Explicit Quit ends notifications but does not cancel cloud tasks.
- The packaged fallback page is loaded from the bundled renderer files.

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
}
```

The prefix accepts only a restricted absolute internal URI path. It must match the Nginx `location`, and the `alias` must point to the same content as `DESKTOP_UPDATE_ROOT`. Invalid prefixes make the update endpoint unavailable instead of emitting an unsafe redirect. Leave the variable unset when Nginx offload is not configured; Express continues serving metadata and artifacts directly with HEAD and Range support. Metadata remains served by Express with `no-store`; offloaded versioned artifacts retain immutable cache headers and Nginx handles their Range requests.

## Release secrets and variables

The `desktop-release.yml` workflow expects repository variables for the desktop settings and deployment coordinates:

- `DESKTOP_HOME_URL`, `DESKTOP_UPDATE_BASE_URL`
- `DESKTOP_DEPLOY_HOST`, `DESKTOP_DEPLOY_USER`, `DESKTOP_UPDATE_ROOT`

It expects these secrets:

- Deployment: `DESKTOP_DEPLOY_SSH_KEY`, `DESKTOP_DEPLOY_KNOWN_HOSTS`

The workflow builds both desktop targets and publishes the updater files. Deployment is serialized, uploads artifacts first, and publishes both updater YAML files last. The update host needs Bash, `sha256sum`, and GNU `sort -V`.

## Release acceptance

Before enabling a version for all users, keep `N-1` installers and perform one installed `N-1 → N` update on both macOS and Windows. Verify differential download, restart/install, persistent login state, tray behavior, notification activation, and that cloud tasks remain active across the desktop restart. A fully quit application does not promise background push delivery in V1.
