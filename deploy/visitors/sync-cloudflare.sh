#!/bin/sh
set -eu

ROOT="${VISITOR_STATS_ROOT:?VISITOR_STATS_ROOT is required}"
CONF="${CLOUDFLARE_REALIP_CONF:-/www/server/panel/vhost/nginx/snippets/cloudflare-realip.conf}"
NGINX="${NGINX_BIN:-/www/server/nginx/sbin/nginx}"

exec python3 "$ROOT/sync_cloudflare_realip.py" \
  --conf "$CONF" \
  --nginx "$NGINX" \
  --reload
