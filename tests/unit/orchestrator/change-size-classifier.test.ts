import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import classifier from '../../../_Sprintpilot/lib/orchestrator/change-size-classifier.js';

const {
  classifySize,
  classifyChange,
  reviewLayersForSize,
  parseNumstat,
  parseNameStatus,
  collectStructuralSignals,
  isDepManifest,
  isSchemaOrMigration,
  isBarrelIndex,
  depManifestVersionEdit,
  TRIVIAL_FILES_MAX,
  TRIVIAL_LOC_MAX,
  STRUCTURAL_LOC_MIN,
  STRUCTURAL_FILES_MIN,
} = classifier as {
  classifySize: (m: Record<string, unknown>) => {
    size: 'trivial' | 'normal' | 'structural';
    reason: string;
    structural_signals: string[];
  };
  classifyChange: (args: {
    projectRoot: string;
    baseBranch?: string;
    run?: (bin: string, args: string[], opts: unknown) => string;
  }) => Record<string, unknown>;
  reviewLayersForSize: (size: string) => Record<string, unknown>;
  parseNumstat: (text: string) => {
    filesTouched: number;
    locAdded: number;
    locRemoved: number;
    files: Array<{ path: string; added: number; removed: number }>;
  };
  parseNameStatus: (text: string) => { renames: string[]; paths: string[] };
  collectStructuralSignals: (
    files: Array<{ path: string }>,
    manifestDiffs: Record<string, string>,
  ) => string[];
  isDepManifest: (p: string) => boolean;
  isSchemaOrMigration: (p: string) => boolean;
  isBarrelIndex: (p: string) => boolean;
  depManifestVersionEdit: (s: string) => boolean;
  TRIVIAL_FILES_MAX: number;
  TRIVIAL_LOC_MAX: number;
  STRUCTURAL_LOC_MIN: number;
  STRUCTURAL_FILES_MIN: number;
};

describe('classifySize', () => {
  it('returns trivial for ≤2 files and ≤10 LOC', () => {
    const r = classifySize({ filesTouched: 1, locAdded: 5, locRemoved: 2 });
    expect(r.size).toBe('trivial');
  });

  it('returns normal for medium changes', () => {
    const r = classifySize({ filesTouched: 5, locAdded: 80, locRemoved: 20 });
    expect(r.size).toBe('normal');
  });

  it('returns structural when LOC delta exceeds threshold', () => {
    const r = classifySize({ filesTouched: 3, locAdded: 600, locRemoved: 0 });
    expect(r.size).toBe('structural');
    expect(r.structural_signals.some((s) => s.startsWith('loc_delta_'))).toBe(true);
  });

  it('returns structural when files_touched exceeds threshold', () => {
    const r = classifySize({ filesTouched: 25, locAdded: 50, locRemoved: 0 });
    expect(r.size).toBe('structural');
    expect(r.structural_signals.some((s) => s.startsWith('files_'))).toBe(true);
  });

  it('returns structural on rename detection', () => {
    const r = classifySize({ filesTouched: 1, locAdded: 0, locRemoved: 0, hasRename: true });
    expect(r.size).toBe('structural');
    expect(r.structural_signals).toContain('rename_detected');
  });

  it('respects explicit structural signals from caller', () => {
    const r = classifySize({
      filesTouched: 1,
      locAdded: 5,
      locRemoved: 0,
      structuralSignals: ['schema_or_migration:db/migrations/2026.sql'],
    });
    expect(r.size).toBe('structural');
  });

  it('exposes the threshold constants', () => {
    expect(TRIVIAL_FILES_MAX).toBe(2);
    expect(TRIVIAL_LOC_MAX).toBe(10);
    expect(STRUCTURAL_LOC_MIN).toBe(500);
    expect(STRUCTURAL_FILES_MIN).toBe(20);
  });
});

