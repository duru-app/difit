import type { WalkthroughCase } from '../types/diff.js';
import { callPathTarget, caseLabel } from '../utils/walkthrough.js';

// `countLines` gives null for a file the tree does not have.
export async function warningsForMissingLines(
  cases: readonly WalkthroughCase[],
  treeLabel: string,
  countLines: (file: string) => Promise<number | null>,
): Promise<string[]> {
  const counts = new Map<string, Promise<number | null>>();
  const countOf = (file: string) => {
    const known = counts.get(file);
    if (known) return known;
    const counted = countLines(file);
    counts.set(file, counted);
    return counted;
  };
  const steps = cases.flatMap((item, caseIndex) =>
    item.steps.flatMap((step, index) => {
      const where = `${cases.length > 1 ? `${caseLabel(caseIndex)} ` : ''}step ${index + 1}`;
      const calls = (step.callPath ?? []).flatMap((entry, callIndex) => {
        const target = callPathTarget(entry);
        return target ? [{ ...target, where: `${where} call path ${callIndex + 1}` }] : [];
      });
      return [{ ...step, where }, ...calls];
    }),
  );
  const warnings = await Promise.all(
    steps.map(async ({ file, line, endLine = line, where }) => {
      const count = await countOf(file);
      if (count === null) return [`${where}: ${file} is not in ${treeLabel}`];
      if (endLine > count) {
        return [`${where}: ${file} has ${count} lines, so line ${endLine} is not there`];
      }
      return [];
    }),
  );
  return warnings.flat();
}
