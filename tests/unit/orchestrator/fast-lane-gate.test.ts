import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import gate from '../../../_Sprintpilot/lib/orchestrator/fast-lane-gate.js';

const {
  globToRegExp,
  matchesAnyGlob,
  countAcceptanceCriteria,
  countTasks,
  extractTag,
  tagFromFields,
  extractDeclaredPaths,
  extractStorySignals,
  normalizeConfig,
  evaluateSignals,
  classifyStory,
} = gate as {
  globToRegExp: (g: string) => RegExp;
  matchesAnyGlob: (p: string, globs: string[]) => boolean;
  countAcceptanceCriteria: (t: string) => number;
  countTasks: (t: string) => number;
  extractTag: (t: string) => 'fast' | 'full' | null;
  tagFromFields: (obj: unknown) => 'fast' | 'full' | null;
  extractDeclaredPaths: (t: string) => string[];
  extractStorySignals: (t: string) => {
    acCount: number;
    taskCount: number;
    tag: string | null;
    declaredPaths: string[];
  };
  normalizeConfig: (c: Record<string, unknown>) => {
    enabled: boolean;
    maxAc: number;
    allowGlobs: string[];
    denyGlobs: string[];
    requireStoryTag: boolean;
  };
  evaluateSignals: (
    s: Record<string, unknown>,
    c: Record<string, unknown>,
    opts?: { forcedFull?: boolean; fallbackTag?: 'fast' | 'full' | null },
  ) => { decision: 'fast' | 'full'; reasons: string[] };
  classifyStory: (a: {
    storyKey?: string;
    storyText?: string;
    config?: Record<string, unknown>;
    forcedFull?: boolean;
    fallbackTag?: 'fast' | 'full' | null;
  }) => { story_key: string | null; decision: 'fast' | 'full'; reasons: string[] };
};

const ENABLED = {
  fast_lane_enabled: true,
  fast_lane_max_ac: 3,
  fast_lane_allow_globs: ['docs/**', '**/*.md'],
  fast_lane_deny_globs: ['**/auth/**', '**/migrations/**', '**/*secret*'],
  fast_lane_require_story_tag: false,
};

