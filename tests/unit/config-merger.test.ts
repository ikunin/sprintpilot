import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import mergerMod from '../../lib/core/config-merger.js';

const { mergeYamlConfig, mergeTemplateFile, _internals } = mergerMod as {
  mergeYamlConfig: (
    bundledText: string,
    userText: string,
    keyRenames?: Record<string, string>,
  ) => {
    text: string;
    preserved: string[];
    orphans: string[];
    fallback: boolean;
  };
  mergeTemplateFile: (
    bundledText: string,
    userText: string | null,
  ) => { kept: 'user' | 'bundled'; text: string; sidecar: string | null };
  _internals: {
    parseFlat: (text: string) => Record<string, string>;
    patchScalarInPlace: (text: string, dotPath: string, newValue: string) => string;
    splitInlineComment: (rest: string) => { value: string; trailing: string };
  };
};

describe('parseFlat', () => {
  it('parses simple scalar config into dot-paths', () => {
    const text = ['git:', '  enabled: true', '  base_branch: main'].join('\n');
    expect(_internals.parseFlat(text)).toEqual({
      'git.enabled': 'true',
      'git.base_branch': 'main',
    });
  });

  it('handles nested containers with inline comments', () => {
    const text = [
      '# Header comment',
      'git:',
      '  enabled: true # false = skip all git ops',
      '  push:',
      '    auto: true',
      '    create_pr: false',
      '',
      '  # Section divider',
      '  merge_strategy: stacked',
    ].join('\n');
    expect(_internals.parseFlat(text)).toEqual({
      'git.enabled': 'true',
      'git.push.auto': 'true',
      'git.push.create_pr': 'false',
      'git.merge_strategy': 'stacked',
    });
  });

  it('ignores list items and unparseable lines', () => {
    const text = ['linters:', '  - ruff', '  - flake8', 'count: 2'].join('\n');
    expect(_internals.parseFlat(text)).toEqual({ count: '2' });
  });
});

describe('splitInlineComment', () => {
  it('separates value and trailing comment', () => {
    expect(_internals.splitInlineComment('true # always')).toEqual({
      value: 'true',
      trailing: '# always',
    });
  });

  it('leaves quoted hashes alone', () => {
    expect(_internals.splitInlineComment('"a#b" # comment')).toEqual({
      value: '"a#b"',
      trailing: '# comment',
    });
  });

  it('returns full value when no comment present', () => {
    expect(_internals.splitInlineComment('main')).toEqual({ value: 'main', trailing: '' });
  });
});

