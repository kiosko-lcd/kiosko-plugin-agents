/**
 * Small, bounded file reads for the passive readers: they look at other
 * programs' session logs, which can be many megabytes, so they only ever read
 * the first line and the last few kilobytes, and never follow symlinks.
 */
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact } from '@loksly/agent-sessions';

/** `~` and `~/…` → the home directory. */
export function expandHome(dir: string, home = homedir()): string {
  const d = dir.trim();
  if (d === '~') return home;
  if (d.startsWith('~/')) return join(home, d.slice(2));
  return d;
}

/** lstat that returns undefined instead of throwing. */
export function statOf(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Names in a directory, or none if it can't be read. */
export function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A regular file (not a symlink, not a folder), modified within `maxAgeMs`. */
export function recentFile(path: string, now: number, maxAgeMs: number): Stats | undefined {
  const st = statOf(path);
  if (!st || !st.isFile()) return undefined;
  return now - st.mtimeMs <= maxAgeMs ? st : undefined;
}

function readRange(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, Math.min(start, size));
    const n = Math.max(0, Math.min(length, size - from));
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const got = readSync(fd, buf, off, n - off, from + off);
      if (got <= 0) break;
      off += got;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The first line of a file, if it ends within `maxBytes`. */
export function firstLine(path: string, maxBytes = 256 * 1024): string | undefined {
  try {
    const text = readRange(path, 0, maxBytes);
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The complete lines in the last `maxBytes` of a file, oldest first. The
 * first one is dropped when the window starts mid-line; a last line without
 * its newline (being written) is dropped too.
 */
export function lastLines(path: string, size: number, maxBytes = 64 * 1024): string[] {
  try {
    const start = Math.max(0, size - maxBytes);
    const text = readRange(path, start, size - start);
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    lines.pop(); // after the last newline: empty, or a line still being written
    return lines.filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** JSON.parse that returns undefined for anything but an object. */
export function parseObject(line: string): Record<string, any> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One line, at most `max` characters, for a tile's detail. Secrets are
 * redacted before cutting, as the hook does: the panel may be in sight of
 * anyone walking by.
 */
export function oneLine(text: unknown, max = 240): string {
  if (typeof text !== 'string') return '';
  const flat = redact(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** ISO date or epoch (ms, or seconds if it looks like seconds) → ms; NaN if neither. */
export function toMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}
