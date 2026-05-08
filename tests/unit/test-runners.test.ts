import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @ts-expect-error — CommonJS module
import runnersMod from '../../_Sprintpilot/lib/runtime/test-runners.js';

const {
  ADAPTERS,
  adapterByName,
  pytestAdapter,
  jestAdapter,
  vitestAdapter,
  goTestAdapter,
  cargoTestAdapter,
  rspecAdapter,
  jsSkipScan,
  extractKwarg,
  extractFirstStringArg,
} = runnersMod as {
  ADAPTERS: Array<{ name: string; lang: string }>;
  adapterByName: (name: string) => unknown;
  pytestAdapter: { detect: (root: string) => boolean; enumerateSkips: (files: string[]) => Array<Record<string, unknown>> };
  jestAdapter: { detect: (root: string) => boolean; enumerateSkips: (files: string[]) => Array<Record<string, unknown>> };
  vitestAdapter: { detect: (root: string) => boolean; enumerateSkips: (files: string[]) => Array<Record<string, unknown>> };
  goTestAdapter: { detect: (root: string) => boolean; enumerateSkips: (files: string[]) => Array<Record<string, unknown>> };
  cargoTestAdapter: { detect: (root: string) => boolean; enumerateSkips: (files: string[]) => Array<Record<string, unknown>> };
  rspecAdapter: { detect: (root: string) => boolean; enumerateSkips: (files: string[]) => Array<Record<string, unknown>> };
  jsSkipScan: (files: string[], runner: string) => Array<Record<string, unknown>>;
  extractKwarg: (args: string, key: string) => string | null;
  extractFirstStringArg: (args: string) => string | null;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-runners-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ADAPTERS registry', () => {
  it('exposes the six documented runners', () => {
    expect(ADAPTERS.map((a) => a.name).sort()).toEqual(
      ['cargo-test', 'go-test', 'jest', 'pytest', 'rspec', 'vitest'].sort(),
    );
  });

  it('adapterByName returns null for unknown', () => {
    expect(adapterByName('unknown')).toBe(null);
    expect((adapterByName('pytest') as { name: string }).name).toBe('pytest');
  });
});

describe('extractKwarg', () => {
  it('extracts named string argument', () => {
    expect(extractKwarg("not has_postgres(), reason='no pg'", 'reason')).toBe('no pg');
    expect(extractKwarg('reason="env"', 'reason')).toBe('env');
  });

  it('returns null when missing', () => {
    expect(extractKwarg('not has_pg()', 'reason')).toBe(null);
  });
});

describe('extractFirstStringArg', () => {
  it('extracts first string positional', () => {
    expect(extractFirstStringArg("'no postgres', condition")).toBe('no postgres');
    expect(extractFirstStringArg('"slow"')).toBe('slow');
  });

  it('returns null for empty or non-string-leading', () => {
    expect(extractFirstStringArg('not a_str')).toBe(null);
  });
});

describe('pytestAdapter', () => {
  it('detects pytest from pyproject.toml mentioning pytest', () => {
    writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    expect(pytestAdapter.detect(dir)).toBe(true);
  });

  it('detects pytest from pytest.ini', () => {
    writeFileSync(path.join(dir, 'pytest.ini'), '');
    expect(pytestAdapter.detect(dir)).toBe(true);
  });

  it('does not detect when no pytest signals', () => {
    expect(pytestAdapter.detect(dir)).toBe(false);
  });

  it('parses @pytest.mark.skip(reason="...")', () => {
    const file = path.join(dir, 'test_a.py');
    writeFileSync(
      file,
      '@pytest.mark.skip(reason="postgres not running")\ndef test_db():\n    pass\n',
    );
    const skips = pytestAdapter.enumerateSkips([file]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      reason: 'postgres not running',
      marker: 'pytest.mark.skip',
      line: 1,
    });
  });

  it('parses @pytest.mark.skipif with reason', () => {
    const file = path.join(dir, 'test_b.py');
    writeFileSync(
      file,
      "@pytest.mark.skipif(not has_gpu(), reason='gpu absent')\ndef test_cuda():\n    pass\n",
    );
    const skips = pytestAdapter.enumerateSkips([file]);
    expect(skips[0]).toMatchObject({ reason: 'gpu absent', marker: 'pytest.mark.skipif' });
  });

  it('parses inline pytest.skip("...")', () => {
    const file = path.join(dir, 'test_c.py');
    writeFileSync(
      file,
      "def test_thing():\n    pytest.skip('redis not configured')\n",
    );
    const skips = pytestAdapter.enumerateSkips([file]);
    expect(skips[0]).toMatchObject({ reason: 'redis not configured', marker: 'pytest.skip' });
  });

  it('parses unittest.skip(...) decorators', () => {
    const file = path.join(dir, 'test_d.py');
    writeFileSync(
      file,
      "@unittest.skipIf(SKIP, 'database unavailable')\nclass TestThing:\n    pass\n",
    );
    const skips = pytestAdapter.enumerateSkips([file]);
    expect(skips[0]).toMatchObject({
      reason: 'database unavailable',
      marker: 'unittest.skipIf',
    });
  });

  it('skips non-python files entirely', () => {
    const file = path.join(dir, 'foo.js');
    writeFileSync(file, "@pytest.mark.skip(reason='x')\n");
    expect(pytestAdapter.enumerateSkips([file])).toEqual([]);
  });
});

