#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="lark-h5-bug-bot-worker"
ECOSYSTEM_FILE="$ROOT_DIR/ecosystem.config.cjs"

usage() {
  cat <<USAGE
Usage: ./scripts/worker-pm2.sh <command>

Commands:
  start       Start worker from ecosystem.config.cjs and save PM2 process list
  status      Show PM2 status
  logs        Tail worker logs
  logs100     Tail worker logs with last 100 lines
  restart     Restart worker and save PM2 process list
  stop        Stop worker and save PM2 process list
  delete      Delete worker from PM2 and save PM2 process list
  save        Save current PM2 process list
  startup     Print PM2 startup command for boot restore
  logrotate   Install/configure pm2-logrotate for PM2 stdout/stderr logs

Examples:
  ./scripts/worker-pm2.sh start
  ./scripts/worker-pm2.sh logs
  ./scripts/worker-pm2.sh restart
USAGE
}

require_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "pm2 not found. Install it first: npm install -g pm2" >&2
    exit 1
  fi
}

command_name="${1:-}"

if [[ -z "$command_name" || "$command_name" == "-h" || "$command_name" == "--help" ]]; then
  usage
  exit 0
fi

require_pm2

case "$command_name" in
  start)
    pm2 start "$ECOSYSTEM_FILE"
    pm2 save
    ;;
  status)
    pm2 status
    ;;
  logs)
    pm2 logs "$APP_NAME"
    ;;
  logs100)
    pm2 logs "$APP_NAME" --lines 100
    ;;
  restart)
    pm2 restart "$APP_NAME"
    pm2 save
    ;;
  stop)
    pm2 stop "$APP_NAME"
    pm2 save
    ;;
  delete)
    pm2 delete "$APP_NAME"
    pm2 save
    ;;
  save)
    pm2 save
    ;;
  startup)
    pm2 startup
    ;;
  logrotate)
    pm2 install pm2-logrotate || true
    pm2 set pm2-logrotate:max_size 10M
    pm2 set pm2-logrotate:retain 14
    pm2 set pm2-logrotate:compress true
    pm2 set pm2-logrotate:rotateInterval "0 0 * * *"
    pm2 save
    ;;
  *)
    echo "Unknown command: $command_name" >&2
    usage >&2
    exit 1
    ;;
esac
