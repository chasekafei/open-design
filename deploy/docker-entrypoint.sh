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

EXAMPLE_CONFIG=/opt/hermes-agent/cli-config.yaml.example
CONFIG_FILE="$HERMES_HOME/config.yaml"

# Full upstream example keeps terminal/agent/compression/… defaults
# (including agent.reasoning_effort: medium). We only patch model routing.
# Re-seed when missing OR when an older OD entrypoint wrote a stub that
# dropped those sections (detect: no top-level agent:/terminal: keys).
needs_hermes_seed=0
if [ ! -f "$CONFIG_FILE" ]; then
  needs_hermes_seed=1
elif ! grep -qE '^(agent|terminal|compression|display):' "$CONFIG_FILE" 2>/dev/null; then
  needs_hermes_seed=1
  echo "[open-design] hermes config looks like a minimal stub; restoring full example + model patch" >&2
fi

if [ "$needs_hermes_seed" -eq 1 ]; then
  if [ -f "$EXAMPLE_CONFIG" ]; then
    cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
  else
    cat > "$CONFIG_FILE" <<'EOF'
model:
  provider: auto
agent:
  reasoning_effort: "medium"
EOF
  fi

  # Patch only model.default / model.provider / model.base_url.
  # OpenAI-compatible relays use provider openai-api (honors OPENAI_BASE_URL);
  # "custom" is for local/vLLM-style endpoints and is the wrong default here.
  export HERMES_MODEL OPENAI_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL
  python3 - <<'PY'
import os
import re
from pathlib import Path

path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
text = path.read_text(encoding="utf-8")
base = (os.environ.get("OPENAI_BASE_URL") or "").strip().rstrip("/")
has_anthropic = bool(
    (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    or (os.environ.get("ANTHROPIC_AUTH_TOKEN") or "").strip()
)

if base:
    provider = "openai-api"
    model = (os.environ.get("HERMES_MODEL") or "").strip() or "gpt-4o"
elif has_anthropic:
    provider = "anthropic"
    model = (os.environ.get("ANTHROPIC_MODEL") or "").strip() or "claude-sonnet-4-5"
    base = ""
else:
    provider = "auto"
    model = (os.environ.get("HERMES_MODEL") or "").strip()
    base = ""

lines = text.splitlines(True)
out = []
in_model = False
for line in lines:
    if not in_model:
        if re.match(r"^model:\s*$", line):
            in_model = True
        out.append(line)
        continue
    # Leave the model: mapping when the next top-level key starts.
    if re.match(r"^[A-Za-z_][\w-]*:\s*", line):
        in_model = False
        out.append(line)
        continue
    m = re.match(r"^(\s*)(default|provider|base_url)\s*:.*$", line)
    if m and not line.lstrip().startswith("#"):
        indent, key = m.group(1), m.group(2)
        if key == "default" and model:
            out.append(f'{indent}default: "{model}"\n')
            continue
        if key == "provider":
            out.append(f'{indent}provider: "{provider}"\n')
            continue
        if key == "base_url" and base:
            out.append(f'{indent}base_url: "{base}"\n')
            continue
    out.append(line)

path.write_text("".join(out), encoding="utf-8")
print(
    f"[open-design] hermes config seeded provider={provider}"
    + (f" model={model}" if model else "")
    + (f" base_url={base}" if base else ""),
    flush=True,
)
PY
fi

[ ! -f "$HERMES_HOME/.env" ] && touch "$HERMES_HOME/.env"

# Hermes docs put openai-api credentials in $HERMES_HOME/.env (not only the
# process environment). Keep those keys in sync with Railway Variables every
# boot so ACP runs see the same OPENAI_* the daemon inherited.
python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["HERMES_HOME"]) / ".env"
existing = path.read_text(encoding="utf-8") if path.exists() else ""
keys = (
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
)
managed = {k: (os.environ.get(k) or "").strip() for k in keys}
lines = []
seen = set()
for raw in existing.splitlines():
    if not raw or raw.lstrip().startswith("#") or "=" not in raw:
        lines.append(raw)
        continue
    name, _, _rest = raw.partition("=")
    name = name.strip()
    if name in managed:
        seen.add(name)
        value = managed[name]
        if value:
            lines.append(f"{name}={value}")
        # Drop empty managed keys so a cleared Railway var does not leave a stale value.
        continue
    lines.append(raw)
for name, value in managed.items():
    if value and name not in seen:
        lines.append(f"{name}={value}")
text = "\n".join(lines).rstrip() + ("\n" if lines else "")
path.write_text(text, encoding="utf-8")
synced = [k for k, v in managed.items() if v]
if synced:
    print(f"[open-design] hermes .env synced keys={','.join(synced)}", flush=True)
PY

# Clear stale gateway PID if a previous container left one on the volume.
rm -f "$HERMES_HOME/gateway.pid"

chown -R open-design:open-design "$DATA_DIR" 2>/dev/null || true

exec gosu open-design env HERMES_HOME="$HERMES_HOME" \
  node apps/daemon/dist/cli.js --no-open
