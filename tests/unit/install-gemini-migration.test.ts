import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import installMod from '../../lib/commands/install.js';

const {
  _internals: {
    detectInstalledTools,
    evictLegacyGeminiSprintpilotSkills,
    hasLegacyGeminiSprintpilotSkills,
  },
} = installMod as {
  _internals: {
    detectInstalledTools: (projectRoot: string) => Promise<string[]>;
    evictLegacyGeminiSprintpilotSkills: (
      projectRoot: string,
      backupDir: string,
      ts: string,
      opts?: { dryRun?: boolean },
    ) => Promise<string[]>;
    hasLegacyGeminiSprintpilotSkills: (projectRoot: string) => Promise<boolean>;
  };
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'install-gemini-migration-'));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedSkill(dir: string, name: string, body = 'SKILL.md content') {
  const full = join(dir, name);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'SKILL.md'), body, 'utf8');
}

describe('gemini-cli .gemini → .agents migration', () => {
  describe('hasLegacyGeminiSprintpilotSkills', () => {
    it('returns false when .gemini/ is absent', async () => {
      expect(await hasLegacyGeminiSprintpilotSkills(root)).toBe(false);
    });

    it('returns false when .gemini/skills/ has only user-defined skills', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'my-custom-skill');
      seedSkill(legacySkills, 'another-user-skill');
      expect(await hasLegacyGeminiSprintpilotSkills(root)).toBe(false);
    });

    it('returns true when .gemini/skills/sprint-autopilot-* is present', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprint-autopilot-on');
      expect(await hasLegacyGeminiSprintpilotSkills(root)).toBe(true);
    });

    it('returns true when .gemini/skills/sprintpilot-* is present', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprintpilot-plan-sprint');
      expect(await hasLegacyGeminiSprintpilotSkills(root)).toBe(true);
    });
  });

  describe('detectInstalledTools', () => {
    it('auto-detects gemini-cli when legacy .gemini/skills/sprint-* exists but .agents/ is absent', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprint-autopilot-on');
      const detected = await detectInstalledTools(root);
      expect(detected).toContain('gemini-cli');
    });

    it('auto-detects gemini-cli via new .agents/skills/ location', async () => {
      const newSkills = join(root, '.agents', 'skills');
      mkdirSync(newSkills, { recursive: true });
      const detected = await detectInstalledTools(root);
      expect(detected).toContain('gemini-cli');
    });

    it('does NOT detect gemini-cli when .gemini/skills/ has only user skills', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'my-custom-skill');
      const detected = await detectInstalledTools(root);
      expect(detected).not.toContain('gemini-cli');
    });
  });

  describe('evictLegacyGeminiSprintpilotSkills', () => {
    it('returns [] when .gemini/skills/ is absent', async () => {
      const backupDir = join(root, '.agents', '.sprintpilot-backups');
      const evicted = await evictLegacyGeminiSprintpilotSkills(root, backupDir, '20260601000000');
      expect(evicted).toEqual([]);
    });

    it('evicts sprint-autopilot-* and sprintpilot-* dirs, backing them up', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprint-autopilot-on');
      seedSkill(legacySkills, 'sprintpilot-plan-sprint');
      seedSkill(legacySkills, 'my-custom-skill');

      const backupDir = join(root, '.agents', '.sprintpilot-backups');
      const evicted = await evictLegacyGeminiSprintpilotSkills(root, backupDir, '20260601000000');

      expect(evicted.sort()).toEqual(['sprint-autopilot-on', 'sprintpilot-plan-sprint']);
      // Sprintpilot dirs gone from legacy location
      expect(existsSync(join(legacySkills, 'sprint-autopilot-on'))).toBe(false);
      expect(existsSync(join(legacySkills, 'sprintpilot-plan-sprint'))).toBe(false);
      // User skill untouched
      expect(existsSync(join(legacySkills, 'my-custom-skill', 'SKILL.md'))).toBe(true);
      // Backups landed in NEW tool dir's backup folder
      expect(existsSync(join(backupDir, 'sprint-autopilot-on.20260601000000', 'SKILL.md'))).toBe(
        true,
      );
      expect(
        existsSync(join(backupDir, 'sprintpilot-plan-sprint.20260601000000', 'SKILL.md')),
      ).toBe(true);
    });

    it('leaves user-defined skills under .gemini/skills/ strictly alone', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprint-autopilot-on', 'sprintpilot');
      seedSkill(legacySkills, 'user-skill-a', 'user A');
      seedSkill(legacySkills, 'user-skill-b', 'user B');

      const backupDir = join(root, '.agents', '.sprintpilot-backups');
      await evictLegacyGeminiSprintpilotSkills(root, backupDir, '20260601000000');

      const remaining = readdirSync(legacySkills).sort();
      expect(remaining).toEqual(['user-skill-a', 'user-skill-b']);
    });

    it('is idempotent — second run finds nothing to evict', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprint-autopilot-on');

      const backupDir = join(root, '.agents', '.sprintpilot-backups');
      const first = await evictLegacyGeminiSprintpilotSkills(root, backupDir, '20260601000000');
      const second = await evictLegacyGeminiSprintpilotSkills(root, backupDir, '20260601000001');

      expect(first).toEqual(['sprint-autopilot-on']);
      expect(second).toEqual([]);
    });

    it('dryRun reports what would be evicted but performs no writes', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprint-autopilot-on');

      const backupDir = join(root, '.agents', '.sprintpilot-backups');
      const evicted = await evictLegacyGeminiSprintpilotSkills(root, backupDir, '20260601000000', {
        dryRun: true,
      });

      expect(evicted).toEqual(['sprint-autopilot-on']);
      // Source still in place
      expect(existsSync(join(legacySkills, 'sprint-autopilot-on'))).toBe(true);
      // No backup written
      expect(existsSync(backupDir)).toBe(false);
    });

    it('does not touch non-Sprintpilot-prefix dirs even when they look adjacent', async () => {
      const legacySkills = join(root, '.gemini', 'skills');
      mkdirSync(legacySkills, { recursive: true });
      seedSkill(legacySkills, 'sprint-something-else'); // no match — prefix is 'sprint-autopilot-'
      seedSkill(legacySkills, 'pilot-sprintpilot-fake'); // no match — prefix doesn't start at name[0]

      const backupDir = join(root, '.agents', '.sprintpilot-backups');
      const evicted = await evictLegacyGeminiSprintpilotSkills(root, backupDir, '20260601000000');

      expect(evicted).toEqual([]);
      expect(existsSync(join(legacySkills, 'sprint-something-else'))).toBe(true);
      expect(existsSync(join(legacySkills, 'pilot-sprintpilot-fake'))).toBe(true);
    });
  });
});
