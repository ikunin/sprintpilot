import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import substituteMod from '../../lib/substitute.js';

const { isTextFile, renderString, buildContext } = substituteMod as {
  isTextFile: (path: string) => boolean;
  renderString: (text: string, ctx: Record<string, unknown>) => string;
  buildContext: (input?: { outputFolder?: string | null }) => Record<string, unknown>;
};

describe('isTextFile', () => {
  it('accepts md/yaml/yml/json/sh/txt', () => {
    expect(isTextFile('a.md')).toBe(true);
    expect(isTextFile('a.yaml')).toBe(true);
    expect(isTextFile('a.yml')).toBe(true);
    expect(isTextFile('a.json')).toBe(true);
    expect(isTextFile('a.sh')).toBe(true);
    expect(isTextFile('a.txt')).toBe(true);
  });

  it('case-insensitive by extension', () => {
    expect(isTextFile('README.MD')).toBe(true);
  });

  it('rejects binary-ish extensions', () => {
    expect(isTextFile('logo.png')).toBe(false);
    expect(isTextFile('archive.tar.gz')).toBe(false);
    expect(isTextFile('module.js')).toBe(false);
  });
});

describe('renderString', () => {
  it('substitutes single placeholder', () => {
    expect(renderString('path: {output_folder}/x', { output_folder: 'out' })).toBe('path: out/x');
  });

  it('substitutes multiple placeholders', () => {
    const ctx = {
      output_folder: 'out',
      planning_artifacts: 'out/plan',
      implementation_artifacts: 'out/impl',
    };
    const text = '{output_folder} {planning_artifacts} {implementation_artifacts}';
    expect(renderString(text, ctx)).toBe('out out/plan out/impl');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(renderString('{unknown}', { output_folder: 'x' })).toBe('{unknown}');
  });

  it('handles repeated occurrences', () => {
    expect(renderString('{x} {x} {x}', { x: 'Y' })).toBe('Y Y Y');
  });

  it('is a no-op for empty input', () => {
    expect(renderString('', { output_folder: 'x' })).toBe('');
  });

  it('skips null values', () => {
    const text = '{output_folder}';
    const out = renderString(text, { output_folder: null as unknown as string });
    expect(out).toBe(text);
  });
});

describe('buildContext', () => {
  it('derives artifact paths from outputFolder', () => {
    const ctx = buildContext({ outputFolder: 'build/bmad' });
    expect(ctx.output_folder).toBe('build/bmad');
    expect(ctx.planning_artifacts).toBe('build/bmad/planning-artifacts');
    expect(ctx.implementation_artifacts).toBe('build/bmad/implementation-artifacts');
  });

  it('defaults to _bmad-output when outputFolder missing', () => {
    const ctx = buildContext({});
    expect(ctx.output_folder).toBe('_bmad-output');
    expect(ctx.planning_artifacts).toBe('_bmad-output/planning-artifacts');
  });

  it('defaults when outputFolder is null', () => {
    const ctx = buildContext({ outputFolder: null });
    expect(ctx.output_folder).toBe('_bmad-output');
  });

  it('accepts no arguments and returns defaults', () => {
    const ctx = buildContext();
    expect(ctx.output_folder).toBe('_bmad-output');
    expect(ctx.planning_artifacts).toBe('_bmad-output/planning-artifacts');
    expect(ctx.implementation_artifacts).toBe('_bmad-output/implementation-artifacts');
  });

  it('does NOT expose session_story_limit or retrospective_mode in ctx (collides with {{var}} in workflow.md)', () => {
    // These values are written directly to modules/autopilot/config.yaml by
    // patchAutopilotConfig after the copy, NOT via renderString, because
    // workflow.md uses the pattern `{{session_story_limit}}` and
    // `{{retrospective_mode}}` — the inner `{key}` would be matched and
    // substituted, corrupting those variable references.
    const ctx = buildContext({ outputFolder: 'out' });
    expect(ctx.session_story_limit).toBeUndefined();
    expect(ctx.retrospective_mode).toBeUndefined();
  });
});
