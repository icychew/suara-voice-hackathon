#!/usr/bin/env bash
set -euo pipefail

domain="${1:-demo.suaraproject.tech}"
email="${2:-}"
tls_config_source="${3:-/usr/local/share/suara/nginx-suara-demo-tls.conf}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

if [[ ! "${domain}" =~ ^[a-z0-9.-]+$ ]]; then
  echo "Invalid domain: ${domain}" >&2
  exit 1
fi

if [[ -z "${email}" ]]; then
  echo "Usage: sudo suara-enable-tls <domain> <certificate-email> [tls-template]" >&2
  exit 1
fi

if [[ ! -f "${tls_config_source}" || -L "${tls_config_source}" ]]; then
  echo "Missing TLS Nginx template: ${tls_config_source}" >&2
  exit 1
fi

dnf install -y augeas-devel augeas-libs cronie gcc libffi-devel openssl-devel python3 python3-devel python3-pip
systemctl enable --now crond

if [[ ! -x /opt/certbot/bin/python3 ]]; then
  python3 -m venv /opt/certbot
fi
/opt/certbot/bin/pip install --upgrade pip
/opt/certbot/bin/pip install certbot
ln -sfn /opt/certbot/bin/certbot /usr/local/bin/certbot

install -d -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge

certbot certonly \
  --webroot \
  --webroot-path /var/lib/letsencrypt \
  --domain "${domain}" \
  --email "${email}" \
  --agree-tos \
  --no-eff-email \
  --non-interactive \
  --keep-until-expiring

config_target="/etc/nginx/conf.d/suara-demo.conf"
if [[ ! -f "${config_target}" ]]; then
  echo "The HTTP Nginx configuration is missing." >&2
  exit 1
fi

config_tmp="$(mktemp /etc/nginx/conf.d/.suara-demo-tls.XXXXXXXX)"
config_backup="$(mktemp /etc/nginx/conf.d/.suara-demo-backup.XXXXXXXX)"
cp -a -- "${config_target}" "${config_backup}"

cleanup_config_files() {
  if [[ -n "${config_tmp}" ]]; then
    rm -f -- "${config_tmp}"
  fi
  if [[ -n "${config_backup}" ]]; then
    rm -f -- "${config_backup}"
  fi
}
trap cleanup_config_files EXIT

sed "s/__DOMAIN__/${domain}/g" "${tls_config_source}" > "${config_tmp}"
chmod 0644 "${config_tmp}"
mv -f -- "${config_tmp}" "${config_target}"

restore_http_config() {
  mv -f -- "${config_backup}" "${config_target}"
  config_backup=""
  nginx -t
  systemctl reload nginx
}

if ! nginx -t; then
  restore_http_config
  echo "The TLS Nginx configuration was rejected; HTTP was restored." >&2
  exit 1
fi

if ! systemctl reload nginx; then
  restore_http_config
  echo "Nginx could not activate TLS; the prior configuration was restored." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 15 \
  --resolve "${domain}:443:127.0.0.1" "https://${domain}/" >/dev/null; then
  restore_http_config
  echo "The local HTTPS health check failed; HTTP was restored." >&2
  exit 1
fi

rm -f -- "${config_backup}"
config_backup=""
trap - EXIT

cat > /etc/cron.d/certbot-renew <<'EOF'
17 3,15 * * * root /opt/certbot/bin/certbot renew --quiet --deploy-hook 'systemctl reload nginx'
EOF
chmod 0644 /etc/cron.d/certbot-renew

certbot renew --dry-run --deploy-hook 'systemctl reload nginx'
nginx -t
systemctl reload nginx

echo "HTTPS enabled for ${domain} and passed the local health check."
