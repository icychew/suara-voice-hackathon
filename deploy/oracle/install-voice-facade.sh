#!/usr/bin/env bash
set -euo pipefail

domain="${1:-}"
server_source="${2:-}"
unit_source="${3:-}"
environment_template="${4:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

if [[ -z "${domain}" || ! "${domain}" =~ ^[a-z0-9.-]+$ ]]; then
  echo "Invalid domain: ${domain}" >&2
  exit 1
fi

for source in "${server_source}" "${unit_source}" "${environment_template}"; do
  if [[ -z "${source}" || ! -f "${source}" || -L "${source}" ]]; then
    echo "A required voice-facade deployment file is missing or unsafe." >&2
    exit 1
  fi
done

node_major="0"
if [[ -x /usr/bin/node ]]; then
  node_major="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi

if [[ "${node_major}" != 22 && "${node_major}" != 24 ]]; then
  dnf module reset -y nodejs
  dnf module install -y nodejs:22
  node_major="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi

if [[ "${node_major}" != 22 && "${node_major}" != 24 ]]; then
  echo "A supported Node.js LTS (22 or 24) is required for the Suara voice facade." >&2
  exit 1
fi

# Nginx runs in httpd_t on enforcing Oracle Linux; loopback proxying needs this policy.
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" != Disabled ]]; then
  setsebool -P httpd_can_network_connect on
fi

install -d -o root -g root -m 0755 /opt/suara/server
install -d -o root -g root -m 0700 /etc/suara

# Bootstrap only a new state directory. Never recreate a missing usage ledger
# inside an existing directory: it may represent previously consumed allowance.
quota_directory="/var/lib/suaravoice"
quota_file="${quota_directory}/token-issuance.json"
if [[ ! -e "${quota_directory}" && ! -L "${quota_directory}" && \
      ! -e /var/lib/private/suaravoice && ! -L /var/lib/private/suaravoice ]]; then
  install -d -o root -g root -m 0700 "${quota_directory}"
  quota_tmp="$(mktemp "${quota_directory}/.initial-quota.XXXXXXXX")"
  printf '%s\n' '{"version":1,"timestamps":[]}' > "${quota_tmp}"
  chmod 0600 "${quota_tmp}"
  mv -T -- "${quota_tmp}" "${quota_file}"
elif [[ ! -d "${quota_directory}" || ! -f "${quota_file}" || -L "${quota_file}" || "$(stat -c %h "${quota_file}")" != 1 ]]; then
  echo "The durable quota directory or ledger is missing or unsafe; preserve it and investigate before restarting." >&2
  exit 1
fi
quota_resolved="$(readlink -f "${quota_directory}")"
if [[ "${quota_resolved}" != /var/lib/suaravoice && "${quota_resolved}" != /var/lib/private/suaravoice ]]; then
  echo "Unexpected durable quota directory target; installation stopped." >&2
  exit 1
fi
install -o root -g root -m 0644 "${server_source}" /opt/suara/server/voice-facade.mjs
install -o root -g root -m 0644 "${unit_source}" /etc/systemd/system/suara-voice.service

if [[ ! -e /etc/suara/voice.env ]]; then
  environment_tmp="$(mktemp /etc/suara/.voice-env.XXXXXXXX)"
  trap 'rm -f -- "${environment_tmp}"' EXIT
  sed "s/__DOMAIN__/${domain}/g" "${environment_template}" > "${environment_tmp}"
  chmod 0600 "${environment_tmp}"
  mv -f -- "${environment_tmp}" /etc/suara/voice.env
  trap - EXIT
elif [[ ! -f /etc/suara/voice.env || -L /etc/suara/voice.env ]]; then
  echo "/etc/suara/voice.env must be a regular file." >&2
  exit 1
else
  chown root:root /etc/suara/voice.env
  chmod 0600 /etc/suara/voice.env
fi

systemctl daemon-reload

if grep -Eq '^ASSEMBLYAI_API_KEY=.+$' /etc/suara/voice.env && \
   grep -Eq '^SUARA_JUDGE_ACCESS_CODE=.{16,128}$' /etc/suara/voice.env && \
   grep -Fxq 'SUARA_QUOTA_FILE=/var/lib/suaravoice/token-issuance.json' /etc/suara/voice.env; then
  systemctl enable --now suara-voice.service
  systemctl restart suara-voice.service
  if ! curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --max-time 10 \
    -H "Host: ${domain}" http://127.0.0.1:8787/healthz >/dev/null; then
    systemctl stop suara-voice.service
    echo "The voice facade failed its loopback health check and was stopped." >&2
    exit 1
  fi
  echo "Suara voice facade installed and restarted on loopback."
else
  systemctl disable --now suara-voice.service 2>/dev/null || true
  echo "Suara voice facade installed but remains stopped. Configure the provider key, judge code and durable SUARA_QUOTA_FILE with sudoedit /etc/suara/voice.env, then enable the service."
fi
