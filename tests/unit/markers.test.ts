import { describe, expect, it } from "vitest";
// @ts-expect-error — CommonJS module
import markersMod from "../../lib/core/markers.js";

const {
  BEGIN,
  END,
  stripBlock,
  upsertBlock,
  hasBlock,
} = markersMod as {
  BEGIN: string;
  END: string;
  stripBlock: (text: string) => string;
  upsertBlock: (text: string, block: string) => string;
  hasBlock: (text: string) => boolean;
};

const block = `${BEGIN}\n# BMAD rules\nrule 1\nrule 2\n${END}`;

describe("markers", () => {
  it("exports canonical marker strings", () => {
    expect(BEGIN).toBe("<!-- BEGIN:bmad-workflow-rules -->");
    expect(END).toBe("<!-- END:bmad-workflow-rules -->");
  });

  it("hasBlock detects presence", () => {
    expect(hasBlock(block)).toBe(true);
    expect(hasBlock("no markers here")).toBe(false);
    expect(hasBlock(`${BEGIN}\nno end`)).toBe(false);
  });

  it("stripBlock removes the entire block", () => {
    const text = `# README\n\n${block}\n\n# Footer`;
    const out = stripBlock(text);
    expect(out).not.toContain(BEGIN);
    expect(out).not.toContain(END);
    expect(out).toContain("# README");
    expect(out).toContain("# Footer");
  });

  it("stripBlock on text without block is a no-op", () => {
    const text = "just text";
    expect(stripBlock(text)).toBe(text);
  });

  it("upsertBlock into empty string writes block only", () => {
    const out = upsertBlock("", block);
    expect(hasBlock(out)).toBe(true);
    expect(out.trim().startsWith(BEGIN)).toBe(true);
  });

  it("upsertBlock appends when no existing block", () => {
    const out = upsertBlock("# Existing", block);
    expect(out).toContain("# Existing");
    expect(hasBlock(out)).toBe(true);
  });

  it("upsertBlock is idempotent — no duplicate block on repeated upsert", () => {
    const first = upsertBlock("# Existing", block);
    const second = upsertBlock(first, block);
    const beginCount = (second.match(new RegExp(BEGIN.replace(/[-/]/g, "\\$&"), "g")) || []).length;
    const endCount = (second.match(new RegExp(END.replace(/[-/]/g, "\\$&"), "g")) || []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it("upsertBlock replaces the block content when it changes", () => {
    const first = upsertBlock("# Existing", `${BEGIN}\nOLD\n${END}`);
    const second = upsertBlock(first, `${BEGIN}\nNEW\n${END}`);
    expect(second).toContain("NEW");
    expect(second).not.toContain("OLD");
  });

  // Regression: duplicate/nested BEGIN markers from a prior bad install must
  // collapse cleanly — find first BEGIN to last END and strip the whole span.
  it("duplicate BEGIN markers are cleaned up on next upsert", () => {
    const corrupted = `# Top\n${BEGIN}\nfirst\n${END}\n\nmiddle\n\n${BEGIN}\nsecond\n${END}\n`;
    const out = upsertBlock(corrupted, `${BEGIN}\nFRESH\n${END}`);
    const beginCount = (out.match(new RegExp(BEGIN.replace(/[-/]/g, "\\$&"), "g")) || []).length;
    const endCount = (out.match(new RegExp(END.replace(/[-/]/g, "\\$&"), "g")) || []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
    expect(out).toContain("FRESH");
    expect(out).not.toContain("first");
    expect(out).not.toContain("second");
  });

  // Regression: marker strings mentioned as plain text inside user code
  // examples must NOT be treated as real delimiters. The markers must be
  // the only content on their line to count.
  it("inline plain-text mention of marker does not corrupt the document", () => {
    const doc = `# Intro\n${BEGIN}\nreal block\n${END}\n\n# Notes\nExample: \`${END}\` is our sentinel.\n`;
    expect(hasBlock(doc)).toBe(true);
    const out = stripBlock(doc);
    // The user's notes section must survive.
    expect(out).toContain("# Notes");
    expect(out).toContain("Example:");
    expect(out).toContain("# Intro");
    // No marker block remains after stripping.
    expect(out).not.toContain(BEGIN);
  });
});
