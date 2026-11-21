/**
 * What every passive reader shares: the record it builds and a cache that
 * re-reads a log only when it changed.
 */
import { basename } from 'node:path';
import type { Stats } from 'node:fs';
import type { SessionState, SessionView } from '../types.ts';

export interface ReaderOptions {
  /** The agent's own data folder (`~/.codex`, `~/.qwen`…), already expanded. */
  root: string;
  now: number;
  /** Logs not written for this long are not even opened. */
  maxAgeMs: number;
}

/** Reads the live sessions of one agent from its own files. Never throws. */
export type PassiveReader = (o: ReaderOptions) => SessionView[];

export interface Derived {
  state: SessionState;
  /** When it entered `state`, ms epoch. */
  since: number;
  /** Last activity seen, ms epoch. */
  updated: number;
  detail: string;
  /** What in the log said so (`task_complete`, `TurnEnd`…), for debugging. */
  event: string;
  cwd?: string;
  started?: number;
}

export function passiveRecord(provider: string, id: string, d: Derived): SessionView {
  const rec: SessionView = {
    schemaVersion: 1,
    session_id: id,
    provider,
    state: d.state,
    detail: d.detail,
    project: d.cwd ? basename(d.cwd) : id.slice(0, 8),
    since: Math.min(d.since, d.updated),
    updated: d.updated,
    event: d.event,
  };
  if (d.cwd) rec.cwd = d.cwd;
  if (d.started !== undefined && Number.isFinite(d.started)) rec.started = d.started;
  return rec;
}

/**
 * Memoises a per-file parse by path, size and mtime: a poll every few seconds
 * then costs one `lstat` per recent log, and a read only for the ones that
 * grew. Entries for files that were not asked about in a pass are dropped.
 */
export function fileCache<T>(parse: (path: string, st: Stats) => T) {
  let entries = new Map<string, { size: number; mtime: number; value: T }>();
  let seen = new Map<string, { size: number; mtime: number; value: T }>();
  return {
    get(path: string, st: Stats): T {
      const hit = entries.get(path) ?? seen.get(path);
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
        seen.set(path, hit);
        return hit.value;
      }
      const value = parse(path, st);
      seen.set(path, { size: st.size, mtime: st.mtimeMs, value });
      return value;
    },
    /** Call at the end of a pass. */
    sweep() {
      entries = seen;
      seen = new Map();
    },
  };
}
