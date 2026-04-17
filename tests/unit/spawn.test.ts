import { describe, expect, it } from "vitest";
// @ts-expect-error — CommonJS module
import spawnMod from "../../_Sprintpilot/lib/runtime/spawn.js";

const { run, tryRun } = spawnMod as {
  run: (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  tryRun: (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number; error?: Error }>;
};

describe("spawn.run / tryRun", () => {
  it("run resolves on successful command", async () => {
    const r = await run("node", ["-e", "process.stdout.write('hi')"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi");
  });

  it("run rejects with exit code on failure", async () => {
    await expect(run("node", ["-e", "process.exit(3)"])).rejects.toMatchObject({ exitCode: 3 });
  });

  // Regression: ENOENT on spawn must reject the Promise cleanly, NOT hang
  // forever trying to write to proc.stdin.
  it("run rejects cleanly when the binary does not exist (ENOENT)", async () => {
    await expect(run("this-binary-definitely-does-not-exist-xyz", [])).rejects.toThrow();
  });

  it("tryRun returns structured result on failure instead of throwing", async () => {
    const r = await tryRun("node", ["-e", "process.exit(5)"]);
    expect(r.exitCode).toBe(5);
  });

  it("tryRun returns structured result on ENOENT", async () => {
    const r = await tryRun("this-binary-definitely-does-not-exist-xyz", []);
    expect(r.exitCode).not.toBe(0);
  });
});
