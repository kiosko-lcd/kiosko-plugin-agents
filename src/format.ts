import type { Formatters } from '@kiosko/sdk';

/**
 * Time spent in a state, in large type. Minute granularity on purpose: the
 * widget repaints once a minute, so seconds on screen would lie with false
 * precision; and "18 min" reads at a glance better than "18:07". Under a
 * minute it is `nowWord`, the localized "now".
 */
export function elapsed(fmt: Formatters, ms: number, nowWord: string): string {
  return ms < 60_000 ? nowWord : fmt.duration(ms);
}

/** Short, stable id to recognise the console on its tile. */
export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

/** Size in whole GB, the unit people think RAM and disks in. */
export function gigabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)}GB`;
}
