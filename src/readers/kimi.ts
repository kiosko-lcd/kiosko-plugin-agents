/**
 * Kimi Code CLI (MoonshotAI/kimi-cli), read from its own session logs: no hook
 * needed.
 *
 * Where (docs/en/configuration/data-locations.md): `~/.kimi/` (or
 * `$KIMI_SHARE_DIR`) holds `kimi.json`, whose `work_dirs[]` lists
 * `{ path, kaos }`, and `sessions/<md5 of path>/<session id>/wire.jsonl`, the
 * log of Wire events (a folder of another KAOS is `<kaos>_<md5>`). Each line
 * is `{ timestamp: <epoch s>, message: { type, payload } }` after a first
 * `{ type: "metadata", protocol_version }` line. Types used here (Wire
 * protocol, docs/en/customization/wire-mode.md): `TurnBegin` (`user_input`),
 * `StepBegin`, `ToolCall` (`function.name`), `TurnEnd`, `StepInterrupted`,
 * `ApprovalRequest` / `ApprovalResponse`, `QuestionRequest`.
 * Source: src/kimi_cli/metadata.py (`WorkDirMeta.sessions_dir`),
 * src/kimi_cli/wire/file.py and src/kimi_cli/wire/types.py in
 * https://github.com/MoonshotAI/kimi-cli.
 *
 * What it can tell: working, ready (turn ended), waiting (interrupted, or a
 * question for you) and, when the approval travels through the Wire log,
 * permission. The interactive shell shows approvals from its own hub without
 * logging them, so there a prompt reads as "working": wire Kimi's
 * Notification `permission_prompt` hook for that (see the README).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileCache, passiveRecord, type PassiveReader } from './common.ts';
import { lastLines, list, oneLine, parseObject, recentFile, statOf, toMs } from './files.ts';
import type { SessionView } from '../types.ts';

/** Session folder name → working directory, from `kimi.json`. */
export function workDirs(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const path = join(root, 'kimi.json');
  const st = statOf(path);
  if (!st?.isFile() || st.size > 4 * 1024 * 1024) return map;
  try {
    const meta = parseObject(readFileSync(path, 'utf8'));
    for (const wd of Array.isArray(meta?.work_dirs) ? meta.work_dirs : []) {
      if (typeof wd?.path !== 'string') continue;
      const md5 = createHash('md5').update(wd.path, 'utf8').digest('hex');
      const kaos = typeof wd.kaos === 'string' ? wd.kaos : 'local';
      map.set(kaos === 'local' ? md5 : `${kaos}_${md5}`, wd.path);
    }
  } catch {
    // No names: the tiles show the session id instead.
  }
  return map;
}

function inputText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
}

/** The session in one wire log, or null if there is nothing to show. */
export function parseKimiWire(path: string, size: number, mtime: number, id: string, cwd?: string): SessionView | null {
  let state: SessionView['state'] | undefined;
  let since = mtime;
  let last = 0;
  let detail = '';
  let event = '';
  const pending = new Set<string>();
  for (const line of lastLines(path, size, 256 * 1024)) {
    const o = parseObject(line);
    const msg = o?.message;
    if (!msg || typeof msg.type !== 'string') continue;
    const p = (msg.payload ?? {}) as Record<string, any>;
    const ts = toMs(o!.timestamp);
    const at = Number.isFinite(ts) ? ts : last || mtime;
    last = Math.max(last, at);
    const set = (s: SessionView['state']) => {
      if (s !== state) since = at;
      state = s;
      event = msg.type;
    };
    switch (msg.type) {
      case 'TurnBegin':
      case 'SteerInput':
        set('active');
        detail = inputText(p.user_input) || detail;
        break;
      case 'StepBegin':
      case 'ToolResult':
        if (!pending.size) set('active');
        break;
      case 'ToolCall':
        if (!pending.size) set('active');
        if (typeof p.function?.name === 'string') detail = p.function.name;
        break;
      case 'TurnEnd':
        pending.clear();
        set('ready');
        break;
      case 'StepInterrupted':
        pending.clear();
        set('waiting');
        detail = 'Interrupted';
        break;
      case 'ApprovalRequest':
        if (typeof p.id === 'string') pending.add(p.id);
        set('permission');
        detail = [p.sender, p.description || p.action].filter((v) => typeof v === 'string' && v).join(': ');
        break;
      case 'ApprovalResponse':
      case 'ApprovalRequestResolved':
        if (typeof p.request_id === 'string') pending.delete(p.request_id);
        if (!pending.size) set('active');
        break;
      case 'QuestionRequest':
        set('waiting');
        detail = typeof p.questions?.[0]?.question === 'string' ? p.questions[0].question : detail;
        break;
    }
  }
  if (!state) return null;
  return passiveRecord('kimi', id, { state, since, updated: Math.max(last, mtime), detail: oneLine(detail), event, cwd });
}

export function createKimiReader(): PassiveReader {
  // Read once per pass, and only if some log changed.
  let dirs: (() => Map<string, string>) | undefined;
  const cache = fileCache((path, st) => {
    const parts = path.split(/[\\/]/);
    const id = parts[parts.length - 2] ?? '';
    return parseKimiWire(path, st.size, st.mtimeMs, id, dirs?.().get(parts[parts.length - 3] ?? ''));
  });
  return ({ root, now, maxAgeMs }) => {
    let names: Map<string, string> | undefined;
    dirs = () => (names ??= workDirs(root));
    const out: SessionView[] = [];
    const sessions = join(root, 'sessions');
    for (const hash of list(sessions)) {
      for (const id of list(join(sessions, hash))) {
        const path = join(sessions, hash, id, 'wire.jsonl');
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
