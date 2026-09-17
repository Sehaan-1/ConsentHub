#!/bin/sh
# One-command boot for the ConsentHub Week 0 stack (issue #8):
#
#   git clone https://github.com/Sehaan-1/ConsentHub.git
#   cd ConsentHub
#   ./scripts/boot.sh
#
# Copies .env.example -> .env when .env is missing (dev-only credentials),
# then builds and starts the full docker compose stack. The backend applies
# the Flyway migrations (schema + demo seed data) to MySQL on first boot.
#
# `docker compose down -v` afterwards removes every container and all state.
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example (dev-only credentials; .env is gitignored)."
fi

docker compose up --build