describe('parseNumstat', () => {
  it('sums added + removed across rows', () => {
    const text = '10\t5\tfile1.ts\n20\t0\tfile2.ts\n';
    const r = parseNumstat(text);
    expect(r.filesTouched).toBe(2);
    expect(r.locAdded).toBe(30);
    expect(r.locRemoved).toBe(5);
  });

  it('treats `-` rows (binary/renames) as 0 LOC but counts the file', () => {
    const text = '-\t-\tasset.png\n5\t2\tfoo.ts\n';
    const r = parseNumstat(text);
    expect(r.filesTouched).toBe(2);
    expect(r.locAdded).toBe(5);
    expect(r.locRemoved).toBe(2);
  });

  it('returns zeros for empty input', () => {
    const r = parseNumstat('');
    expect(r.filesTouched).toBe(0);
    expect(r.locAdded).toBe(0);
  });
});

describe('parseNameStatus', () => {
  it('detects renames', () => {
    const text = 'M\tfile1.ts\nR100\told/path.ts\tnew/path.ts\n';
    const r = parseNameStatus(text);
    expect(r.renames).toContain('old/path.ts');
    expect(r.renames).toContain('new/path.ts');
  });

  it('handles plain modify/add/delete rows', () => {
    const text = 'A\tnew.ts\nD\tgone.ts\n';
    const r = parseNameStatus(text);
    expect(r.paths).toEqual(['new.ts', 'gone.ts']);
    expect(r.renames).toEqual([]);
  });
});

describe('file-path classifiers', () => {
  it('isDepManifest detects package.json', () => {
    expect(isDepManifest('package.json')).toBe(true);
    expect(isDepManifest('packages/app/package.json')).toBe(true);
    expect(isDepManifest('src/app.ts')).toBe(false);
  });

  it('isSchemaOrMigration detects migration paths', () => {
    expect(isSchemaOrMigration('db/migrations/2026_06_01.sql')).toBe(true);
    expect(isSchemaOrMigration('prisma/schema.prisma')).toBe(true);
    expect(isSchemaOrMigration('src/app.ts')).toBe(false);
  });

  it('isBarrelIndex detects index files', () => {
    expect(isBarrelIndex('src/index.ts')).toBe(true);
    expect(isBarrelIndex('src/lib/index.tsx')).toBe(true);
    expect(isBarrelIndex('src/foo.ts')).toBe(false);
  });

  it('depManifestVersionEdit detects version pin lines', () => {
    expect(depManifestVersionEdit('\n+    "react": "^18.0.0",\n')).toBe(true);
    // Whitespace-only edit.
    expect(depManifestVersionEdit('\n+    \n')).toBe(false);
  });
});

describe('collectStructuralSignals', () => {
  it('emits per-file signals for schema/barrel/dep paths', () => {
    const files = [
      { path: 'db/migrations/01.sql' },
      { path: 'src/index.ts' },
      { path: 'package.json' },
    ];
    const manifestDiffs = { 'package.json': '\n+    "react": "^18.0.0",\n' };
    const r = collectStructuralSignals(files, manifestDiffs);
    expect(r).toContain('schema_or_migration:db/migrations/01.sql');
    expect(r).toContain('barrel_index_changed:src/index.ts');
    expect(r).toContain('dep_version_edit:package.json');
  });

  it('skips dep manifests when only formatting changed', () => {
    const files = [{ path: 'package.json' }];
    const manifestDiffs = { 'package.json': '\n+    \n' };
    const r = collectStructuralSignals(files, manifestDiffs);
    expect(r).toEqual([]);
  });
});

