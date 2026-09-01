#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: publish-update-stage.sh <update-root> <deploy-id>" >&2
  exit 64
fi

update_root=$1
deploy_id=$2

if [[ ! "$update_root" =~ ^/[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$ ]]; then
  echo "unsafe update root" >&2
  exit 64
fi
if [[ ! "$deploy_id" =~ ^[0-9]+-[0-9]+$ ]]; then
  echo "unsafe deploy id" >&2
  exit 64
fi

stage_root="$update_root/.staging/$deploy_id"
mac_stage="$stage_root/latest/mac/universal"
win_stage="$stage_root/latest/win/x64"
mac_target="$update_root/latest/mac/universal"
win_target="$update_root/latest/win/x64"
lock_directory="$update_root/.desktop-release-publish.lock"

if [[ ! -d "$mac_stage" || ! -d "$win_stage" ]]; then
  echo "release staging directories are incomplete" >&2
  exit 66
fi
if ! mkdir "$lock_directory" 2>/dev/null; then
  echo "another desktop release is publishing; remove a stale lock only after verifying no publisher is active" >&2
  exit 75
fi

release_lock() {
  rmdir "$lock_directory" 2>/dev/null || true
}
trap release_lock EXIT

validate_stage_directory() {
  local source_directory=$1
  local platform=$2
  local entry
  while IFS= read -r -d '' entry; do
    if [[ -L "$entry" || ! -f "$entry" ]]; then
      echo "staging entries must be regular files: $entry" >&2
      exit 65
    fi

    local filename=${entry##*/}
    case "$platform:$filename" in
      mac:latest-mac.yml|mac:SHA256SUMS|mac:*.dmg|mac:*.zip|mac:*.blockmap)
        ;;
      win:latest.yml|win:SHA256SUMS|win:*.exe|win:*.blockmap)
        ;;
      *)
        echo "unexpected file in release staging: $entry" >&2
        exit 65
        ;;
    esac
  done < <(find "$source_directory" -mindepth 1 -maxdepth 1 -print0)
}

validate_stage_directory "$mac_stage" mac
validate_stage_directory "$win_stage" win
(cd "$mac_stage" && sha256sum -c SHA256SUMS)
(cd "$win_stage" && sha256sum -c SHA256SUMS)

read_metadata_version() {
  local metadata_file=$1
  awk -F ': *' '$1 == "version" { value=$2; gsub(/^['\''"]|['\''"]$/, "", value); print value; exit }' "$metadata_file"
}

mac_version=$(read_metadata_version "$mac_stage/latest-mac.yml")
win_version=$(read_metadata_version "$win_stage/latest.yml")
if [[ ! "$mac_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$mac_version" != "$win_version" ]]; then
  echo "macOS and Windows metadata must contain the same stable semantic version" >&2
  exit 65
fi
release_version=$mac_version

assert_not_downgrade() {
  local current_metadata=$1
  if [[ ! -e "$current_metadata" && ! -L "$current_metadata" ]]; then
    return
  fi
  if [[ -L "$current_metadata" || ! -f "$current_metadata" ]]; then
    echo "existing metadata is not a regular file: $current_metadata" >&2
    exit 65
  fi

  local current_version
  current_version=$(read_metadata_version "$current_metadata")
  if [[ ! "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "existing metadata has an invalid version: $current_metadata" >&2
    exit 65
  fi
  if [[ "$(printf '%s\n%s\n' "$current_version" "$release_version" | sort -V | tail -n 1)" != "$release_version" ]]; then
    echo "refusing to publish desktop version $release_version over newer version $current_version" >&2
    exit 65
  fi
}

assert_not_downgrade "$mac_target/latest-mac.yml"
assert_not_downgrade "$win_target/latest.yml"
mkdir -p "$mac_target" "$win_target"

preflight_artifacts() {
  local source_directory=$1
  local target_directory=$2
  local metadata_name=$3
  local source_file
  while IFS= read -r -d '' source_file; do
    local filename=${source_file##*/}
    if [[ "$filename" == "$metadata_name" || "$filename" == "SHA256SUMS" ]]; then
      continue
    fi
    if [[ "$filename" != *"$release_version"* ]]; then
      echo "artifact filename does not include release version $release_version: $filename" >&2
      exit 65
    fi

    local destination="$target_directory/$filename"
    if [[ -L "$destination" ]]; then
      echo "refusing to replace symlinked immutable artifact: $destination" >&2
      exit 65
    fi
    if [[ -e "$destination" ]] && ! cmp -s "$source_file" "$destination"; then
      echo "immutable artifact already exists with different bytes: $destination" >&2
      exit 65
    fi
  done < <(find "$source_directory" -maxdepth 1 -type f -print0)
}

preflight_artifacts "$mac_stage" "$mac_target" latest-mac.yml
preflight_artifacts "$win_stage" "$win_target" latest.yml

publish_artifacts() {
  local source_directory=$1
  local target_directory=$2
  local metadata_name=$3
  local source_file
  while IFS= read -r -d '' source_file; do
    local filename=${source_file##*/}
    if [[ "$filename" == "$metadata_name" || "$filename" == "SHA256SUMS" ]]; then
      continue
    fi

    local destination="$target_directory/$filename"
    if [[ -e "$destination" ]]; then
      rm -f -- "$source_file"
    else
      mv -- "$source_file" "$destination"
    fi
  done < <(find "$source_directory" -maxdepth 1 -type f -print0)
}

publish_artifacts "$mac_stage" "$mac_target" latest-mac.yml
publish_artifacts "$win_stage" "$win_target" latest.yml

backup_directory="$stage_root/metadata-backup"
mkdir -p "$backup_directory"
mac_had_metadata=false
win_had_metadata=false
if [[ -f "$mac_target/latest-mac.yml" && ! -L "$mac_target/latest-mac.yml" ]]; then
  cp -- "$mac_target/latest-mac.yml" "$backup_directory/latest-mac.yml"
  mac_had_metadata=true
fi
if [[ -f "$win_target/latest.yml" && ! -L "$win_target/latest.yml" ]]; then
  cp -- "$win_target/latest.yml" "$backup_directory/latest.yml"
  win_had_metadata=true
fi

rollback_metadata() {
  set +e
  if $mac_had_metadata; then
    cp -- "$backup_directory/latest-mac.yml" "$mac_target/latest-mac.yml.rollback"
    mv -f -- "$mac_target/latest-mac.yml.rollback" "$mac_target/latest-mac.yml"
  else
    rm -f -- "$mac_target/latest-mac.yml"
  fi
  if $win_had_metadata; then
    cp -- "$backup_directory/latest.yml" "$win_target/latest.yml.rollback"
    mv -f -- "$win_target/latest.yml.rollback" "$win_target/latest.yml"
  else
    rm -f -- "$win_target/latest.yml"
  fi
}

trap 'rollback_metadata; exit 1' ERR
mv -f -- "$mac_stage/latest-mac.yml" "$mac_target/latest-mac.yml"
mv -f -- "$win_stage/latest.yml" "$win_target/latest.yml"
trap - ERR

rm -rf -- "$stage_root"