describe('globToRegExp / matchesAnyGlob', () => {
  it('** matches across path separators, including the bare prefix', () => {
    expect(globToRegExp('docs/**').test('docs/a/b/c.md')).toBe(true);
    expect(globToRegExp('docs/**').test('docs')).toBe(true);
    expect(globToRegExp('docs/**').test('src/docs/a.md')).toBe(false);
  });

  it('* stops at a path separator', () => {
    expect(globToRegExp('*.md').test('README.md')).toBe(true);
    expect(globToRegExp('*.md').test('docs/README.md')).toBe(false);
    expect(globToRegExp('**/*.md').test('docs/a/README.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('README.md')).toBe(true);
  });

  it('**/segment/** matches whole path segments, not substrings', () => {
    // `**/auth/**` must match a real `auth` dir but NOT `oauth`.
    expect(globToRegExp('**/auth/**').test('src/auth/login.ts')).toBe(true);
    expect(globToRegExp('**/auth/**').test('auth/x')).toBe(true);
    expect(globToRegExp('**/auth/**').test('src/oauth/token.ts')).toBe(false);
    expect(globToRegExp('**/auth/**').test('src/oauthorize.ts')).toBe(false);
  });

  it('default secret deny covers both secret-named files and secret dirs (F4)', () => {
    // `**/*secret*` catches secret-named files; `**/*secret*/**` catches files
    // UNDER a secret-named directory whose basename lacks "secret".
    const deny = ['**/*secret*', '**/*secret*/**'];
    expect(matchesAnyGlob('config/secrets.yaml', deny)).toBe(true);
    expect(matchesAnyGlob('src/secrets/key.ts', deny)).toBe(true);
    expect(matchesAnyGlob('src/util/helper.ts', deny)).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    expect(globToRegExp('a.b+c').test('a.b+c')).toBe(true);
    expect(globToRegExp('a.b+c').test('axbxc')).toBe(false);
  });

  it('normalizes ./ prefixes and backslashes before matching', () => {
    expect(matchesAnyGlob('./docs/x.md', ['docs/**'])).toBe(true);
    expect(matchesAnyGlob('docs\\x.md', ['docs/**'])).toBe(true);
    expect(matchesAnyGlob('src/x.ts', [])).toBe(false);
  });
});

describe('story parsers', () => {
  it('counts acceptance criteria list items until the next heading', () => {
    const t = '## Acceptance Criteria\n- one\n- two\n1. three\n\n## Tasks\n- [ ] nope\n';
    expect(countAcceptanceCriteria(t)).toBe(3);
  });

  it('returns 0 AC when the section is absent', () => {
    expect(countAcceptanceCriteria('## Notes\n- x\n')).toBe(0);
  });

  it('counts task checkboxes under the Tasks section', () => {
    const t = '## Tasks / Subtasks\n- [ ] a\n  - [x] b\n- [ ] c\n';
    expect(countTasks(t)).toBe(3);
  });

  it('extracts explicit tags with full winning over fast', () => {
    expect(extractTag('fast_lane: true\n')).toBe('fast');
    expect(extractTag('risk: low\n')).toBe('fast');
    expect(extractTag('risk: high\n')).toBe('full');
    expect(extractTag('fast_lane: false\n')).toBe('full');
    // full-forcing signal wins even when a fast signal is also present
    expect(extractTag('risk: low\nrisk: high\n')).toBe('full');
    expect(extractTag('risk: medium\n')).toBe(null);
    expect(extractTag('no tags here')).toBe(null);
  });

  it('harvests declared paths from code spans and File List sections', () => {
    const t =
      'Touches `src/foo.ts` and the docs.\n\n## File List\n- `docs/guide.md`\n- README.md\n';
    const paths = extractDeclaredPaths(t);
    expect(paths).toContain('src/foo.ts');
    expect(paths).toContain('docs/guide.md');
    expect(paths).toContain('README.md');
  });

  it('extractStorySignals bundles the parsed fields', () => {
    const sig = extractStorySignals('risk: low\n## Acceptance Criteria\n- x\n');
    expect(sig).toMatchObject({ acCount: 1, tag: 'fast' });
  });
});

describe('tagFromFields (plan/epic entry tags)', () => {
  it('reads fast_lane + risk fields with full winning over fast', () => {
    expect(tagFromFields({ fast_lane: true })).toBe('fast');
    expect(tagFromFields({ fast_lane: false })).toBe('full');
    expect(tagFromFields({ fast_lane: 'yes' })).toBe('fast');
    expect(tagFromFields({ risk: 'low' })).toBe('fast');
    expect(tagFromFields({ risk: 'High' })).toBe('full');
    expect(tagFromFields({ risk: 'critical' })).toBe('full');
    expect(tagFromFields({ fast_lane: true, risk: 'high' })).toBe('full');
    expect(tagFromFields({ risk: 'medium' })).toBeNull();
    expect(tagFromFields({})).toBeNull();
    expect(tagFromFields(null)).toBeNull();
  });
});

describe('evaluateSignals — epic/plan fallback tag', () => {
  it('applies fallbackTag when the story file has no tag of its own', () => {
    const r = evaluateSignals({ tag: null, declaredPaths: [], acCount: 1 }, ENABLED, {
      fallbackTag: 'fast',
    });
    expect(r.decision).toBe('fast');
    expect(r.reasons).toContain('tag_force_fast:epic');
  });

  it('a story-file tag OVERRIDES the epic fallback tag', () => {
    const r = evaluateSignals({ tag: 'full', declaredPaths: [], acCount: 1 }, ENABLED, {
      fallbackTag: 'fast',
    });
    expect(r.decision).toBe('full');
    expect(r.reasons).toContain('tag_force_full');
  });

  it('an epic fallback fast tag does NOT satisfy require_story_tag', () => {
    // The knob means "only stories that tag THEMSELVES" — an epic tag can't
    // stand in for a per-story tag.
    const epicOnly = evaluateSignals(
      { tag: null, declaredPaths: [], acCount: 1 },
      {
        ...ENABLED,
        fast_lane_require_story_tag: true,
      },
      { fallbackTag: 'fast' },
    );
    expect(epicOnly.decision).toBe('full');
    expect(epicOnly.reasons).toContain('require_story_tag_unset');
    // but a STORY-FILE fast tag still qualifies under require_story_tag
    const storyTagged = evaluateSignals(
      { tag: 'fast', declaredPaths: [], acCount: 1 },
      {
        ...ENABLED,
        fast_lane_require_story_tag: true,
      },
    );
    expect(storyTagged.decision).toBe('fast');
  });

  it('an epic fallback tag is still subject to the deny-glob + AC gates', () => {
    const denied = evaluateSignals(
      { tag: null, declaredPaths: ['src/auth/x.ts'], acCount: 1 },
      ENABLED,
      { fallbackTag: 'fast' },
    );
    expect(denied.decision).toBe('full');
    const big = evaluateSignals({ tag: null, declaredPaths: [], acCount: 9 }, ENABLED, {
      fallbackTag: 'fast',
    });
    expect(big.decision).toBe('full');
  });
});

describe('normalizeConfig', () => {
  it('reads flat profile fields', () => {
    const c = normalizeConfig(ENABLED);
    expect(c).toMatchObject({ enabled: true, maxAc: 3, requireStoryTag: false });
    expect(c.allowGlobs).toEqual(['docs/**', '**/*.md']);
  });

  it('reads a nested { fast_lane: {...} } object', () => {
    const c = normalizeConfig({ fast_lane: { enabled: true, max_ac: 5, allow_globs: ['a/**'] } });
    expect(c).toMatchObject({ enabled: true, maxAc: 5 });
    expect(c.allowGlobs).toEqual(['a/**']);
  });

  it('defaults to disabled + empty globs on an empty config', () => {
    const c = normalizeConfig({});
    expect(c).toMatchObject({ enabled: false, maxAc: 3, allowGlobs: [], denyGlobs: [] });
  });

  it('falls back to the default max_ac on a negative / non-finite value (typo guard)', () => {
    expect(normalizeConfig({ fast_lane_max_ac: -1 }).maxAc).toBe(3);
    expect(normalizeConfig({ fast_lane_max_ac: Number.NaN }).maxAc).toBe(3);
    expect(normalizeConfig({ fast_lane_max_ac: 0 }).maxAc).toBe(0); // 0 is a valid (strict) budget
    expect(normalizeConfig({ fast_lane_max_ac: 5 }).maxAc).toBe(5);
  });
});

describe('evaluateSignals precedence', () => {
  it('forcedFull short-circuits everything', () => {
    const r = evaluateSignals({ tag: 'fast', declaredPaths: ['docs/x.md'], acCount: 1 }, ENABLED, {
      forcedFull: true,
    });
    expect(r.decision).toBe('full');
    expect(r.reasons).toContain('escalated_forced_full');
  });

  it('disabled config is always full', () => {
    const r = evaluateSignals(
      { tag: 'fast', declaredPaths: ['docs/x.md'] },
      {
        ...ENABLED,
        fast_lane_enabled: false,
      },
    );
    expect(r.decision).toBe('full');
  });

  it('deny glob beats an explicit fast tag (hard safety)', () => {
    const r = evaluateSignals(
      { tag: 'fast', declaredPaths: ['src/auth/login.ts'], acCount: 1 },
      ENABLED,
    );
    expect(r.decision).toBe('full');
    expect(r.reasons[0]).toMatch(/^deny_glob:/);
  });

  it('explicit full tag forces full', () => {
    const r = evaluateSignals({ tag: 'full', declaredPaths: ['docs/x.md'] }, ENABLED);
    expect(r.decision).toBe('full');
    expect(r.reasons).toContain('tag_force_full');
  });

  it('explicit fast tag routes fast even without allow-listed paths', () => {
    const r = evaluateSignals({ tag: 'fast', declaredPaths: [], acCount: 1 }, ENABLED);
    expect(r.decision).toBe('fast');
    expect(r.reasons).toContain('tag_force_fast');
  });

  it('an explicit fast tag CANNOT override the AC budget (size gate wins)', () => {
    // A large story with an incidental `risk: low` line must not fast-lane.
    const r = evaluateSignals({ tag: 'fast', declaredPaths: [], acCount: 9 }, ENABLED);
    expect(r.decision).toBe('full');
    expect(r.reasons[0]).toMatch(/^ac_count_9>3/);
  });

  it('require_story_tag forces full when untagged', () => {
    const r = evaluateSignals(
      { tag: null, declaredPaths: ['docs/x.md'], acCount: 1 },
      {
        ...ENABLED,
        fast_lane_require_story_tag: true,
      },
    );
    expect(r.decision).toBe('full');
    expect(r.reasons).toContain('require_story_tag_unset');
  });

  it('AC over budget forces full', () => {
    const r = evaluateSignals({ tag: null, declaredPaths: ['docs/x.md'], acCount: 4 }, ENABLED);
    expect(r.decision).toBe('full');
    expect(r.reasons[0]).toMatch(/^ac_count_4>3/);
  });

  it('infers fast when every declared path is allow-listed and AC in budget', () => {
    const r = evaluateSignals(
      { tag: null, declaredPaths: ['docs/a.md', 'README.md'], acCount: 2 },
      ENABLED,
    );
    expect(r.decision).toBe('fast');
    expect(r.reasons[0]).toMatch(/^inferred_low_risk/);
  });

  it('forces full when a declared path is outside the allow list', () => {
    const r = evaluateSignals(
      { tag: null, declaredPaths: ['docs/a.md', 'src/core.ts'], acCount: 1 },
      ENABLED,
    );
    expect(r.decision).toBe('full');
    expect(r.reasons[0]).toMatch(/^paths_outside_allow:/);
  });

  it('defaults full when no allow-listed paths are declared', () => {
    const r = evaluateSignals({ tag: null, declaredPaths: [], acCount: 1 }, ENABLED);
    expect(r.decision).toBe('full');
    expect(r.reasons).toContain('default_full_no_allowlisted_paths');
  });
});

describe('classifyStory end-to-end', () => {
  it('fast-lanes a small docs-only story', () => {
    const md = '## Acceptance Criteria\n- update guide\n\n## File List\n- `docs/guide.md`\n';
    const r = classifyStory({ storyKey: '1-1-docs', storyText: md, config: ENABLED });
    expect(r).toMatchObject({ story_key: '1-1-docs', decision: 'fast' });
  });

  it('keeps a security story on the full cycle even if tagged fast', () => {
    const md =
      'fast_lane: true\n## Acceptance Criteria\n- x\n## File List\n- `src/auth/login.ts`\n';
    const r = classifyStory({ storyKey: '2-1-auth', storyText: md, config: ENABLED });
    expect(r.decision).toBe('full');
  });

  it('empty story text (missing file) is conservatively full', () => {
    const r = classifyStory({ storyKey: '3-1', storyText: '', config: ENABLED });
    expect(r.decision).toBe('full');
  });
});
