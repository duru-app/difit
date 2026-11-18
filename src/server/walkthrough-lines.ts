import type { WalkthroughCase } from '../types/diff.js';

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
  const steps = cases.flatMap((item) => item.steps);
  const warnings = await Promise.all(
    steps.map(async ({ file, line, endLine = line }, index) => {
      const count = await countOf(file);
      if (count === null) return [`step ${index + 1}: ${file} is not in ${treeLabel}`];
      if (endLine > count) {
        return [`step ${index + 1}: ${file} has ${count} lines, so line ${endLine} is not there`];
      }
      return [];
    }),
  );
  return warnings.flat();
}
