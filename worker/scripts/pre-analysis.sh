#!/usr/bin/env bash
set -euo pipefail

git pull
gitnexus analyze --skip-agents-md
