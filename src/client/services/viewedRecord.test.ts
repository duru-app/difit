import { afterEach, describe, expect, it, vi } from 'vitest';

import { syncViewedRecord } from './viewedRecord';

const entry = {
  filePath: 'a.txt',
  diffContentHash: 'h1',
  hashVersion: 1 as const,
  viewedAt: '2026-01-01T00:00:00.000Z',
};
const record = {
  version: 1,
  lastModifiedAt: '2026-01-01T00:00:00.000Z',
  entries: [entry],
  removed: [],
};

describe('syncViewedRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the update and returns the merged record', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(record)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(syncViewedRecord('repo', [entry])).resolves.toEqual(record);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/viewed-record/repo');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ entries: [entry], removed: [] });
  });

  it('asks the browser to finish a small write while the page unloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(record)));
    vi.stubGlobal('fetch', fetchMock);

    await syncViewedRecord('repo', [entry]);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].keepalive).toBe(true);

    const many = Array.from({ length: 1000 }, (_, i) => ({ ...entry, filePath: `f${i}.txt` }));
    await syncViewedRecord('repo', many);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].keepalive).toBe(false);
  });

  it('returns null when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(syncViewedRecord('repo', [entry])).resolves.toBeNull();
  });

  it('returns null on an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));

    await expect(syncViewedRecord('repo', [entry])).resolves.toBeNull();
  });

  it('returns null for a body that is not a record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>')));
    await expect(syncViewedRecord('repo', [entry])).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"entries":[]}')));
    await expect(syncViewedRecord('repo', [entry])).resolves.toBeNull();
  });
});
