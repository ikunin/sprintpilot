import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import markMod from '../../_Sprintpilot/scripts/mark-done-stories-tasks.js';

const { findStoryFile, markAllTasksChecked, readOutputFolder } = markMod as {
  findStoryFile: (root: string, key: string, outputFolder?: string | null) => string | null;
  markAllTasksChecked: (body: string) => string;
  readOutputFolder: (root: string) => string | null;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'mark-done-stories-tasks.js');

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-mark-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('markAllTasksChecked', () => {
  it('replaces every `- [ ]` with `- [x]`', () => {
    const body = `# Story\n\n## Tasks\n\n- [ ] first\n- [ ] second\n- [x] already done\n`;
    const out = markAllTasksChecked(body);
    expect(out).toContain('- [x] first');
    expect(out).toContain('- [x] second');
    expect(out).toContain('- [x] already done');
    expect(out).not.toContain('- [ ]');
  });

  it('leaves non-checkbox brackets alone', () => {
    const body = `# Story\n\nSome prose with [link](x) and \`\`\`[ ]\`\`\` code.\n- [ ] real task\n`;
    const out = markAllTasksChecked(body);
    expect(out).toContain('[link](x)');
    expect(out).toContain('- [x] real task');
  });

  it('handles indented list items', () => {
    const body = `## Tasks\n\n  - [ ] indented task\n    - [ ] nested\n`;
    const out = markAllTasksChecked(body);
    expect(out).toContain('  - [x] indented task');
    expect(out).toContain('    - [x] nested');
  });

  it('preserves `- [ ]` inside triple-backtick fenced code blocks', () => {
    const body = [
      '# Story',
      '',
      '## Tasks',
      '',
      '- [ ] real task',
      '',
      'Example from the template:',
      '',
      '```md',
      '- [ ] sample-task-A',
      '- [ ] sample-task-B',
      '```',
      '',
      '- [ ] another real task',
      '',
    ].join('\n');
    const out = markAllTasksChecked(body);
    // Tasks outside the fence are marked
    expect(out).toContain('- [x] real task');
    expect(out).toContain('- [x] another real task');
    // Tasks inside the fence are verbatim
    expect(out).toContain('- [ ] sample-task-A');
    expect(out).toContain('- [ ] sample-task-B');
  });

  it('preserves `- [ ]` inside triple-tilde fenced code blocks', () => {
    const body = [
      '- [ ] outside',
      '~~~md',
      '- [ ] inside',
      '~~~',
      '- [ ] outside2',
    ].join('\n');
    const out = markAllTasksChecked(body);
    expect(out).toContain('- [x] outside');
    expect(out).toContain('- [x] outside2');
    expect(out).toContain('- [ ] inside');
  });

  it('handles info strings after the fence opener', () => {
    const body = [
      '- [ ] before',
      '```typescript',
      '- [ ] inside-ts',
      '```',
      '- [ ] after',
    ].join('\n');
    const out = markAllTasksChecked(body);
    expect(out).toContain('- [x] before');
    expect(out).toContain('- [ ] inside-ts');
    expect(out).toContain('- [x] after');
  });
});

describe('findStoryFile', () => {
  it('finds story-<key>.md in implementation-artifacts', () => {
    const dir = join(tmpRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'story-1-1-a.md');
    writeFileSync(p, '# Story');
    expect(findStoryFile(tmpRoot, '1-1-a')).toBe(p);
  });

  it('finds <key>.md variant', () => {
    const dir = join(tmpRoot, '_bmad-output', 'stories');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, '1-1-a.md');
    writeFileSync(p, '# Story');
    expect(findStoryFile(tmpRoot, '1-1-a')).toBe(p);
  });

  it('returns null when no file exists', () => {
    expect(findStoryFile(tmpRoot, '9-9-nope')).toBeNull();
  });

  it('respects an explicit --output-folder override', () => {
    const dir = join(tmpRoot, 'custom-out', 'stories');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'story-1-1-a.md');
    writeFileSync(p, '# Story');
    expect(findStoryFile(tmpRoot, '1-1-a', 'custom-out')).toBe(p);
    // Default lookup without override: not found
    expect(findStoryFile(tmpRoot, '1-1-a')).toBeNull();
  });

  it('reads output_folder from _bmad/bmm/config.yaml', () => {
    const cfgDir = join(tmpRoot, '_bmad', 'bmm');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.yaml'), `project_name: x\noutput_folder: custom-out\n`);
    const dir = join(tmpRoot, 'custom-out', 'implementation-artifacts');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'story-1-1-a.md');
    writeFileSync(p, '# Story');
    expect(readOutputFolder(tmpRoot)).toBe('custom-out');
    expect(findStoryFile(tmpRoot, '1-1-a')).toBe(p);
  });
});

describe('CLI integration', () => {
  it('marks tasks for every done story and reports a summary', () => {
    const implDir = join(tmpRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(implDir, { recursive: true });
    writeFileSync(
      join(implDir, 'sprint-status.yaml'),
      `development_status:\n  1-1-done-story:\n    status: done\n  1-2-todo:\n    status: ready-for-dev\n`,
    );
    writeFileSync(
      join(implDir, 'story-1-1-done-story.md'),
      `# Done\n- [ ] task 1\n- [ ] task 2\n`,
    );
    writeFileSync(
      join(implDir, 'story-1-2-todo.md'),
      `# Todo\n- [ ] unfinished\n`,
    );

    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--status-file',
      join(implDir, 'sprint-status.yaml'),
      '--project-root',
      tmpRoot,
    ]).toString();
    const summary = JSON.parse(out);
    expect(summary.done_stories).toBe(1);
    expect(summary.marked).toHaveLength(1);

    // Done story: tasks are marked [x].
    const doneBody = readFileSync(join(implDir, 'story-1-1-done-story.md'), 'utf-8');
    expect(doneBody).toContain('- [x] task 1');
    expect(doneBody).not.toContain('- [ ]');

    // Todo story: untouched.
    const todoBody = readFileSync(join(implDir, 'story-1-2-todo.md'), 'utf-8');
    expect(todoBody).toContain('- [ ] unfinished');
  });

  it('treats case variants of status=done as done', () => {
    const implDir = join(tmpRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(implDir, { recursive: true });
    writeFileSync(
      join(implDir, 'sprint-status.yaml'),
      `development_status:\n  1-1:\n    status: Done\n  1-2:\n    status: "DONE"\n`,
    );
    writeFileSync(join(implDir, 'story-1-1.md'), `- [ ] t\n`);
    writeFileSync(join(implDir, 'story-1-2.md'), `- [ ] u\n`);

    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--status-file',
      join(implDir, 'sprint-status.yaml'),
      '--project-root',
      tmpRoot,
    ]).toString();
    const summary = JSON.parse(out);
    expect(summary.done_stories).toBe(2);
    expect(readFileSync(join(implDir, 'story-1-1.md'), 'utf-8')).toContain('- [x] t');
    expect(readFileSync(join(implDir, 'story-1-2.md'), 'utf-8')).toContain('- [x] u');
  });
});
