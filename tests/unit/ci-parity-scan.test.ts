import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import scanMod from '../../_Sprintpilot/scripts/ci-parity-scan.js';

const {
  buildClassifier,
  parseFlowList,
  matchKeyword,
  DEFAULT_INTENTIONAL,
  DEFAULT_ENV_DEPENDENT,
} = scanMod as {
  buildClassifier: (intentional: string[], env: string[]) => (reason: string | null) => string;
  parseFlowList: (s: string) => string[];
  matchKeyword: (reason: string, list: string[]) => string | null;
  DEFAULT_INTENTIONAL: string[];
  DEFAULT_ENV_DEPENDENT: string[];
};

describe('default keyword bundles', () => {
  it('intentional list covers the RFC defaults', () => {
    expect(DEFAULT_INTENTIONAL).toEqual(
      expect.arrayContaining(['slow', 'smoke', 'manual', 'wip', 'flaky']),
    );
  });

  it('env_dependent list covers the RFC defaults', () => {
    expect(DEFAULT_ENV_DEPENDENT).toEqual(
      expect.arrayContaining([
        'postgres',
        'database',
        'redis',
        'gpu',
        'cuda',
        'model file',
        'hardware',
        'network',
      ]),
    );
  });
});

describe('buildClassifier', () => {
  const classify = buildClassifier(DEFAULT_INTENTIONAL, DEFAULT_ENV_DEPENDENT);

  it('classifies env-dependent reasons', () => {
    expect(classify('postgres not running')).toBe('env_dependent');
    expect(classify('GPU not detected')).toBe('env_dependent');
    expect(classify('model file unavailable')).toBe('env_dependent');
    expect(classify('Redis sentinel down')).toBe('env_dependent');
  });

  it('classifies intentional reasons', () => {
    expect(classify('slow integration test')).toBe('intentional');
    expect(classify('flaky on Windows')).toBe('intentional');
    expect(classify('WIP')).toBe('intentional');
  });

  it('returns unknown when no keyword matches', () => {
    expect(classify('TODO investigate later')).toBe('intentional'); // 'todo' is in intentional
    expect(classify('mystery reason')).toBe('unknown');
    expect(classify('')).toBe('unknown');
  });

  it('env_dependent wins when both lists could match', () => {
    // 'slow postgres test' contains both 'slow' (intentional) and 'postgres'
    // (env_dependent). Env-dependent must win because it's the riskier bucket.
    expect(classify('slow postgres test')).toBe('env_dependent');
  });
});

describe('parseFlowList', () => {
  it('parses bare values', () => {
    expect(parseFlowList('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('strips quotes', () => {
    expect(parseFlowList("'a', \"b\", c")).toEqual(['a', 'b', 'c']);
  });

  it('drops empties', () => {
    expect(parseFlowList(', a, , b ,')).toEqual(['a', 'b']);
  });
});

describe('matchKeyword', () => {
  it('returns the first matching keyword (case-insensitive)', () => {
    expect(matchKeyword('Postgres not running', ['gpu', 'postgres'])).toBe('postgres');
  });

  it('returns null when no match', () => {
    expect(matchKeyword('mystery', ['gpu'])).toBe(null);
    expect(matchKeyword('', ['gpu'])).toBe(null);
    expect(matchKeyword('anything', [])).toBe(null);
  });
});
