#!/usr/bin/env bash
set -euo pipefail

web_root="/var/www/suara"
releases_root="${web_root}/releases"
domain="${1:-demo.suaraproject.tech}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

exec 9>"${web_root}/.release.lock"
flock -n 9 || { echo "Another release operation is in progress." >&2; exit 1; }
work_dir="$(mktemp -d "${web_root}/.rollback.XXXXXXXX")"
trap 'rm -rf -- "${work_dir}"' EXIT

if [[ ! -L "${web_root}/current" || ! -L "${web_root}/previous" ]]; then
  echo "Both current and previous release links are required." >&2
  exit 1
fi

if [[ ! "${domain}" =~ ^[a-z0-9.-]+$ ]]; then
  echo "Invalid domain: ${domain}" >&2
  exit 1
fi

current_target="$(readlink -f "${web_root}/current")"
previous_target="$(readlink -f "${web_root}/previous")"

validate_release_target() {
  local target="$1"
  [[ -n "${target}" ]] || return 1
  [[ "$(dirname "${target}")" == "${releases_root}" ]] || return 1
  [[ -d "${target}" ]] || return 1
  [[ -f "${target}/index.html" ]] || return 1
  [[ -f "${target}/prototype/index.html" ]] || return 1
  [[ -f "${target}/voice/index.html" ]] || return 1
  [[ -d "${target}/assets" ]] || return 1
}

if ! validate_release_target "${current_target}" || ! validate_release_target "${previous_target}"; then
  echo "A release link is unsafe or incomplete; rollback stopped." >&2
  exit 1
fi

rollback_active=0

restore_newer_release() {
  ln -sfn "${current_target}" "${work_dir}/current-next" || return 1
  mv -Tf "${work_dir}/current-next" "${web_root}/current" || return 1
  rollback_active=0
}

cleanup_failed_rollback() {
  if [[ "${rollback_active}" -eq 1 ]]; then
    restore_newer_release || echo "Could not restore the newer release; both releases were preserved for recovery." >&2
  fi
  rm -rf -- "${work_dir}"
}
trap cleanup_failed_rollback EXIT

ln -sfn "${previous_target}" "${work_dir}/current-next"
mv -Tf "${work_dir}/current-next" "${web_root}/current"
rollback_active=1

if ! nginx -t || ! systemctl reload nginx; then
  echo "Nginx rejected the rollback target; restoring the newer release." >&2
  exit 1
fi

health_scheme="http"
health_port="80"
if [[ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" && -f "/etc/letsencrypt/live/${domain}/privkey.pem" ]]; then
  health_scheme="https"
  health_port="443"
fi

if ! curl --fail --silent --show-error --max-time 15 \
  --resolve "${domain}:${health_port}:127.0.0.1" "${health_scheme}://${domain}/" >/dev/null; then
  echo "The rollback target failed its local HTTP health check; restoring the newer release." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 15 \
  --resolve "${domain}:${health_port}:127.0.0.1" "${health_scheme}://${domain}/voice/" >/dev/null; then
  echo "The rollback voice entry failed its local HTTP health check; restoring the newer release." >&2
  exit 1
fi

ln -sfn "${current_target}" "${work_dir}/previous-next"
mv -Tf "${work_dir}/previous-next" "${web_root}/previous"
rollback_active=0
rm -rf -- "${work_dir}"
trap - EXIT

echo "Rolled back to $(basename "${previous_target}") and passed the local HTTP health check."
