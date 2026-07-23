#!/bin/bash
# Railway / container entrypoint for Open Design daemon.
# Fixes Volume ownership, seeds Hermes home under OD_DATA_DIR, then drops
# privileges to the open-design user (mirrors hermes-agent-template start.sh
# home seeding, without running the Hermes gateway — OD drives `hermes acp`).
set -euo pipefail

DATA_DIR="${OD_DATA_DIR:-/app/.od}"
export HERMES_HOME="${HERMES_HOME:-${DATA_DIR}/hermes}"

mkdir -p "$DATA_DIR" \
  "$HERMES_HOME/cron" \
  "$HERMES_HOME/sessions" \
  "$HERMES_HOME/logs" \
  "$HERMES_HOME/memories" \
  "$HERMES_HOME/skills" \
  "$HERMES_HOME/platforms/pairing" \
  "$HERMES_HOME/hooks" \
  "$HERMES_HOME/cache/images" \
  "$HERMES_HOME/cache/audio" \
  "$HERMES_HOME/workspace" \
  "$HERMES_HOME/plans"

# Stamp install method so `hermes update` refuses inside an immutable image
# (same rationale as praveen-ks-2001/hermes-agent-template).
printf 'docker\n' > "$HERMES_HOME/.install_method"

# Seed a minimal config only when missing. Do NOT copy cli-config.yaml.example
# — that file defaults to OpenRouter + anthropic/claude-opus and will make
# `hermes acp` exit(1) on a custom OpenAI relay that does not host those models.
if [ ! -f "$HERMES_HOME/config.yaml" ]; then
  if [ -n "${OPENAI_BASE_URL:-}" ]; then
    model_name="${HERMES_MODEL:-}"
    if [ -z "$model_name" ]; then
      # Prefer an explicit relay model; gpt-4o-mini is a common OD default
      # that many third-party groups reject (see memory-llm 404s).
      model_name="gpt-4o"
    fi
    cat > "$HERMES_HOME/config.yaml" <<EOF
model:
  provider: custom
  default: ${model_name}
  base_url: ${OPENAI_BASE_URL}
EOF
  elif [ -n "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    cat > "$HERMES_HOME/config.yaml" <<EOF
model:
  provider: anthropic
  default: ${ANTHROPIC_MODEL:-claude-sonnet-4-5}
EOF
  else
    cat > "$HERMES_HOME/config.yaml" <<EOF
model:
  provider: auto
EOF
  fi
fi
[ ! -f "$HERMES_HOME/.env" ] && touch "$HERMES_HOME/.env"

# Clear stale gateway PID if a previous container left one on the volume.
rm -f "$HERMES_HOME/gateway.pid"

chown -R open-design:open-design "$DATA_DIR" 2>/dev/null || true

exec gosu open-design env HERMES_HOME="$HERMES_HOME" \
  node apps/daemon/dist/cli.js --no-open
