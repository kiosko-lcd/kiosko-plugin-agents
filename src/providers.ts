/**
 * The agents this plugin can read without a hook, from their own files.
 */
import { createCodexReader } from './readers/codex.ts';
import { createKimiReader } from './readers/kimi.ts';
import { createQwenReader } from './readers/qwen.ts';
import type { PassiveReader } from './readers/common.ts';

/** The agents read from their own files, and where those live by default. */
export const PASSIVE = {
  codex: { dir: '~/.codex', create: createCodexReader },
  qwen: { dir: '~/.qwen', create: createQwenReader },
  kimi: { dir: '~/.kimi', create: createKimiReader },
} as const satisfies Record<string, { dir: string; create: () => PassiveReader }>;

export type PassiveName = keyof typeof PASSIVE;
