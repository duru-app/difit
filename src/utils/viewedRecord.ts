export const MAX_VIEWED_INDEX_ENTRIES = 5000;

export function viewedEntryKey(entry: { filePath: string; diffContentHash: string }): string {
  return `${entry.filePath} ${entry.diffContentHash}`;
}

export function isMarkedAfterUnmark(viewedAt: string, removedAt: string): boolean {
  return Date.parse(viewedAt) > Date.parse(removedAt);
}
