import { describe, expect, it } from "vitest";
// @ts-expect-error — CommonJS module
import yamlMod from "../../_Sprintpilot/lib/runtime/yaml-lite.js";

const {
  yamlSafe,
  hasStoryBlock,
  replaceStoryBlock,
  appendStoryBlock,
  readStoryField,
} = yamlMod as {
  yamlSafe: (v: unknown) => string;
  hasStoryBlock: (text: string, key: string) => boolean;
  replaceStoryBlock: (text: string, key: string, block: string) => string;
  appendStoryBlock: (text: string, block: string) => string;
  readStoryField: (text: string, key: string, field: string) => string | null;
};

describe("yamlSafe", () => {
  it("quotes values with colons", () => {
    expect(yamlSafe("a: b")).toBe('"a: b"');
  });

  it("quotes values with brackets", () => {
    expect(yamlSafe("x [y]")).toBe('"x [y]"');
  });

  it("does not quote plain strings", () => {
    expect(yamlSafe("plain")).toBe("plain");
  });

  it("escapes embedded quotes", () => {
    expect(yamlSafe('a "b" c: x')).toBe('"a \\"b\\" c: x"');
  });

  it("handles empty string", () => {
    expect(yamlSafe("")).toBe('""');
  });

  it("passes through numbers as strings", () => {
    expect(yamlSafe(42)).toBe("42");
  });

  // Regression: YAML reserved string literals must be quoted so they
  // round-trip as strings, not as booleans/null.
  it.each(["no", "yes", "true", "false", "null", "on", "off", "NO", "YES"])(
    "quotes reserved literal %s",
    (val) => {
      expect(yamlSafe(val)).toBe(`"${val}"`);
    },
  );
});

describe("story block helpers", () => {
  const baseline = `git_integration:
  enabled: true
  base_branch: main
  platform: github

stories:
  1-1:
    branch: story/1-1
    push_status: pending
    worktree_cleaned: false
  1-2:
    branch: story/1-2
    push_status: pushed
    worktree_cleaned: false
`;

  it("hasStoryBlock finds existing story", () => {
    expect(hasStoryBlock(baseline, "1-1")).toBe(true);
    expect(hasStoryBlock(baseline, "1-2")).toBe(true);
  });

  it("hasStoryBlock returns false for missing story", () => {
    expect(hasStoryBlock(baseline, "2-1")).toBe(false);
  });

  it("replaceStoryBlock updates in place, preserves neighbours", () => {
    const next = `  1-1:\n    branch: story/1-1\n    push_status: pushed\n    pr_url: "https://example/pr/1"\n    worktree_cleaned: false`;
    const out = replaceStoryBlock(baseline, "1-1", next);
    expect(out).toContain("push_status: pushed");
    expect(out).toContain('pr_url: "https://example/pr/1"');
    expect(out).toContain("1-2:");           // untouched neighbour
    expect(out).toContain("push_status: pushed");
    // Only one 1-1 block
    const count = (out.match(/^  1-1:/gm) || []).length;
    expect(count).toBe(1);
  });

  it("appendStoryBlock adds new story without removing existing", () => {
    const newBlock = `  2-1:\n    branch: story/2-1\n    push_status: pending\n    worktree_cleaned: false`;
    const out = appendStoryBlock(baseline, newBlock);
    expect(out).toContain("1-1:");
    expect(out).toContain("1-2:");
    expect(out).toContain("2-1:");
  });

  // Regression: repeated replaceStoryBlock must NOT inflate blank lines.
  it("replaceStoryBlock is idempotent across many upserts (no blank-line growth)", () => {
    const replacement = `  1-1:\n    branch: story/1-1\n    push_status: pushed\n    worktree_cleaned: false`;
    let cur = baseline;
    for (let i = 0; i < 10; i++) cur = replaceStoryBlock(cur, "1-1", replacement);
    // Count consecutive blank lines between the two story blocks.
    const lines = cur.split("\n");
    const h2 = lines.findIndex((l) => /^  1-2:/.test(l));
    // Walk backward from h2 to find contiguous blanks; should be exactly 1.
    let blanks = 0;
    for (let i = h2 - 1; i >= 0 && lines[i].length === 0; i--) blanks++;
    expect(blanks).toBe(1);
  });
});

describe("readStoryField", () => {
  const sprint = `sprint: demo
stories:
  1-1:
    status: in_progress
    assignee: claude
  1-2:
    status: done
`;

  it("reads status of a story block", () => {
    expect(readStoryField(sprint, "1-1", "status")).toBe("in_progress");
    expect(readStoryField(sprint, "1-2", "status")).toBe("done");
  });

  it("returns null for missing story", () => {
    expect(readStoryField(sprint, "9-9", "status")).toBe(null);
  });

  it("returns null for missing field", () => {
    expect(readStoryField(sprint, "1-2", "assignee")).toBe(null);
  });

  it("strips surrounding quotes", () => {
    const q = `stories:\n  x:\n    status: "complex: value"\n`;
    expect(readStoryField(q, "x", "status")).toBe("complex: value");
  });

  // Regression: readStoryField must stop at the next story's header
  // without leaking into sibling blocks.
  it("does not leak into sibling story when target field is absent", () => {
    const doc = `stories:\n  1-1:\n    branch: foo\n  1-2:\n    status: done\n`;
    expect(readStoryField(doc, "1-1", "status")).toBe(null);
    expect(readStoryField(doc, "1-2", "status")).toBe("done");
  });

  // Regression: blank lines inside a story block don't terminate the read.
  it("allows blank lines inside a story block", () => {
    const doc = `stories:\n  1-1:\n    branch: foo\n\n    status: in_progress\n`;
    expect(readStoryField(doc, "1-1", "status")).toBe("in_progress");
  });
});
