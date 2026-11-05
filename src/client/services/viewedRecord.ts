import type { SharedViewedRecord, ViewedHashIndexEntry, ViewedHashRemoval } from '../../types/diff';

const REQUEST_TIMEOUT_MS = 3000;
// Browsers refuse keepalive requests that add up to more than 64 KiB in flight.
const KEEPALIVE_BODY_LIMIT = 8 * 1024;

function isSharedViewedRecord(value: unknown): value is SharedViewedRecord {
  const record = value as Partial<SharedViewedRecord> | null;
  return Array.isArray(record?.entries) && Array.isArray(record?.removed);
}

export async function syncViewedRecord(
  repositoryId: string,
  entries: ViewedHashIndexEntry[],
  removed: ViewedHashRemoval[] = [],
): Promise<SharedViewedRecord | null> {
  try {
    const body = JSON.stringify({ entries, removed });
    const response = await fetch(`/api/viewed-record/${encodeURIComponent(repositoryId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < KEEPALIVE_BODY_LIMIT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return isSharedViewedRecord(data) ? data : null;
  } catch {
    return null;
  }
}
