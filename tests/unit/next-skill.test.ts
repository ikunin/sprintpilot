import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import nextSkillMod from '../../_Sprintpilot/scripts/next-skill.js';

const { route, QUICK_FLOW_REROUTE_SET } = nextSkillMod as {
  route: (proposed: string, implementationFlow: string) => { skill: string; reason: string | null };
  QUICK_FLOW_REROUTE_SET: Set<string>;
};

describe('next-skill route()', () => {
  describe('full flow (default)', () => {
    it('returns proposed skill unchanged for any input', () => {
      expect(route('bmad-dev-story', 'full')).toEqual({
        skill: 'bmad-dev-story',
        reason: null,
      });
      expect(route('bmad-create-story', 'full')).toEqual({
        skill: 'bmad-create-story',
        reason: null,
      });
      expect(route('bmad-check-implementation-readiness', 'full')).toEqual({
        skill: 'bmad-check-implementation-readiness',
        reason: null,
      });
      expect(route('bmad-help', 'full')).toEqual({
        skill: 'bmad-help',
        reason: null,
      });
    });
  });

  describe('quick flow (nano profile)', () => {
    it('routes bmad-dev-story → bmad-quick-dev', () => {
      const r = route('bmad-dev-story', 'quick');
      expect(r.skill).toBe('bmad-quick-dev');
      expect(r.reason).toMatch(/routed.*nano/);
    });

    it('routes bmad-create-story → bmad-quick-dev (skipped in nano)', () => {
      const r = route('bmad-create-story', 'quick');
      expect(r.skill).toBe('bmad-quick-dev');
      expect(r.reason).toMatch(/routed bmad-create-story/);
    });

    it('routes bmad-check-implementation-readiness → bmad-quick-dev', () => {
      const r = route('bmad-check-implementation-readiness', 'quick');
      expect(r.skill).toBe('bmad-quick-dev');
    });

    it('routes bmad-code-review → bmad-quick-dev (quick-dev does its own review)', () => {
      const r = route('bmad-code-review', 'quick');
      expect(r.skill).toBe('bmad-quick-dev');
    });

    it('passes other skills through unchanged', () => {
      // Skills outside the reroute set still run (planning, retrospective, etc.)
      expect(route('bmad-help', 'quick')).toEqual({ skill: 'bmad-help', reason: null });
      expect(route('bmad-create-prd', 'quick')).toEqual({
        skill: 'bmad-create-prd',
        reason: null,
      });
    });

    it('idempotent: bmad-quick-dev → bmad-quick-dev (no infinite loop)', () => {
      // The reroute target itself isn't in QUICK_FLOW_REROUTE_SET, so it
      // passes through unchanged.
      const r = route('bmad-quick-dev', 'quick');
      expect(r.skill).toBe('bmad-quick-dev');
      expect(r.reason).toBe(null);
    });
  });

  describe('edge cases', () => {
    it('empty proposed surfaces a clear error', () => {
      const r = route('', 'quick');
      expect(r.skill).toBe('');
      expect(r.reason).toMatch(/no proposed skill/);
    });

    it('unknown implementation_flow value behaves as full (conservative)', () => {
      const r = route('bmad-dev-story', 'mystery');
      expect(r.skill).toBe('bmad-dev-story');
      expect(r.reason).toBe(null);
    });
  });

  describe('QUICK_FLOW_REROUTE_SET membership', () => {
    it('contains the four skills quick-dev replaces', () => {
      expect([...QUICK_FLOW_REROUTE_SET].sort()).toEqual([
        'bmad-check-implementation-readiness',
        'bmad-code-review',
        'bmad-create-story',
        'bmad-dev-story',
      ]);
    });
  });
});
