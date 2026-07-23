#!/bin/sh
set -eu

APP_USER=node
APP_GROUP=node
DOCKER_SOCKET=/var/run/docker.sock

DATA_ROOT="${CLOUDCLI_DATA_ROOT:-/srv/cloudcli}"
DATABASE_PATH="${DATABASE_PATH:-$DATA_ROOT/auth.db}"
WORKSPACES_ROOT="${WORKSPACES_ROOT:-$DATA_ROOT/workspaces}"
CLOUDCLI_RUNTIME_ROOT="${CLOUDCLI_RUNTIME_ROOT:-$DATA_ROOT/runtimes}"
HOME="${HOME:-$DATA_ROOT/home}"
export HOME

identity_path="$HOME"
if [ ! -d "$identity_path" ]; then
  identity_path="$DATA_ROOT"
fi

detected_uid="$(stat -c '%u' "$identity_path" 2>/dev/null || printf '1000')"
detected_gid="$(stat -c '%g' "$identity_path" 2>/dev/null || printf '1000')"
if [ "$detected_uid" = "0" ]; then detected_uid=1000; fi
if [ "$detected_gid" = "0" ]; then detected_gid=1000; fi

APP_UID="${PUID:-$detected_uid}"
APP_GID="${PGID:-$detected_gid}"

case "$APP_UID:$APP_GID" in
  *[!0-9:]*|:*|*:)
    echo "PUID and PGID must be non-negative integers" >&2
    exit 1
    ;;
esac

# Match the application user to host-owned workspace files when requested.
if [ "$(id -g "$APP_USER")" != "$APP_GID" ]; then
  existing_group="$(getent group "$APP_GID" | cut -d: -f1 || true)"
  if [ -n "$existing_group" ]; then
    APP_GROUP="$existing_group"
  else
    groupmod --non-unique --gid "$APP_GID" "$APP_GROUP"
  fi
  usermod --gid "$APP_GROUP" "$APP_USER"
fi

if [ "$(id -u "$APP_USER")" != "$APP_UID" ]; then
  usermod --non-unique --uid "$APP_UID" "$APP_USER"
fi

# Docker socket group IDs vary by host. Add the unprivileged application user
# to the socket's actual group rather than requiring a hard-coded Docker GID.
if [ -S "$DOCKER_SOCKET" ]; then
  socket_gid="$(stat -c '%g' "$DOCKER_SOCKET")"
  socket_group="$(getent group "$socket_gid" | cut -d: -f1 || true)"
  if [ -z "$socket_group" ]; then
    socket_group=docker-host
    groupadd --non-unique --gid "$socket_gid" "$socket_group"
  fi
  usermod --append --groups "$socket_group" "$APP_USER"
else
  echo "Docker socket not found at $DOCKER_SOCKET" >&2
  exit 1
fi

for directory in \
  "$DATA_ROOT" \
  "$(dirname "$DATABASE_PATH")" \
  "$WORKSPACES_ROOT" \
  "$CLOUDCLI_RUNTIME_ROOT" \
  "$HOME"
do
  mkdir -p "$directory"
  chown "$APP_USER:$APP_GROUP" "$directory"
done

if [ -e "$DATABASE_PATH" ]; then
  chown "$APP_USER:$APP_GROUP" "$DATABASE_PATH"
fi

exec gosu "$APP_USER" "$@"
