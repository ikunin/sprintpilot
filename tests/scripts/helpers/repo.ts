import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  dir: string;
  remoteDir?: string;
  cleanup: () => void;
}

function git(args: string[], cwd: string) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    const cmd = `git ${args.join(' ')}`;
    throw new Error(`${cmd} failed: ${res.stderr?.toString().trim() ?? ''}`);
  }
  return res.stdout?.toString() ?? '';
}

export function createTempRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'sprintpilot-test-'));
  git(['init', '--initial-branch=main', '--quiet'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['commit', '--allow-empty', '-m', 'initial commit', '--quiet'], dir);
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function createTempRepoWithRemote(): TempRepo {
  const remoteDir = mkdtempSync(join(tmpdir(), 'sprintpilot-remote-'));
  git(['init', '--bare', '--quiet', remoteDir], tmpdir());

  const dir = mkdtempSync(join(tmpdir(), 'sprintpilot-test-'));
  git(['init', '--initial-branch=main', '--quiet'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['commit', '--allow-empty', '-m', 'initial commit', '--quiet'], dir);
  git(['remote', 'add', 'origin', remoteDir], dir);
  git(['push', '-u', 'origin', 'main', '--quiet'], dir);

  return {
    dir,
    remoteDir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        rmSync(remoteDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function commitFile(
  dir: string,
  file: string,
  content = 'test content',
  msg = `add ${file}`,
) {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content + (content.endsWith('\n') ? '' : '\n'), 'utf8');
  git(['add', '--', file], dir);
  git(['commit', '-m', msg, '--quiet'], dir);
}

export function modifyFile(dir: string, file: string, content = 'modified content') {
  const full = join(dir, file);
  writeFileSync(full, content + (content.endsWith('\n') ? '' : '\n'), 'utf8');
}

export function createUntracked(dir: string, file: string, content = 'untracked content') {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content + (content.endsWith('\n') ? '' : '\n'), 'utf8');
}

export function writeRaw(dir: string, file: string, content: string) {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

export function readFileIn(dir: string, file: string): string {
  return execFileSync('cat', [file], { cwd: dir, encoding: 'utf8' });
}

export function gitIn(dir: string, args: string[]): string {
  return git(args, dir);
}

export function fileExistsIn(dir: string, file: string): boolean {
  return existsSync(join(dir, file));
}
