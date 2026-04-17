/**
 * Neutralize any ambient git signing configuration for the duration of the
 * test process.
 *
 * Some CI/dev environments enforce `commit.gpgsign=true` + a custom signing
 * program via ~/.gitconfig. That breaks e2e tests that need to produce real
 * commits inside throwaway fixture repos (and inside subprocesses spawned by
 * the autopilot).
 *
 * `GIT_CONFIG_COUNT/KEY_N/VALUE_N` env vars are applied by git on top of all
 * file-based configs, so they override whatever is in ~/.gitconfig. Because
 * we mutate `process.env`, child processes spawned via child_process inherit
 * the overrides automatically.
 *
 * Importing this module (for its side effects) is enough — no call needed.
 */

const overrides: Array<[string, string]> = [
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['gpg.format', 'openpgp'],
];

const existing = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10);
let index = Number.isFinite(existing) && existing > 0 ? existing : 0;

for (const [key, value] of overrides) {
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  index += 1;
}

process.env.GIT_CONFIG_COUNT = String(index);
