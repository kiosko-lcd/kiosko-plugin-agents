/**
 * Codex CLI (openai/codex), read from its own session logs: no hook needed.
 *
 * Where: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`
 * (`CODEX_HOME` defaults to `~/.codex`), one JSON object per line,
 * `{ timestamp, type, payload }`:
 *   - `session_meta`: first line; `payload.id`, `payload.cwd`, `payload.source`;
 *   - `turn_context`: per turn; `payload.cwd`;
 *   - `event_msg`: `payload.type` `task_started` | `task_complete` (with
 *     `last_agent_message`) | `turn_aborted` | `user_message` | …;
 *   - `response_item`: `payload.type` `function_call` | `custom_tool_call` | `message` | ….
 * Source: codex-rs/rollout/src/recorder.rs (path), codex-rs/history/src/lib.rs
 * (`RolloutLine`), codex-rs/protocol/src/protocol.rs (`EventMsg`, wire names)
 * and codex-rs/rollout/src/policy.rs (what is persisted), in
 * https://github.com/openai/codex. Logs older than a week may be compressed
 * to `.jsonl.zst`; those are long dead and ignored.
 *
 * What it can tell: working (a turn started), ready (the turn completed),
 * waiting (the turn was interrupted: Esc). Approval prompts are NOT persisted
 * in the log (policy.rs drops `ExecApprovalRequest`), so "waiting for your
 * permission" needs Codex's `PermissionRequest` hook (see the README).
 */
import { join } from 'node:path';
import { fileCache, passiveRecord, type PassiveReader } from './common.ts';
import { firstLine, lastLines, list, oneLine, parseObject, recentFile, toMs } from './files.ts';
import type { SessionView } from '../types.ts';

/** Day folders looked at: a session lives in the folder of the day it started. */
const LOOKBACK_DAYS = 7;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl$/i;

function dayDirs(root: string, now: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(now - i * 86_400_000);
    out.push(join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return out;
}

/** A tool call as a short line: `exec_command: npm test`. */
function toolDetail(p: Record<string, any>): string {
  const name = String(p.name ?? p.type ?? 'tool');
  let args: any = p.arguments ?? p.input ?? p.action;
  if (typeof args === 'string') args = parseObject(args) ?? args;
  let arg = '';
  if (typeof args === 'string') arg = args.split('\n')[0] ?? '';
  else if (args && typeof args === 'object') {
    const cmd = args.cmd ?? args.command;
    arg = Array.isArray(cmd) ? String(cmd[cmd.length - 1] ?? '') : typeof cmd === 'string' ? cmd : String(args.path ?? args.file_path ?? args.query ?? '');
  }
  return arg ? `${name}: ${arg}` : name;
}

/** The session in one rollout file, or null if it is not one to show. */
export function parseRollout(path: string, size: number, mtime: number): SessionView | null {
  const m = ROLLOUT.exec(path.split(/[\\/]/).pop() ?? '');
  if (!m) return null;
  let id = m[1]!;
  let cwd: string | undefined;
  let started: number | undefined;
  const meta = parseObject(firstLine(path) ?? '');
  if (meta?.type === 'session_meta' && meta.payload) {
    const p = meta.payload;
    // Sub-agents and internal threads are part of another session.
    if (p.source && typeof p.source === 'object' && ('subagent' in p.source || 'internal' in p.source)) return null;
    if (typeof p.id === 'string') id = p.id;
    if (typeof p.cwd === 'string') cwd = p.cwd;
    started = toMs(p.timestamp ?? meta.timestamp);
  }

  let state: SessionView['state'] = 'idle';
  let since = started ?? mtime;
  let event = 'session_meta';
  let detail = '';
  let last = since;
  let sawTurn = false;
  for (const line of lastLines(path, size, 256 * 1024)) {
    const o = parseObject(line);
    if (!o) continue;
    const ts = toMs(o.timestamp);
    const at = Number.isFinite(ts) ? ts : last;
    last = Math.max(last, at);
    const p = (o.payload ?? {}) as Record<string, any>;
    const set = (s: SessionView['state'], ev: string) => {
      if (s !== state) since = at;
      state = s;
      event = ev;
    };
    if (o.type === 'turn_context' && typeof p.cwd === 'string') cwd = p.cwd;
    else if (o.type === 'event_msg') {
      switch (p.type) {
        case 'task_started':
        case 'turn_started':
          sawTurn = true;
          set('active', p.type);
          break;
        case 'task_complete':
        case 'turn_complete':
          sawTurn = true;
          set('ready', p.type);
          if (typeof p.last_agent_message === 'string' && p.last_agent_message) detail = p.last_agent_message;
          break;
        case 'turn_aborted':
          sawTurn = true;
          set('waiting', p.type);
          detail = `Interrupted${p.reason ? ` (${p.reason})` : ''}`;
          break;
        case 'user_message':
          if (typeof p.message === 'string') detail = p.message;
          break;
        case 'agent_message':
          if (typeof p.message === 'string') detail = p.message;
          break;
      }
    } else if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'web_search_call') {
        detail = toolDetail(p);
        if (!sawTurn) set('active', p.type);
      } else if (p.type === 'message' && p.role === 'assistant' && !sawTurn) {
        // Logs without turn events: an answer ends the turn.
        set('ready', 'message');
      } else if (!sawTurn) {
        // A turn longer than the window read: its outputs and reasoning.
        set('active', String(p.type ?? 'response_item'));
      }
    }
  }
  const updated = Math.max(last, mtime);
  return passiveRecord('codex', id, { state, since, updated, detail: oneLine(detail), event, cwd, started });
}

export function createCodexReader(): PassiveReader {
  const cache = fileCache((path, st) => parseRollout(path, st.size, st.mtimeMs));
  return ({ root, now, maxAgeMs }) => {
    const out: SessionView[] = [];
    for (const dir of dayDirs(root, now)) {
      for (const name of list(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        const st = recentFile(path, now, maxAgeMs);
        if (!st) continue;
        const rec = cache.get(path, st);
        if (rec) out.push(rec);
      }
    }
    cache.sweep();
    return out;
  };
}
