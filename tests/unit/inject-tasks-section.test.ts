import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import injectMod from '../../_Sprintpilot/scripts/inject-tasks-section.js';

const { inspectTasksSection, extractAcceptanceCriteria, buildTasksSection } = injectMod as {
  inspectTasksSection: (body: string) => { found: boolean; hasCheckbox: boolean };
  extractAcceptanceCriteria: (body: string, section: string) => string[];
  buildTasksSection: (entries: string[]) => string;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'inject-tasks-section.js');

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-inject-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('inspectTasksSection', () => {
  it('detects a `## Tasks` section with checkboxes', () => {
    const body = `# Story\n\n## Tasks\n\n- [ ] a\n`;
    expect(inspectTasksSection(body)).toEqual({ found: true, hasCheckbox: true });
  });

  it('IGNORES `## Tasks` heading inside a fenced code block (no false positive)', () => {
    const body = [
      '# Story',
      '',
      '## Acceptance Criteria',
      '',
      '1. Foo',
      '',
      '## Dev Notes',
      '',
      'Example template skeleton:',
      '```md',
      '## Tasks / Subtasks',
      '- [ ] sample',
      '```',
      '',
    ].join('\n');
    // No real ## Tasks section exists; the only one is inside a fence.
    expect(inspectTasksSection(body)).toEqual({ found: false, hasCheckbox: false });
  });

  it('IGNORES `- [ ]` inside a fenced code block within Tasks section', () => {
    // Real Tasks section but only fenced examples — should NOT count as having checkboxes.
    const body = [
      '## Tasks',
      '',
      'See template for examples:',
      '```md',
      '- [ ] template task',
      '```',
      '',
    ].join('\n');
    expect(inspectTasksSection(body)).toEqual({ found: true, hasCheckbox: false });
  });

  it('handles tilde-fenced code blocks too', () => {
    const body = [
      '## Acceptance Criteria',
      '',
      '~~~md',
      '## Tasks',
      '- [ ] inside-fence',
      '~~~',
    ].join('\n');
    expect(inspectTasksSection(body)).toEqual({ found: false, hasCheckbox: false });
  });

  it('detects a `## Subtasks` section (alternate name)', () => {
    const body = `# Story\n\n## Subtasks\n\n- [ ] a\n`;
    expect(inspectTasksSection(body)).toEqual({ found: true, hasCheckbox: true });
  });
  it('detects `## Tasks / Subtasks` combined form', () => {
    const body = `# Story\n\n## Tasks / Subtasks\n\n- [ ] a\n`;
    expect(inspectTasksSection(body)).toEqual({ found: true, hasCheckbox: true });
  });
  it('reports section present but no checkboxes', () => {
    const body = `# Story\n\n## Tasks\n\nTBD.\n`;
    expect(inspectTasksSection(body)).toEqual({ found: true, hasCheckbox: false });
  });
  it('reports no section when none exists', () => {
    const body = `# Story\n\n## Acceptance Criteria\n\n1. Foo\n`;
    expect(inspectTasksSection(body)).toEqual({ found: false, hasCheckbox: false });
  });
  it('stops scanning at the next same-level heading', () => {
    const body = `## Tasks\n\nEmpty on purpose.\n\n## Notes\n\n- [ ] not-a-task\n`;
    expect(inspectTasksSection(body)).toEqual({ found: true, hasCheckbox: false });
  });
});