describe('mergeYamlConfig', () => {
  const bundled = [
    '# Git config',
    'git:',
    '  enabled: true # toggle',
    '  base_branch: main',
    '',
    '  # Branch granularity',
    '  granularity: story',
    '',
    '  push:',
    '    auto: true',
    '    create_pr: true',
    '',
    '  # New in 2.1.2 — added in bundled, missing from user file',
    '  merge_strategy: stacked',
    '',
  ].join('\n');

  it('preserves a top-level user scalar (granularity: epic)', () => {
    const user = ['git:', '  enabled: true', '  granularity: epic'].join('\n');
    const r = mergeYamlConfig(bundled, user, {});
    expect(r.preserved).toEqual(['git.granularity']);
    expect(r.orphans).toEqual([]);
    expect(r.fallback).toBe(false);
    expect(r.text).toContain('granularity: epic');
    // Bundled comment must survive next to the patched line.
    expect(r.text).toContain('# Branch granularity');
  });

  it('preserves a nested user scalar (git.push.create_pr: false)', () => {
    const user = ['git:', '  push:', '    create_pr: false'].join('\n');
    const r = mergeYamlConfig(bundled, user, {});
    expect(r.preserved).toEqual(['git.push.create_pr']);
    expect(r.text).toContain('    create_pr: false');
    // Auto stays at the bundled default since user didn't customize.
    expect(r.text).toContain('auto: true');
  });

  it('adds a new bundled key the user did not have', () => {
    const user = ['git:', '  enabled: true'].join('\n');
    const r = mergeYamlConfig(bundled, user, {});
    // merge_strategy is only in bundled — should still be present.
    expect(r.text).toContain('merge_strategy: stacked');
    expect(r.preserved).toEqual([]);
  });

  it('preserves bundled inline comments verbatim', () => {
    const user = ['git:', '  enabled: false'].join('\n');
    const r = mergeYamlConfig(bundled, user, {});
    expect(r.text).toContain('enabled: false # toggle');
  });

  it('renames a key per the KEY_RENAMES map', () => {
    const renames = { 'git.legacy_strategy': 'git.merge_strategy' };
    const user = ['git:', '  legacy_strategy: land_as_you_go'].join('\n');
    const r = mergeYamlConfig(bundled, user, renames);
    expect(r.preserved).toEqual(['git.merge_strategy']);
    expect(r.text).toContain('merge_strategy: land_as_you_go');
  });

  it('appends unknown user keys under a "Preserved from prior install" footer (re-pasteable nested YAML)', () => {
    const user = ['git:', '  custom_knob: 42'].join('\n');
    const r = mergeYamlConfig(bundled, user, {});
    expect(r.orphans).toEqual(['git.custom_knob']);
    expect(r.text).toContain('# Preserved from prior install');
    expect(r.text).toContain('NOT currently in effect');
    // Nested, commented form — NOT the old flat `# git.custom_knob: 42`.
    expect(r.text).toContain('# git:');
    expect(r.text).toContain('#   custom_knob: 42');
    expect(r.text).not.toContain('# git.custom_knob: 42');
  });

  it('groups orphans that share a dot-path prefix into one nested block', () => {
    const user = [
      'autopilot:',
      '  phase_timeout_minutes:',
      '    create_story: 25',
      '    check_readiness: 15',
    ].join('\n');
    const r = mergeYamlConfig(bundled, user, {});
    expect(r.orphans).toEqual([
      'autopilot.phase_timeout_minutes.create_story',
      'autopilot.phase_timeout_minutes.check_readiness',
    ]);
    // One shared parent chain, two leaves — not two repeated flat paths.
    expect(r.text).toContain('# autopilot:');
    expect(r.text).toContain('#   phase_timeout_minutes:');
    expect(r.text).toContain('#     create_story: 25');
    expect(r.text).toContain('#     check_readiness: 15');
    // Uncommenting (strip leading "# ") yields valid, correctly-nested YAML.
    const footerYaml = r.text
      .split('\n')
      .filter(
        (l) =>
          /^#(?: |$)/.test(l) &&
          !l.includes('Preserved') &&
          !l.includes('in effect') &&
          !l.includes('re-apply') &&
          !l.includes('matching section'),
      )
      .map((l) => l.replace(/^# ?/, ''))
      .join('\n');
    expect(footerYaml).toContain('autopilot:');
    expect(footerYaml).toContain('  phase_timeout_minutes:');
    expect(footerYaml).toContain('    create_story: 25');
  });

  it('falls back when bundled text is non-string', () => {
    const r = mergeYamlConfig(null as unknown as string, 'x: 1', {});
    expect(r.fallback).toBe(true);
  });
});

describe('mergeTemplateFile', () => {
  it('keeps user content and emits bundled as sidecar when they differ', () => {
    const r = mergeTemplateFile('bundled body', 'user customizations');
    expect(r.kept).toBe('user');
    expect(r.text).toBe('user customizations');
    expect(r.sidecar).toBe('bundled body');
  });

  it('takes bundled with no sidecar when user is empty', () => {
    const r = mergeTemplateFile('bundled body', '');
    expect(r.kept).toBe('bundled');
    expect(r.text).toBe('bundled body');
    expect(r.sidecar).toBeNull();
  });

  it('takes bundled with no sidecar when user equals bundled byte-for-byte', () => {
    const r = mergeTemplateFile('same content', 'same content');
    expect(r.kept).toBe('bundled');
    expect(r.sidecar).toBeNull();
  });
});
