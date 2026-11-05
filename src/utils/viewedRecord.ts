const MAX_VIEWED_INDEX_ENTRIES = 5000;

export function viewedEntryKey(entry: { filePath: string; diffContentHash: string }): string {
  return `${entry.filePath} ${entry.diffContentHash}`;
}

export function isMarkedAfterUnmark(viewedAt: string, removedAt: string): boolean {
  return Date.parse(viewedAt) > Date.parse(removedAt);
}

export function keepNewestViewedItems<T>(items: T[], timeOf: (item: T) => string): T[] {
  if (items.length <= MAX_VIEWED_INDEX_ENTRIES) return items;
  return [...items]
    .sort((a, b) => Date.parse(timeOf(b)) - Date.parse(timeOf(a)))
    .slice(0, MAX_VIEWED_INDEX_ENTRIES);
}
