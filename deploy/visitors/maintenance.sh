#!/bin/sh
# Daily private-maintenance entry point. Keep this file outside the public route.
set -eu

ROOT="${VISITOR_STATS_ROOT:?VISITOR_STATS_ROOT is required}"
PHP_BIN="${PHP_BIN:-php}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
BACKUP_DIR="${VISITOR_STATS_BACKUP_DIR:-/www/maintenance-backups/jubeat-visitors}"
REPORT_DIR="${VISITOR_STATS_REPORT_DIR:-/www/maintenance-reports/jubeat-visitors}"
RETENTION_DAYS="${VISITOR_STATS_RETENTION_DAYS:-90}"
BACKUP_KEEP="${VISITOR_STATS_BACKUP_KEEP:-7}"

umask 077
"$PHP_BIN" "$ROOT/maintenance.php" \
  --root "$ROOT" \
  --retention-days "$RETENTION_DAYS" \
  --backup-dir "$BACKUP_DIR" \
  --backup-keep "$BACKUP_KEEP" \
  --flush --apply

"$PYTHON_BIN" "$ROOT/visitor-report.py" \
  --db "$ROOT/visitors.sqlite" \
  --geo-db "$ROOT/ip2region_v4.xdb" \
  --allow-download \
  --out "$REPORT_DIR"
