#!/usr/bin/env bash
set -euo pipefail

domain="${1:-}"
config_source="${2:-}"
tls_config_source="${3:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

if [[ -z "${domain}" || ! "${domain}" =~ ^[a-z0-9.-]+$ ]]; then
  echo "Invalid domain: ${domain}" >&2
  exit 1
fi

if [[ -z "${config_source}" || ! -f "${config_source}" || -L "${config_source}" ]]; then
  echo "Missing Nginx template: ${config_source}" >&2
  exit 1
fi

if [[ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" || -f "/etc/letsencrypt/live/${domain}/privkey.pem" ]]; then
  if [[ -z "${tls_config_source}" || ! -f "${tls_config_source}" || -L "${tls_config_source}" ]]; then
    echo "TLS exists, but the checked TLS Nginx template is missing." >&2
    exit 1
  fi
  config_source="${tls_config_source}"
fi

dnf install -y curl nginx tar util-linux policycoreutils-python-utils
install -d -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge
install -d -m 0755 /var/www/suara/releases
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" != Disabled ]]; then
  # The ACME webroot is outside /var/www and needs a persistent readable label.
  semanage fcontext -a -t httpd_sys_content_t '/var/lib/letsencrypt(/.*)?' 2>/dev/null || \
    semanage fcontext -m -t httpd_sys_content_t '/var/lib/letsencrypt(/.*)?'
  restorecon -RF /var/lib/letsencrypt /var/www/suara
fi

config_target="/etc/nginx/conf.d/suara-demo.conf"
config_tmp="$(mktemp /etc/nginx/conf.d/.suara-demo.XXXXXXXX)"
config_backup=""
if [[ -f "${config_target}" ]]; then
  config_backup="$(mktemp /etc/nginx/conf.d/.suara-demo-backup.XXXXXXXX)"
  cp -a -- "${config_target}" "${config_backup}"
fi

cleanup_config_files() {
  rm -f -- "${config_tmp}"
  if [[ -n "${config_backup}" ]]; then
    rm -f -- "${config_backup}"
  fi
}
trap cleanup_config_files EXIT

sed "s/__DOMAIN__/${domain}/g" "${config_source}" > "${config_tmp}"
chmod 0644 "${config_tmp}"
mv -f -- "${config_tmp}" "${config_target}"

if ! nginx -t; then
  if [[ -n "${config_backup}" ]]; then
    mv -f -- "${config_backup}" "${config_target}"
    config_backup=""
  else
    rm -f -- "${config_target}"
  fi
  echo "The generated Nginx configuration was rejected; the prior configuration was restored." >&2
  exit 1
fi

if command -v firewall-cmd >/dev/null 2>&1; then
  systemctl enable --now firewalld
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
fi

if ! systemctl enable --now nginx || ! systemctl reload nginx; then
  if [[ -n "${config_backup}" ]]; then
    mv -f -- "${config_backup}" "${config_target}"
    config_backup=""
    nginx -t && systemctl reload nginx || true
  else
    rm -f -- "${config_target}"
  fi
  echo "Nginx could not activate the configuration; the prior configuration file was restored." >&2
  exit 1
fi

cleanup_config_files
trap - EXIT

echo "Oracle Linux host prepared for ${domain}."
