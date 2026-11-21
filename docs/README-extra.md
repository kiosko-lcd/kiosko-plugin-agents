## Supported agents

Each session is one tile (and one cat in the [cats room](../kiosko-plugin-cats)). What matters most is
**"waiting for you"**: a permission prompt or a question. Some agents only say that through their hooks,
so each one can be read in up to two ways: from **its own files** (nothing to set up) or through
**its hooks** (one line of config, and then it can also tell a permission prompt). When both report the
same session, the hook wins.

| Agent | Own files, no setup | Hooks | Waiting for your permission |
|---|---|---|---|
| Claude Code | — | `agent-sessions-hook` | yes (hook) |
| Gemini CLI | — | `agent-sessions-hook --provider gemini` | yes (hook) |
| **Qwen Code** (also with local OpenAI-compatible models) | `~/.qwen/projects/*/chats/*.jsonl`: working / done | `agent-sessions-hook --provider qwen` | yes, with the hook |
| **Codex CLI** (also `--oss` / Ollama) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`: working / done / interrupted | `agent-sessions-hook --provider codex` | yes, with the hook |
| **Kimi CLI** | `~/.kimi/sessions/*/*/wire.jsonl`: working / done / question, and permission when it is logged | `agent-sessions-hook --provider kimi` | yes, with the hook |
| **iFlow CLI** | — | the script in [`docs/hooks/iflow-kiosko.sh`](docs/hooks/iflow-kiosko.sh) | yes, on its permission notification |
| **OpenCode** (often with local models) | — | the plugin in [`docs/hooks/opencode-kiosko.js`](docs/hooks/opencode-kiosko.js) | yes (`permission.asked`) |
| Anything else | — | a status file (below) | if you write it |

Every reader can be turned off in Kiosko → Settings → Data sources → *AI agent sessions*; one whose
folder doesn't exist reads nothing. Nothing outside those folders is opened, nothing is written to them,
and only logs written in the last 15 minutes (*Forget a quiet log after*) are read, a few kilobytes from
their end. A session read from its log can't say you closed the agent: a finished one stays until then
(Qwen Code also leaves a `.runtime.json` with its PID, so a closed Qwen session goes away at once).

Where those formats come from (the readers' source comments say exactly which files):
[openai/codex](https://github.com/openai/codex) (`codex-rs/rollout`, `codex-rs/protocol`, `codex-rs/hooks`),
[QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) (`packages/core/src/services/chatRecordingService.ts`,
[hooks](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md)),
[MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) ([data locations](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/configuration/data-locations.md),
[hooks](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/hooks.md)),
[iflow-ai/iflow-cli](https://github.com/iflow-ai/iflow-cli/blob/main/docs_en/examples/hooks.md) and
[OpenCode plugins](https://opencode.ai/docs/plugins/).

### Hooks

Install the hook once: `npm install -g @loksly/agent-sessions`. It writes one file per session to
`~/.aimonitor/sessions`, never fails loudly and needs no network.

**Qwen Code**: the same `hooks` block as Claude Code, in `~/.qwen/settings.json`, with
`--provider qwen`:

```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }],
    "PreToolUse":        [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }],
    "PostToolUse":       [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook --provider qwen", "timeout": 5 }] }]
  }
}
```

**iFlow CLI** hands the session to hooks in environment variables rather than on stdin, so it gets a
small script instead: copy [`docs/hooks/iflow-kiosko.sh`](docs/hooks/iflow-kiosko.sh) somewhere on your
`PATH` and, in `~/.iflow/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "iflow-kiosko.sh working" }] }],
    "PreToolUse":       [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "iflow-kiosko.sh working" }] }],
    "Notification":     [{ "matcher": ".*permission.*", "hooks": [{ "type": "command", "command": "iflow-kiosko.sh permission" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "iflow-kiosko.sh done" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "iflow-kiosko.sh end" }] }]
  }
}
```

**Codex CLI**: `~/.codex/hooks.json`, the same shape (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `Stop`, `SessionEnd`) with `agent-sessions-hook --provider codex`.
Codex has no `Notification` event: `PermissionRequest` is what tells a permission prompt. New hooks must be
trusted before they run: open `/hooks` in Codex and trust them.

**Kimi CLI**: `~/.kimi/config.toml`, one `[[hooks]]` per event:

```toml
[[hooks]]
event = "Notification"
command = "agent-sessions-hook --provider kimi"
timeout = 5

[[hooks]]
event = "PreToolUse"
command = "agent-sessions-hook --provider kimi"
timeout = 5

# … and the same for UserPromptSubmit, PostToolUse, Stop, SessionStart and SessionEnd.
```

**OpenCode**: copy [`docs/hooks/opencode-kiosko.js`](docs/hooks/opencode-kiosko.js) to
`~/.config/opencode/plugins/`. It writes status files (below) on `session.status`, `session.idle`,
`permission.asked` and `question.asked`, and deletes them on `session.deleted`.

### Status files: any agent, any script

For an agent this plugin doesn't know, or your own script: write one small JSON file per session to
`~/.config/kiosko/agents/` (or `$KIOSKO_AGENTS_STATUS_DIR`), and delete it when the session ends.

```json
{ "agent": "my-agent", "id": "42", "state": "permission", "cwd": "/home/me/web-app", "detail": "bash: npm publish" }
```

- `agent` (required): a short name, letters, digits, `.`, `_`, `-`; it shows in the tile's corner.
- `state` (required): `working`, `permission`, `input` (a question or your turn), `done` or `idle`.
- `id`: defaults to the file name. `cwd`: absolute, for the project name and git status. `detail`: one line.
- `updated` / `since` (ms epoch or ISO): default to the file's modification time; a silent file is dropped
  like any session.

From a shell hook, for example:

```sh
printf '{"agent":"my-agent","id":"%s","state":"%s","cwd":"%s"}' "$SESSION" "$STATE" "$PWD" \
  > ~/.config/kiosko/agents/my-agent-$SESSION.json
```

It's read defensively: regular files only (no symlinks), at most 16 KiB each and 200 in the folder, text cut
to one line and secrets redacted. There is no network listener: a file is the whole interface.
