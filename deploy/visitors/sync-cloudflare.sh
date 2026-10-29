#!/bin/sh
set -eu

ROOT="${VISITOR_STATS_ROOT:?VISITOR_STATS_ROOT is required}"
CONF="${CLOUDFLARE_REALIP_CONF:-/www/server/panel/vhost/nginx/snippets/cloudflare-realip.conf}"
EDGE_MAP="${CLOUDFLARE_EDGE_MAP:-/www/server/panel/vhost/nginx/snippets/cloudflare-edge-map.conf}"
NGINX="${NGINX_BIN:-/www/server/nginx/sbin/nginx}"

exec python3 "$ROOT/sync_cloudflare_realip.py" \
  --conf "$CONF" \
  --edge-map "$EDGE_MAP" \
  --nginx "$NGINX" \
  --reload
