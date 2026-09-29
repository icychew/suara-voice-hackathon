#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
domain="${2:-}"
web_root="/var/www/suara"
releases_root="${web_root}/releases"
release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

if [[ -z "${archive}" || ! -f "${archive}" || -L "${archive}" ]]; then
  echo "Missing release archive: ${archive}" >&2
  exit 1
fi

if [[ -z "${domain}" || ! "${domain}" =~ ^[a-z0-9.-]+$ ]]; then
  echo "Invalid domain: ${domain}" >&2
  exit 1
fi

install -d -m 0755 "${releases_root}"
exec 9>"${web_root}/.release.lock"
flock -n 9 || { echo "Another release operation is in progress." >&2; exit 1; }
work_dir="$(mktemp -d "${web_root}/.publish.XXXXXXXX")"
trap 'rm -rf -- "${work_dir}"' EXIT
tar -tzf "${archive}" > "${work_dir}/archive-paths"
tar -tvzf "${archive}" > "${work_dir}/archive-types"
if grep -E '^(\./)*suara-operator-only\.json/?$' "${work_dir}/archive-paths" >/dev/null; then
  echo "Operator-only artifacts cannot be published." >&2
  exit 1
fi

if grep -E '(^/|(^|/)\.\.(/|$))' "${work_dir}/archive-paths" >/dev/null; then
  echo "The release archive contains an unsafe path." >&2
  exit 1
fi

if grep -E '^[^-d]' "${work_dir}/archive-types" >/dev/null; then
  echo "The release archive contains a link or special file, which is not allowed." >&2
  exit 1
fi

install -d -m 0755 "${releases_root}"
release_dir="$(mktemp -d -p "${releases_root}" "${release_stamp}.XXXXXXXX")"
chmod 0755 "${release_dir}"
published=0
activated=0
current_target=""

restore_prior_state() {
  if [[ -n "${current_target}" ]]; then
    ln -sfn "${current_target}" "${work_dir}/current-next" || return 1
    mv -Tf "${work_dir}/current-next" "${web_root}/current" || return 1
  else
    rm -f -- "${web_root}/current" || return 1
  fi
  activated=0
}

cleanup_failed_release() {
  if [[ "${published}" -ne 1 ]]; then
    if [[ "${activated}" -eq 1 ]]; then
      if ! restore_prior_state; then
        echo "Could not restore the prior state; preserving the new release for recovery." >&2
        rm -rf -- "${work_dir}"
        return
      fi
    fi
    local live_target
    live_target="$(readlink -f "${web_root}/current" 2>/dev/null || true)"
    if [[ -d "${release_dir}" && "$(dirname "${release_dir}")" == "${releases_root}" && "${live_target}" != "${release_dir}" ]]; then
      rm -rf -- "${release_dir}"
    fi
  fi
  rm -rf -- "${work_dir}"
}
trap cleanup_failed_release EXIT

tar --no-same-owner --no-same-permissions -xzf "${archive}" -C "${release_dir}"
if [[ -e "${release_dir}/suara-operator-only.json" || -L "${release_dir}/suara-operator-only.json" ]]; then
  echo "Operator-only artifacts cannot be published." >&2
  exit 1
fi

test -f "${release_dir}/prototype/index.html"
test -f "${release_dir}/voice/index.html"
test -d "${release_dir}/assets"

# The Oracle hostname opens the prototype at / while the same build remains
# available at /prototype/ on GitHub Pages.
cp "${release_dir}/prototype/index.html" "${release_dir}/index.html"
if command -v restorecon >/dev/null 2>&1; then
  restorecon -RF "${release_dir}"
fi

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

if [[ -L "${web_root}/current" ]]; then
  current_target="$(readlink -f "${web_root}/current")"
  if ! validate_release_target "${current_target}"; then
    echo "The current release link is unsafe or incomplete." >&2
    exit 1
  fi
elif [[ -e "${web_root}/current" ]]; then
  echo "The current release path is not a symbolic link." >&2
  exit 1
fi

ln -sfn "${release_dir}" "${work_dir}/current-next"
mv -Tf "${work_dir}/current-next" "${web_root}/current"
activated=1

if ! nginx -t || ! systemctl reload nginx; then
  echo "Nginx rejected the new release; restoring the prior state." >&2
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
  echo "The new release failed its local HTTP health check; restoring the prior state." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 15 \
  --resolve "${domain}:${health_port}:127.0.0.1" "${health_scheme}://${domain}/voice/" >/dev/null; then
  echo "The voice entry failed its local HTTP health check; restoring the prior state." >&2
  exit 1
fi

if [[ -n "${current_target}" ]]; then
  ln -sfn "${current_target}" "${work_dir}/previous-next"
  mv -Tf "${work_dir}/previous-next" "${web_root}/previous"
fi

published=1
rm -rf -- "${work_dir}"
trap - EXIT

mapfile -t release_names < <(find "${releases_root}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
for index in "${!release_names[@]}"; do
  if (( index < 5 )); then
    continue
  fi

  candidate="${releases_root}/${release_names[$index]}"
  current_resolved="$(readlink -f "${web_root}/current")"
  previous_resolved="$(readlink -f "${web_root}/previous" 2>/dev/null || true)"
  if [[ "${candidate}" != "${current_resolved}" && "${candidate}" != "${previous_resolved}" && "$(dirname "${candidate}")" == "${releases_root}" ]]; then
    rm -rf -- "${candidate}"
  fi
done

echo "Published $(basename "${release_dir}") and passed the local HTTP health check."
