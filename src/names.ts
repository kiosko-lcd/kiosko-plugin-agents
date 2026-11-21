/**
 * How each agent is called on a tile. Any other provider name (from the
 * hook's `--provider` or a status file's `agent`) is shown as written.
 */

/** Display names, short enough for a tile's corner. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  gemini: 'Gemini',
  qwen: 'Qwen',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  iflow: 'iFlow',
  calendar: 'Calendar',
};

/** `qwen` → `Qwen`; unknown names as they came. */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}