describe('reviewLayersForSize', () => {
  it('trivial → 1 reviewer (blind hunter)', () => {
    const r = reviewLayersForSize('trivial');
    expect(r.review_depth).toBe('trivial');
    expect(r.recommended_reviewer_count).toBe(1);
    expect(r.recommended_layers).toEqual(['blind_hunter']);
  });

  it('normal → 3 reviewers (default)', () => {
    const r = reviewLayersForSize('normal');
    expect(r.recommended_reviewer_count).toBe(3);
    expect(r.recommended_layers).toEqual([
      'blind_hunter',
      'edge_case_hunter',
      'acceptance_auditor',
    ]);
  });

  it('structural → 3 reviewers + extended Edge Case Hunter', () => {
    const r = reviewLayersForSize('structural');
    expect(r.recommended_reviewer_count).toBe(3);
    expect(r.extended_edge_case_hunter).toBe(true);
  });

  it('unknown size falls back to normal', () => {
    const r = reviewLayersForSize('weird');
    expect(r.review_depth).toBe('normal');
  });
});

describe('classifyChange (I/O)', () => {
  it('returns trivial when no diff', () => {
    const fakeRun = () => '';
    const r = classifyChange({ projectRoot: '/r', baseBranch: 'main', run: fakeRun });
    expect(r.size).toBe('trivial');
    expect(r.reason).toBe('no_diff');
  });

  it('returns no_project_root sentinel when projectRoot is missing', () => {
    const r = classifyChange({ projectRoot: '', run: () => '' });
    expect(r.reason).toBe('no_project_root');
  });

  it('classifies a small change as trivial', () => {
    const fakeRun = (_bin: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--numstat')) return '3\t1\tsrc/foo.ts\n';
      if (joined.includes('--name-status')) return 'M\tsrc/foo.ts\n';
      return '';
    };
    const r = classifyChange({ projectRoot: '/r', baseBranch: 'main', run: fakeRun });
    expect(r.size).toBe('trivial');
    expect(r.files_touched).toBe(1);
    expect(r.loc_added).toBe(3);
    expect(r.loc_removed).toBe(1);
  });

  it('classifies a structural change driven by schema files', () => {
    const fakeRun = (_bin: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--numstat')) {
        return '5\t0\tsrc/foo.ts\n2\t0\tdb/migrations/2026_06_01_add_users.sql\n';
      }
      if (joined.includes('--name-status')) {
        return 'M\tsrc/foo.ts\nA\tdb/migrations/2026_06_01_add_users.sql\n';
      }
      return '';
    };
    const r = classifyChange({ projectRoot: '/r', baseBranch: 'main', run: fakeRun });
    expect(r.size).toBe('structural');
    expect(r.structural_signals as string[]).toEqual(
      expect.arrayContaining([expect.stringContaining('schema_or_migration:db/migrations/')]),
    );
  });

  it('classifies a dep-version bump as structural', () => {
    const fakeRun = (_bin: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--numstat')) return '1\t1\tpackage.json\n';
      if (joined.includes('--name-status')) return 'M\tpackage.json\n';
      // Per-manifest diff fetch.
      if (
        args.includes('package.json') &&
        args[0] === 'diff' &&
        !args.includes('--numstat') &&
        !args.includes('--name-status')
      ) {
        return '\n+    "react": "^18.0.0",\n';
      }
      return '';
    };
    const r = classifyChange({ projectRoot: '/r', baseBranch: 'main', run: fakeRun });
    expect(r.size).toBe('structural');
  });

  it('classifies medium change as normal', () => {
    const fakeRun = (_bin: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--numstat')) {
        return '50\t10\tsrc/foo.ts\n40\t5\tsrc/bar.ts\n';
      }
      if (joined.includes('--name-status')) {
        return 'M\tsrc/foo.ts\nM\tsrc/bar.ts\n';
      }
      return '';
    };
    const r = classifyChange({ projectRoot: '/r', baseBranch: 'main', run: fakeRun });
    expect(r.size).toBe('normal');
  });

  it('returns the same shape on git errors (defensive)', () => {
    const fakeRun = () => {
      throw new Error('git not found');
    };
    const r = classifyChange({ projectRoot: '/r', baseBranch: 'main', run: fakeRun });
    expect(r.size).toBe('trivial');
    expect(r.reason).toBe('no_diff');
  });
});
