/**
 * Tracks API costs across e2e test invocations.
 */

interface CostEntry {
  test: string;
  skill: string;
  costUsd: number;
  durationMs: number;
  timestamp: Date;
}

class CostTracker {
  private entries: CostEntry[] = [];

  record(test: string, skill: string, costUsd: number, durationMs: number): void {
    this.entries.push({
      test,
      skill,
      costUsd,
      durationMs,
      timestamp: new Date(),
    });
  }

  get totalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
  }

  get totalDuration(): number {
    return this.entries.reduce((sum, e) => sum + e.durationMs, 0);
  }

  report(): string {
    const COL_NAME = 30;
    const COL_COST = 10;
    const COL_DUR = 8;
    const innerWidth = COL_NAME + COL_COST + COL_DUR + 2; // +2 for spacing
    const boxWidth = innerWidth + 4; // +4 for "║ " and " ║"

    const hLine = '═'.repeat(boxWidth - 2);
    const lines = [
      `╔${hLine}╗`,
      `║${'BMAD E2E Test Cost Report'.padStart(Math.floor((boxWidth - 2 + 25) / 2)).padEnd(boxWidth - 2)}║`,
      `╠${hLine}╣`,
    ];

    for (const entry of this.entries) {
      const name =
        entry.skill.length > COL_NAME
          ? entry.skill.slice(0, COL_NAME - 1) + '…'
          : entry.skill.padEnd(COL_NAME);
      const cost = `$${entry.costUsd.toFixed(4)}`.padStart(COL_COST);
      const dur = `${(entry.durationMs / 1000).toFixed(1)}s`.padStart(COL_DUR);
      lines.push(`║ ${name} ${cost} ${dur} ║`);
    }

    const totalName = 'TOTAL'.padEnd(COL_NAME);
    const totalCost = `$${this.totalCost.toFixed(4)}`.padStart(COL_COST);
    const totalDur = `${(this.totalDuration / 1000).toFixed(1)}s`.padStart(COL_DUR);
    lines.push(`╠${hLine}╣`);
    lines.push(`║ ${totalName} ${totalCost} ${totalDur} ║`);
    lines.push(`╚${hLine}╝`);

    return lines.join('\n');
  }
}

/** Singleton cost tracker for the test suite */
export const costTracker = new CostTracker();
