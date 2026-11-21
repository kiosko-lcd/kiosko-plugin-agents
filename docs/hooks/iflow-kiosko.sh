#!/bin/sh
# iFlow CLI → Kiosko: writes this session's status file for the Kiosko
# `agents` plugin. iFlow passes the session to hooks in environment
# variables (IFLOW_SESSION_ID, IFLOW_CWD, IFLOW_HOOK_EVENT_NAME,
# IFLOW_TOOL_NAME, IFLOW_NOTIFICATION_MESSAGE: see
# https://github.com/iflow-ai/iflow-cli/blob/main/docs_en/examples/hooks.md),
# so the state to write comes as the argument:
#   iflow-kiosko.sh working|permission|input|done|end
# It always exits 0: a hook must never get in the way of the session.
state="$1"
id=$(printf '%s' "${IFLOW_SESSION_ID:-global}" | tr -c 'A-Za-z0-9._:@-' '_' | cut -c1-128)
dir="${KIOSKO_AGENTS_STATUS_DIR:-$HOME/.config/kiosko/agents}"
file="$dir/iflow-$id.json"
if [ "$state" = "end" ]; then rm -f "$file"; exit 0; fi
esc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-240; }
detail="${IFLOW_NOTIFICATION_MESSAGE:-$IFLOW_TOOL_NAME}"
mkdir -p "$dir" 2>/dev/null
printf '{"agent":"iflow","id":"%s","state":"%s","cwd":"%s","detail":"%s"}\n' "$id" "$(esc "$state")" "$(esc "${IFLOW_CWD:-$PWD}")" "$(esc "$detail")" > "$file.$$" 2>/dev/null && mv -f "$file.$$" "$file" 2>/dev/null
exit 0
