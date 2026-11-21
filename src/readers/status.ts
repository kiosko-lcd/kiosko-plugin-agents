/**
 * The generic input: a folder of tiny JSON status files that any agent with
 * hooks, or any script, can write. One file per session:
 *
 *     ~/.config/kiosko/agents/<anything>.json
 *     { "agent": "opencode", "id": "ses_42", "state": "permission",
 *       "cwd": "/home/me/web-app", "detail": "bash: npm publish",
 *       "updated": 1790000000000 }
 *
 * `state`: `working` | `permission` | `input` | `done` | `idle` (or this
 * protocol's own names: `active`, `waiting`, `ready`). Only `agent` and
 * `state` are required: `id` defaults to the file name, `updated` to the
 * file's modification time. Delete the file when the session ends.
 *
 * Reading it is defensive, since anything that can write a file there can
 * make it say anything: regular files only (no symlinks), at most 16 KiB
 * each and 200 per pass, names and ids from a small alphabet, text cut to
 * one line. Nothing is ever written or deleted here: the folder is yours.
 * There is no network listener; a file is the whole interface.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { passiveRecord, type PassiveReader } from './common.ts';
import { list, oneLine, parseObject, statOf, toMs } from './files.ts';
import type { SessionState, SessionView } from '../types.ts';

export const STATUS_MAX_BYTES = 16 * 1024;
export const STATUS_MAX_FILES = 200;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Friendly words → protocol states. */
const STATES: Record<string, SessionState> = {
  working: 'active',
  active: 'active',
  busy: 'active',
  permission: 'permission',
  approval: 'permission',
  input: 'waiting',
  waiting: 'waiting',
  question: 'waiting',
  done: 'ready',
  ready: 'ready',
  idle: 'idle',
};

/** A status file's contents as a session, or null if it is not valid. */
export function parseStatus(raw: unknown, fileId: string, mtime: number, now: number): (Omit<SessionView, 'since'> & { since?: number }) | null {
  const o = typeof raw === 'string' ? parseObject(raw) : (raw as Record<string, any> | undefined);
  if (!o) return null;
  const agent = typeof o.agent === 'string' ? o.agent.trim().toLowerCase() : '';
  const state = typeof o.state === 'string' ? STATES[o.state.trim().toLowerCase()] : undefined;
  if (!NAME.test(agent) || !state) return null;
  const id = typeof o.id === 'string' && o.id.length <= 128 && /^[\w.:@-]+$/.test(o.id) ? o.id : fileId;
  const cwd = typeof o.cwd === 'string' && o.cwd.length <= 1024 && isAbsolute(o.cwd) ? o.cwd : undefined;
  const t = toMs(o.updated);
  // A clock in the future would keep it alive forever.
  const updated = Math.min(Number.isFinite(t) ? t : mtime, now);
  const s = toMs(o.since);
  const rec = passiveRecord(agent, id, { state, since: Number.isFinite(s) ? s : updated, updated, detail: oneLine(o.detail), event: 'status-file', cwd });
  return Number.isFinite(s) ? rec : { ...rec, since: undefined };
}

export function createStatusReader(): PassiveReader {
  // When each session entered its state, for files that don't say.
  const entered = new Map<string, { state: SessionState; since: number }>();
  return ({ root, now, maxAgeMs }) => {
    const out: SessionView[] = [];
    const keep = new Set<string>();
    let n = 0;
    for (const name of list(root).sort()) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      if (++n > STATUS_MAX_FILES) break;
      const path = join(root, name);
      const st = statOf(path);
      if (!st?.isFile() || st.size > STATUS_MAX_BYTES || now - st.mtimeMs > maxAgeMs) continue;
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const stem = name.slice(0, -'.json'.length);
      const rec = parseStatus(text, NAME.test(stem) ? stem : 'status', st.mtimeMs, now);
      if (!rec) continue;
      const key = `${rec.provider}/${rec.session_id}`;
      keep.add(key);
      let since = rec.since;
      if (since === undefined) {
        const prev = entered.get(key);
        since = prev && prev.state === rec.state ? prev.since : rec.updated;
      }
      entered.set(key, { state: rec.state, since });
      out.push({ ...rec, since });
    }
    for (const k of entered.keys()) if (!keep.has(k)) entered.delete(k);
    return out;
  };
}