describe('extractAcceptanceCriteria', () => {
  it('extracts numbered AC entries', () => {
    const body = `# Story\n\n## Acceptance Criteria\n\n1. First AC.\n2. Second AC.\n3. Third.\n\n## Dev Notes\n\n4. Unrelated.\n`;
    expect(extractAcceptanceCriteria(body, 'Acceptance Criteria')).toEqual([
      'First AC.',
      'Second AC.',
      'Third.',
    ]);
  });
  it('extracts bullet-list AC entries', () => {
    const body = `## Acceptance Criteria\n\n- alpha\n- beta\n- gamma\n`;
    expect(extractAcceptanceCriteria(body, 'Acceptance Criteria')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
  it('extracts **AC-N:** style entries', () => {
    const body = `## Acceptance Criteria\n\n- **AC-1:** one\n- **AC-2:** two\n`;
    expect(extractAcceptanceCriteria(body, 'Acceptance Criteria')).toEqual(['one', 'two']);
  });
  it('ignores entries outside the AC section', () => {
    const body = `# Story\n\n## Dev Notes\n\n1. Not an AC.\n\n## Acceptance Criteria\n\n1. Real AC.\n\n## Appendix\n\n2. Also not AC.\n`;
    expect(extractAcceptanceCriteria(body, 'Acceptance Criteria')).toEqual(['Real AC.']);
  });
  it('returns [] when section is absent', () => {
    const body = `# Story\n\n## Dev Notes\n\n1. Foo.\n`;
    expect(extractAcceptanceCriteria(body, 'Acceptance Criteria')).toEqual([]);
  });
});

describe('buildTasksSection', () => {
  it('creates one `- [ ]` per entry', () => {
    const s = buildTasksSection(['One', 'Two']);
    expect(s).toContain('## Tasks / Subtasks');
    expect(s).toContain('- [ ] One');
    expect(s).toContain('- [ ] Two');
  });
  it('produces a non-empty placeholder when given no entries', () => {
    const s = buildTasksSection([]);
    expect(s).toMatch(/- \[ \] .+/);
  });
});

describe('CLI integration', () => {
  it('is a no-op when Tasks section is already present with checkboxes', () => {
    const f = join(tmpRoot, 'story.md');
    const before = `# Story\n\n## Tasks\n\n- [ ] done\n`;
    writeFileSync(f, before);
    const out = execFileSync(process.execPath, [SCRIPT, '--story-file', f]).toString();
    expect(JSON.parse(out).action).toBe('skip');
    expect(readFileSync(f, 'utf-8')).toBe(before);
  });

  it('appends a Tasks section derived 1:1 from AC when absent', () => {
    const f = join(tmpRoot, 'story.md');
    writeFileSync(
      f,
      `# Story\n\n## Acceptance Criteria\n\n1. Board renders.\n2. Win detection works.\n3. Draw detection works.\n`,
    );
    const out = execFileSync(process.execPath, [SCRIPT, '--story-file', f]).toString();
    const env = JSON.parse(out);
    expect(env.action).toBe('section-appended');
    expect(env.entries).toBe(3);
    const body = readFileSync(f, 'utf-8');
    expect(body).toContain('## Tasks / Subtasks');
    expect(body).toContain('- [ ] Board renders.');
    expect(body).toContain('- [ ] Win detection works.');
    expect(body).toContain('- [ ] Draw detection works.');
  });

  it('adds checkboxes inside an existing empty Tasks section', () => {
    const f = join(tmpRoot, 'story.md');
    writeFileSync(
      f,
      `# Story\n\n## Acceptance Criteria\n\n1. Alpha.\n\n## Tasks\n\n(TBD)\n`,
    );
    const out = execFileSync(process.execPath, [SCRIPT, '--story-file', f]).toString();
    expect(JSON.parse(out).action).toBe('checkboxes-added');
    expect(readFileSync(f, 'utf-8')).toContain('- [ ] Alpha.');
  });

  it('is idempotent on a story already processed', () => {
    const f = join(tmpRoot, 'story.md');
    writeFileSync(f, `## Acceptance Criteria\n\n1. Foo.\n`);
    execFileSync(process.execPath, [SCRIPT, '--story-file', f]);
    const first = readFileSync(f, 'utf-8');
    const secondOut = execFileSync(process.execPath, [SCRIPT, '--story-file', f]).toString();
    const second = readFileSync(f, 'utf-8');
    expect(JSON.parse(secondOut).action).toBe('skip');
    expect(first).toBe(second);
  });
});
