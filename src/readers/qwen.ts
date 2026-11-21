/**
 * Qwen Code (QwenLM/qwen-code), read from its own chat logs: no hook needed.
 *
 * Where: `~/.qwen/projects/<cwd with every non-alphanumeric character as
 * "-">/chats/<session id>.jsonl` (the base moves with `QWEN_RUNTIME_DIR`),
 * one `ChatRecord` per line: `{ sessionId, timestamp, type: 'user' |
 * 'assistant' | 'tool_result' | 'system', subtype?, cwd, message?: { role,
 * parts } }`. Next to it, interactive sessions keep
 * `<session id>.runtime.json` (`{ pid, hostname, session_id, work_dir, … }`)
 * "so external observers can find live sessions": a dead `pid` on this
 * machine means the session ended.
 * Source, in https://github.com/QwenLM/qwen-code: packages/core/src/config/
 * storage.ts (`getProjectDir`, `getRuntimeStatusPath`), utils/paths.ts
 * (`sanitizeCwd`), services/chatRecordingService.ts (`ChatRecord`) and
 * utils/runtimeStatus.ts.
 *
 * What it can tell: working (your prompt or a tool result is the last thing,
 * or the model asked for a tool), ready (the model answered). A permission
 * prompt is not written to the log: for "waiting for your permission", wire
 * Qwen Code's hooks (Notification `permission_prompt`, PermissionRequest; see
 * the README), which it shares with Claude Code.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileCache, passiveRecord, type PassiveReader } from './common.ts';
import { lastLines, list, oneLine, parseObject, recentFile, statOf, toMs } from './files.ts';
import type { SessionView } from '../types.ts';

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string };
}

const ARG_KEYS = ['command', 'file_path', 'absolute_path', 'path', 'pattern', 'url', 'query', 'prompt'];

function partsOf(r: Record<string, any>): Part[] {
  const parts = r.message?.parts;
  return Array.isArray(parts) ? (parts as Part[]) : [];
}

function textOf(parts: Part[]): string {
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join(' ');
}

function callDetail(c: NonNullable<Part['functionCall']>): string {
  const name = String(c.name ?? 'tool');
  const args = c.args ?? {};
  for (const k of ARG_KEYS) if (typeof args[k] === 'string' && args[k]) return `${name}: ${String(args[k])}`;
  return name;
}

/** The session in one chat log, or null if there is nothing to show. */
export function parseQwenChat(path: string, size: number, mtime: number): SessionView | null {
  let id = (path.split(/[\\/]/).pop() ?? '').replace(/\.jsonl$/, '');
  let cwd: string | undefined;
  let state: SessionView['state'] | undefined;
  let since = mtime;
  let last = 0;
  let detail = '';
  let event = '';
  for (const line of lastLines(path, size, 256 * 1024)) {
    const r = parseObject(line);
    if (!r || typeof r.type !== 'string') continue;
    // Sub-agent records belong to their own runs.
    if (r.isSidechain || r.agentId) continue;
    const ts = toMs(r.timestamp);
    const at = Number.isFinite(ts) ? ts : last || mtime;
    last = Math.max(last, at);
    if (typeof r.sessionId === 'string') id = r.sessionId;
    if (typeof r.cwd === 'string') cwd = r.cwd;
    const set = (s: SessionView['state'], ev: string) => {
      if (s !== state) since = at;
      state = s;
      event = ev;
    };
    const parts = partsOf(r);
    if (r.type === 'user') {
      // Background notifications and agent-to-agent messages are not your prompt.
      if (r.subtype === 'notification' || r.subtype === 'agent_mention' || r.subtype === 'agent_message') continue;
      set('active', 'user');
      detail = textOf(parts) || detail;
    } else if (r.type === 'tool_result') {
      set('active', 'tool_result');
    } else if (r.type === 'assistant') {
      const call = parts.find((p) => p.functionCall)?.functionCall;
      if (call) {
        set('active', 'assistant');
        detail = callDetail(call);
      } else {
        set('ready', 'assistant');
        detail = textOf(parts) || detail;
      }
    } else if (r.type === 'system' && r.subtype === 'turn_result') {
      const s = r.systemPayload?.state;
      if (s === 'cancelled') set('waiting', 'turn_result');
      else if (s === 'completed' || s === 'error') set('ready', 'turn_result');
    }
  }
  if (!state) return null;
  return passiveRecord('qwen', id, { state, since, updated: Math.max(last, mtime), detail: oneLine(detail), event, cwd });
}

/** Is the process the sidecar names gone? Only judged for this machine. */
export function sidecarSaysEnded(path: string, host = hostname(), alive = isAlive): boolean {
  const st = statOf(path);
  if (!st?.isFile() || st.size > 16 * 1024) return false;
  let side: Record<string, any> | undefined;
  try {
    side = parseObject(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  if (!side || typeof side.pid !== 'number' || side.hostname !== host) return false;
  return !alive(side.pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createQwenReader(): PassiveReader {
  const cache = fileCache((path, st) => parseQwenChat(path, st.size, st.mtimeMs));
  return ({ root, now, maxAgeMs }) => {
    const out: SessionView[] = [];
    const projects = join(root, 'projects');
    for (const project of list(projects)) {
      const chats = join(projects, project, 'chats');
      for (const name of list(chats)) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(chats, name);
        const st = recentFile(path, now, maxAgeMs);
        if (!st) continue;
        const rec = cache.get(path, st);
        if (!rec) continue;
        if (sidecarSaysEnded(join(chats, `${name.slice(0, -'.jsonl'.length)}.runtime.json`))) continue;
        out.push(rec);
      }
    }
    cache.sweep();
    return out;
  };
}