describe('jestAdapter / vitestAdapter (jsSkipScan)', () => {
  it('parses describe.skip / it.skip / test.skip / xit / xdescribe', () => {
    const file = path.join(dir, 'a.test.ts');
    writeFileSync(
      file,
      [
        "describe.skip('outer', () => {});",
        "it.skip('inner one', () => {});",
        "test.skip('inner two', () => {});",
        "xit('legacy x', () => {});",
        "xdescribe('legacy d', () => {});",
        "it.todo('write later');",
      ].join('\n'),
    );
    const skips = jsSkipScan([file], 'jest');
    const reasons = skips.map((s) => s.reason).sort();
    expect(reasons).toEqual(
      ['inner one', 'inner two', 'legacy d', 'legacy x', 'outer', 'write later'].sort(),
    );
    expect(skips.every((s) => /jest:/.test(String(s.marker)))).toBe(true);
  });

  it('does not match unrelated text', () => {
    const file = path.join(dir, 'a.test.ts');
    writeFileSync(file, "console.log('it.skip is a string'); // not a real call");
    const skips = jsSkipScan([file], 'jest');
    // The literal "it.skip(" is not present, so no match.
    expect(skips).toEqual([]);
  });

  it('jest detects via package.json devDependencies', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', devDependencies: { jest: '^29.0.0' } }),
    );
    expect(jestAdapter.detect(dir)).toBe(true);
    expect(vitestAdapter.detect(dir)).toBe(false);
  });

  it('vitest detects via vitest.config.ts', () => {
    writeFileSync(path.join(dir, 'vitest.config.ts'), 'export default {};');
    expect(vitestAdapter.detect(dir)).toBe(true);
  });
});

describe('goTestAdapter', () => {
  it('detects via go.mod', () => {
    writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    expect(goTestAdapter.detect(dir)).toBe(true);
  });

  it('parses t.Skip("...") and t.Skipf', () => {
    const file = path.join(dir, 'handler_test.go');
    writeFileSync(
      file,
      [
        'func TestX(t *testing.T) {',
        '    t.Skip("requires docker")',
        '    t.Skipf("env %s missing", "DB")',
        '}',
      ].join('\n'),
    );
    const skips = goTestAdapter.enumerateSkips([file]);
    expect(skips).toHaveLength(2);
    expect(skips[0]).toMatchObject({ reason: 'requires docker', marker: 't.Skip' });
    expect(skips[1].marker).toBe('t.Skip');
  });

  it('only scans *_test.go files', () => {
    const file = path.join(dir, 'handler.go');
    writeFileSync(file, 't.Skip("not in test file")');
    expect(goTestAdapter.enumerateSkips([file])).toEqual([]);
  });
});

describe('cargoTestAdapter', () => {
  it('detects via Cargo.toml', () => {
    writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(cargoTestAdapter.detect(dir)).toBe(true);
  });

  it('parses #[ignore] and #[ignore = "..."]', () => {
    const file = path.join(dir, 'lib.rs');
    writeFileSync(
      file,
      ['#[ignore]', 'fn test_a() {}', '#[ignore = "needs gpu"]', 'fn test_b() {}'].join('\n'),
    );
    const skips = cargoTestAdapter.enumerateSkips([file]);
    expect(skips).toHaveLength(2);
    expect(skips[0].reason).toBe('');
    expect(skips[1].reason).toBe('needs gpu');
  });
});

describe('rspecAdapter', () => {
  it('detects via .rspec', () => {
    writeFileSync(path.join(dir, '.rspec'), '--format doc\n');
    expect(rspecAdapter.detect(dir)).toBe(true);
  });

  it('detects via Gemfile mentioning rspec', () => {
    writeFileSync(path.join(dir, 'Gemfile'), "gem 'rspec-rails'\n");
    expect(rspecAdapter.detect(dir)).toBe(true);
  });

  it('parses pending and skip with reason', () => {
    const file = path.join(dir, 'thing_spec.rb');
    writeFileSync(
      file,
      [
        "describe 'Thing' do",
        "  pending 'still working on it'",
        "  skip 'needs staging env'",
        "end",
      ].join('\n'),
    );
    const skips = rspecAdapter.enumerateSkips([file]);
    expect(skips.map((s) => s.reason).sort()).toEqual(
      ['needs staging env', 'still working on it'].sort(),
    );
  });

  it('parses metadata-style it ..., skip: "..."', () => {
    const file = path.join(dir, 'meta_spec.rb');
    writeFileSync(file, "it 'works', skip: 'requires DB' do\nend\n");
    const skips = rspecAdapter.enumerateSkips([file]);
    expect(skips[0].reason).toBe('requires DB');
  });

  it('only scans *_spec.rb files', () => {
    const file = path.join(dir, 'plain.rb');
    writeFileSync(file, "skip 'x'");
    expect(rspecAdapter.enumerateSkips([file])).toEqual([]);
  });
});
