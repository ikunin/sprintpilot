import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};

describe('profile-rules: testing.* knobs', () => {
  it('defaults to affected/full/ci/null when not set', () => {
    const p = flatToProfile({}, 'medium');
    expect(p.testing_scope).toBe('affected');
    expect(p.testing_fallback).toBe('full');
    expect(p.testing_full_suite_on_story_land).toBe('ci');
    expect(p.testing_commands_affected).toBeNull();
    expect(p.testing_commands_full).toBeNull();
  });

  it('reads testing.scope override', () => {
    const p = flatToProfile({ testing: { scope: 'full' } }, 'medium');
    expect(p.testing_scope).toBe('full');
  });

  it('reads testing.fallback override', () => {
    const p = flatToProfile({ testing: { fallback: 'halt' } }, 'medium');
    expect(p.testing_fallback).toBe('halt');
  });

  it('reads testing.full_suite_on_story_land override', () => {
    const p = flatToProfile({ testing: { full_suite_on_story_land: 'skip' } }, 'medium');
    expect(p.testing_full_suite_on_story_land).toBe('skip');
  });

  it('reads testing.commands.{affected,full} string overrides', () => {
    const p = flatToProfile(
      {
        testing: {
          commands: {
            affected: 'pnpm test:affected',
            full: 'pnpm test:full',
          },
        },
      },
      'medium',
    );
    expect(p.testing_commands_affected).toBe('pnpm test:affected');
    expect(p.testing_commands_full).toBe('pnpm test:full');
  });

  it('rejects invalid scope, falling back to default', () => {
    const p = flatToProfile({ testing: { scope: 'sometimes' } }, 'medium');
    expect(p.testing_scope).toBe('affected');
  });

  it('ignores non-string testing.commands values', () => {
    const p = flatToProfile(
      { testing: { commands: { affected: 42, full: { not: 'a string' } } } },
      'medium',
    );
    expect(p.testing_commands_affected).toBeNull();
    expect(p.testing_commands_full).toBeNull();
  });
});
