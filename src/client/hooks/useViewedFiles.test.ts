import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  type DiffFile,
  type SharedViewedRecord,
  type ViewedFileRecord,
  type ViewedHashIndex,
  type ViewedHashIndexEntry,
  type ViewedHashRemoval,
} from '../../types/diff';

import { useViewedFiles } from './useViewedFiles';

// Mock StorageService
const mockGetViewedFiles = vi.fn((): ViewedFileRecord[] => []);
const mockGetAppliedCleanRun = vi.fn((): string | null => null);
const mockSaveViewedFiles = vi.fn();
const mockGetViewedHashIndex = vi.fn(
  (_repositoryId?: string): ViewedHashIndex => ({
    version: 1,
    lastModifiedAt: new Date(0).toISOString(),
    entries: [],
  }),
);
const mockRecordViewedHashes = vi.fn(
  (_repositoryId: string | undefined, _entries: ViewedHashIndexEntry[]) => {},
);
const mockRemoveViewedHashes = vi.fn(
  (
    _repositoryId: string | undefined,
    _entries: Array<{ filePath: string; diffContentHash: string }>,
  ) => {},
);
const mockClearViewedHashIndex = vi.fn((_repositoryId?: string) => {});
const mockRecordViewedRemovals = vi.fn(
  (_repositoryId: string | undefined, _removals: ViewedHashRemoval[]) => {},
);

vi.mock('../services/StorageService', () => ({
  VIEWED_HASH_VERSION: 1,
  storageService: {
    getViewedFiles: () => mockGetViewedFiles(),
    getAppliedCleanRun: () => mockGetAppliedCleanRun(),
    saveViewedFiles: (...args: unknown[]) => mockSaveViewedFiles(...args),
    getViewedHashIndex: (repositoryId?: string) => mockGetViewedHashIndex(repositoryId),
    recordViewedHashes: (repositoryId: string | undefined, entries: ViewedHashIndexEntry[]) =>
      mockRecordViewedHashes(repositoryId, entries),
    removeViewedHashes: (
      repositoryId: string | undefined,
      entries: Array<{ filePath: string; diffContentHash: string }>,
    ) => mockRemoveViewedHashes(repositoryId, entries),
    clearViewedHashIndex: (repositoryId?: string) => mockClearViewedHashIndex(repositoryId),
    recordViewedRemovals: (repositoryId: string | undefined, removals: ViewedHashRemoval[]) =>
      mockRecordViewedRemovals(repositoryId, removals),
  },
}));

const mockSyncViewedRecord = vi.fn(
  async (
    _repositoryId: string,
    _entries: ViewedHashIndexEntry[],
    _removed?: ViewedHashRemoval[],
  ): Promise<SharedViewedRecord | null> => null,
);

vi.mock('../services/viewedRecord', () => ({
  syncViewedRecord: (
    repositoryId: string,
    entries: ViewedHashIndexEntry[],
    removed?: ViewedHashRemoval[],
  ) => mockSyncViewedRecord(repositoryId, entries, removed),
}));

// Mock diffUtils
vi.mock('../utils/diffUtils', () => ({
  generateDiffHash: vi.fn(async (content: string) => `hash-${content.slice(0, 10)}`),
  getDiffContentForHashing: vi.fn((file: DiffFile) => `${file.path}-${file.status}`),
}));

// Helper to create a mock DiffFile
function createMockDiffFile(
  path: string,
  status: 'modified' | 'added' | 'deleted' | 'renamed' = 'modified',
  isGenerated = false,
): DiffFile {
  return {
    path,
    status,
    additions: 10,
    deletions: 5,
    chunks: [],
    isGenerated,
  };
}

describe('useViewedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetViewedFiles.mockReturnValue([]);
    mockGetViewedHashIndex.mockReturnValue({
      version: 1,
      lastModifiedAt: new Date(0).toISOString(),
      entries: [],
    });
  });

  describe('initial state', () => {
    it('should initialize with empty viewed files', () => {
      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      expect(result.current.viewedFiles.size).toBe(0);
    });

    it('should not initialize without commitish values', () => {
      const { result } = renderHook(() => useViewedFiles(undefined, undefined));

      expect(mockGetViewedFiles).not.toHaveBeenCalled();
      expect(result.current.viewedFiles.size).toBe(0);
    });
  });

  describe('loading viewed files from storage', () => {
    it('should load viewed files from storage on mount', async () => {
      const storedRecords: ViewedFileRecord[] = [
        { filePath: 'src/file1.ts', viewedAt: '2024-01-01T00:00:00Z', diffContentHash: 'hash1' },
        { filePath: 'src/file2.ts', viewedAt: '2024-01-01T00:00:00Z', diffContentHash: 'hash2' },
      ];
      mockGetViewedFiles.mockReturnValue(storedRecords);

      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      await waitFor(() => {
        expect(result.current.viewedFiles.size).toBe(2);
      });

      expect(result.current.viewedFiles.has('src/file1.ts')).toBe(true);
      expect(result.current.viewedFiles.has('src/file2.ts')).toBe(true);
    });
  });

  describe('auto-collapsing files', () => {
    it('should auto-mark generated files as viewed', async () => {
      const initialFiles: DiffFile[] = [
        createMockDiffFile('package-lock.json', 'modified', true),
        createMockDiffFile('src/app.ts', 'modified', false),
      ];

      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc123', undefined, initialFiles),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.has('package-lock.json')).toBe(true);
      });

      expect(result.current.viewedFiles.has('src/app.ts')).toBe(false);
      expect(mockSaveViewedFiles).toHaveBeenCalled();
    });

    it('should auto-mark deleted files as viewed', async () => {
      const initialFiles: DiffFile[] = [
        createMockDiffFile('src/old-file.ts', 'deleted', false),
        createMockDiffFile('src/app.ts', 'modified', false),
      ];

      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc123', undefined, initialFiles),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/old-file.ts')).toBe(true);
      });

      expect(result.current.viewedFiles.has('src/app.ts')).toBe(false);
      expect(mockSaveViewedFiles).toHaveBeenCalled();
    });

    it('should auto-mark files matching configured auto-viewed patterns', async () => {
      const initialFiles: DiffFile[] = [
        createMockDiffFile('src/app.test.ts', 'modified', false),
        createMockDiffFile('src/app.ts', 'modified', false),
      ];

      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc123', undefined, initialFiles, undefined, [
          '*.test.ts',
        ]),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/app.test.ts')).toBe(true);
      });

      expect(result.current.viewedFiles.has('src/app.ts')).toBe(false);
      expect(mockSaveViewedFiles).toHaveBeenCalled();
    });

    it('should auto-mark both generated and deleted files as viewed', async () => {
      const initialFiles: DiffFile[] = [
        createMockDiffFile('package-lock.json', 'modified', true),
        createMockDiffFile('src/deleted.ts', 'deleted', false),
        createMockDiffFile('src/app.ts', 'modified', false),
      ];

      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc123', undefined, initialFiles),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.size).toBe(2);
      });

      expect(result.current.viewedFiles.has('package-lock.json')).toBe(true);
      expect(result.current.viewedFiles.has('src/deleted.ts')).toBe(true);
      expect(result.current.viewedFiles.has('src/app.ts')).toBe(false);
    });

    it('should not re-add already viewed files', async () => {
      const storedRecords: ViewedFileRecord[] = [
        {
          filePath: 'package-lock.json',
          viewedAt: '2024-01-01T00:00:00Z',
          diffContentHash: 'existing-hash',
        },
      ];
      mockGetViewedFiles.mockReturnValue(storedRecords);

      const initialFiles: DiffFile[] = [
        createMockDiffFile('package-lock.json', 'modified', true),
        createMockDiffFile('src/deleted.ts', 'deleted', false),
      ];

      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc123', undefined, initialFiles),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.size).toBe(2);
      });

      // The saved records should include the existing one plus the new deleted file
      const saveCall = mockSaveViewedFiles.mock.calls[0];
      const savedRecords = saveCall?.[2] as ViewedFileRecord[];
      expect(savedRecords).toHaveLength(2);

      // The existing record should keep its original hash
      const existingRecord = savedRecords?.find((r) => r.filePath === 'package-lock.json');
      expect(existingRecord?.diffContentHash).toBe('existing-hash');
    });
  });

  describe('toggleFileViewed', () => {
    it('should add file to viewed when not viewed', async () => {
      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      const diffFile = createMockDiffFile('src/app.ts', 'modified');

      await act(async () => {
        await result.current.toggleFileViewed('src/app.ts', diffFile);
      });

      expect(result.current.viewedFiles.has('src/app.ts')).toBe(true);
      expect(mockSaveViewedFiles).toHaveBeenCalled();
    });

    it('should remove file from viewed when already viewed', async () => {
      const storedRecords: ViewedFileRecord[] = [
        { filePath: 'src/app.ts', viewedAt: '2024-01-01T00:00:00Z', diffContentHash: 'hash1' },
      ];
      mockGetViewedFiles.mockReturnValue(storedRecords);

      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/app.ts')).toBe(true);
      });

      const diffFile = createMockDiffFile('src/app.ts', 'modified');

      await act(async () => {
        await result.current.toggleFileViewed('src/app.ts', diffFile);
      });

      expect(result.current.viewedFiles.has('src/app.ts')).toBe(false);
    });
  });

  describe('setFilesViewed', () => {
    it('marks multiple files as viewed at once', async () => {
      const files = [createMockDiffFile('src/dir/a.ts'), createMockDiffFile('src/dir/b.ts')];
      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc', undefined, files, 'repo-1'),
      );

      await waitFor(() => {
        expect(result.current.hasLoadedInitialViewedFiles).toBe(true);
      });

      await act(async () => {
        await result.current.setFilesViewed(files, true);
      });

      expect(result.current.viewedFiles.has('src/dir/a.ts')).toBe(true);
      expect(result.current.viewedFiles.has('src/dir/b.ts')).toBe(true);
      expect(mockRecordViewedHashes).toHaveBeenCalledTimes(1);
      const entries = mockRecordViewedHashes.mock.calls[0]![1];
      expect(entries).toHaveLength(2);
    });

    it('skips files that are already viewed when marking', async () => {
      const files = [createMockDiffFile('src/dir/a.ts'), createMockDiffFile('src/dir/b.ts')];
      mockGetViewedFiles.mockReturnValue([
        {
          filePath: 'src/dir/a.ts',
          viewedAt: '2024-01-01T00:00:00Z',
          diffContentHash: 'existing-hash',
        },
      ]);
      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc', undefined, files, 'repo-1'),
      );

      await waitFor(() => {
        expect(result.current.hasLoadedInitialViewedFiles).toBe(true);
      });

      await act(async () => {
        await result.current.setFilesViewed(files, true);
      });

      expect(result.current.viewedFiles.size).toBe(2);
      expect(mockRecordViewedHashes).toHaveBeenCalledTimes(1);
      const entries = mockRecordViewedHashes.mock.calls[0]![1];
      expect(entries).toHaveLength(1);
      expect(entries[0]!.filePath).toBe('src/dir/b.ts');
      // The already viewed file keeps its original record
      expect(result.current.getViewedFileRecord('src/dir/a.ts')?.diffContentHash).toBe(
        'existing-hash',
      );
    });

    it('unmarks multiple files at once and removes their index entries', async () => {
      const files = [createMockDiffFile('src/dir/a.ts'), createMockDiffFile('src/dir/b.ts')];
      mockGetViewedFiles.mockReturnValue([
        {
          filePath: 'src/dir/a.ts',
          viewedAt: '2024-01-01T00:00:00Z',
          diffContentHash: 'hash-a',
        },
        {
          filePath: 'src/dir/b.ts',
          viewedAt: '2024-01-01T00:00:00Z',
          diffContentHash: 'hash-b',
        },
      ]);
      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc', undefined, files, 'repo-1'),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.size).toBe(2);
      });

      await act(async () => {
        await result.current.setFilesViewed(files, false);
      });

      expect(result.current.viewedFiles.size).toBe(0);
      expect(mockRemoveViewedHashes).toHaveBeenCalledWith('repo-1', [
        { filePath: 'src/dir/a.ts', diffContentHash: 'hash-a' },
        { filePath: 'src/dir/b.ts', diffContentHash: 'hash-b' },
      ]);
    });

    it('does nothing when unmarking files that are not viewed', async () => {
      const files = [createMockDiffFile('src/dir/a.ts')];
      const { result } = renderHook(() =>
        useViewedFiles('main', 'feature-branch', 'abc', undefined, files, 'repo-1'),
      );

      await waitFor(() => {
        expect(result.current.hasLoadedInitialViewedFiles).toBe(true);
      });

      await act(async () => {
        await result.current.setFilesViewed(files, false);
      });

      expect(mockSaveViewedFiles).not.toHaveBeenCalled();
      expect(mockRemoveViewedHashes).not.toHaveBeenCalled();
    });
  });

  describe('getViewedFileRecord', () => {
    it('should return record for viewed file', async () => {
      const storedRecords: ViewedFileRecord[] = [
        { filePath: 'src/app.ts', viewedAt: '2024-01-01T00:00:00Z', diffContentHash: 'hash1' },
      ];
      mockGetViewedFiles.mockReturnValue(storedRecords);

      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/app.ts')).toBe(true);
      });

      const record = result.current.getViewedFileRecord('src/app.ts');
      expect(record).toBeDefined();
      expect(record?.filePath).toBe('src/app.ts');
      expect(record?.diffContentHash).toBe('hash1');
    });

    it('should return undefined for non-viewed file', () => {
      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      const record = result.current.getViewedFileRecord('src/not-viewed.ts');
      expect(record).toBeUndefined();
    });
  });

  describe('isFileContentChanged', () => {
    it('should return false for non-viewed file', async () => {
      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      const diffFile = createMockDiffFile('src/app.ts', 'modified');
      const isChanged = await result.current.isFileContentChanged('src/app.ts', diffFile);

      expect(isChanged).toBe(false);
    });

    it('should return false when hash matches', async () => {
      // Mock generates hash as: hash- + first 10 chars of content
      // getDiffContentForHashing returns: src/app.ts-modified
      // So hash = hash-src/app.ts (first 10 chars)
      const storedRecords: ViewedFileRecord[] = [
        {
          filePath: 'src/app.ts',
          viewedAt: '2024-01-01T00:00:00Z',
          diffContentHash: 'hash-src/app.ts',
        },
      ];
      mockGetViewedFiles.mockReturnValue(storedRecords);

      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/app.ts')).toBe(true);
      });

      const diffFile = createMockDiffFile('src/app.ts', 'modified');
      const isChanged = await result.current.isFileContentChanged('src/app.ts', diffFile);

      expect(isChanged).toBe(false);
    });

    it('should return true when hash differs', async () => {
      const storedRecords: ViewedFileRecord[] = [
        {
          filePath: 'src/app.ts',
          viewedAt: '2024-01-01T00:00:00Z',
          diffContentHash: 'old-hash',
        },
      ];
      mockGetViewedFiles.mockReturnValue(storedRecords);

      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/app.ts')).toBe(true);
      });

      const diffFile = createMockDiffFile('src/app.ts', 'modified');
      const isChanged = await result.current.isFileContentChanged('src/app.ts', diffFile);

      expect(isChanged).toBe(true);
    });
  });

  describe('clearViewedFiles', () => {
    it('should clear all viewed files', async () => {
      const storedRecords: ViewedFileRecord[] = [
        { filePath: 'src/file1.ts', viewedAt: '2024-01-01T00:00:00Z', diffContentHash: 'hash1' },
        { filePath: 'src/file2.ts', viewedAt: '2024-01-01T00:00:00Z', diffContentHash: 'hash2' },
      ];
      mockGetViewedFiles.mockReturnValue(storedRecords);

      const { result } = renderHook(() => useViewedFiles('main', 'feature-branch'));

      await waitFor(() => {
        expect(result.current.viewedFiles.size).toBe(2);
      });

      act(() => {
        result.current.clearViewedFiles();
      });

      expect(result.current.viewedFiles.size).toBe(0);
      expect(mockSaveViewedFiles).toHaveBeenCalledWith(
        'main',
        'feature-branch',
        [],
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('cross-comparison viewed-state carryover', () => {
    // The mock generateDiffHash returns `hash-${path-status}.slice(0,10)`. For a
    // file `src/foo.ts` with status `modified`, getDiffContentForHashing yields
    // `src/foo.ts-modified` and the hash is `hash-src/foo.t`.
    const hashFor = (path: string, status: string) => {
      const content = `${path}-${status}`;
      return `hash-${content.slice(0, 10)}`;
    };

    it('restores files as viewed when their diff hash matches the per-repo index', async () => {
      const initialFiles: DiffFile[] = [
        createMockDiffFile('src/unchanged.ts', 'modified', false),
        createMockDiffFile('src/changed.ts', 'modified', false),
      ];
      mockGetViewedHashIndex.mockReturnValue({
        version: 1,
        lastModifiedAt: new Date().toISOString(),
        entries: [
          {
            filePath: 'src/unchanged.ts',
            diffContentHash: hashFor('src/unchanged.ts', 'modified'),
            hashVersion: 1,
            viewedAt: '2026-01-01T00:00:00Z',
          },
          {
            filePath: 'src/changed.ts',
            diffContentHash: 'stale-hash',
            hashVersion: 1,
            viewedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'newhead', undefined, initialFiles, 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/unchanged.ts')).toBe(true);
      });
      expect(result.current.viewedFiles.has('src/changed.ts')).toBe(false);
    });

    it('restores from the matching (path, hash) entry when the index has multiple hashes for the same path', async () => {
      const initialFiles: DiffFile[] = [createMockDiffFile('src/foo.ts', 'modified', false)];
      mockGetViewedHashIndex.mockReturnValue({
        version: 1,
        lastModifiedAt: new Date().toISOString(),
        entries: [
          // A stale entry from a different comparison range (same path, different hash).
          {
            filePath: 'src/foo.ts',
            diffContentHash: 'some-other-hash',
            hashVersion: 1,
            viewedAt: '2026-01-01T00:00:00Z',
          },
          // The matching entry for the current diff.
          {
            filePath: 'src/foo.ts',
            diffContentHash: hashFor('src/foo.ts', 'modified'),
            hashVersion: 1,
            viewedAt: '2026-01-02T00:00:00Z',
          },
        ],
      });

      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'newhead', undefined, initialFiles, 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true);
      });
    });

    it('does not hydrate when the index only contains entries for other hashes of this path', async () => {
      const initialFiles: DiffFile[] = [createMockDiffFile('src/foo.ts', 'modified', false)];
      mockGetViewedHashIndex.mockReturnValue({
        version: 1,
        lastModifiedAt: new Date().toISOString(),
        entries: [
          {
            filePath: 'src/foo.ts',
            diffContentHash: 'hash-from-different-comparison',
            hashVersion: 1,
            viewedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'newhead', undefined, initialFiles, 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(mockGetViewedFiles).toHaveBeenCalled();
      });
      expect(result.current.viewedFiles.has('src/foo.ts')).toBe(false);
    });

    it('ignores index entries with a stale hashVersion', async () => {
      const initialFiles: DiffFile[] = [createMockDiffFile('src/unchanged.ts', 'modified', false)];
      mockGetViewedHashIndex.mockReturnValue({
        version: 1,
        lastModifiedAt: new Date().toISOString(),
        entries: [
          {
            filePath: 'src/unchanged.ts',
            diffContentHash: hashFor('src/unchanged.ts', 'modified'),
            // Cast through unknown to simulate a future version we don't understand.
            hashVersion: 999 as unknown as 1,
            viewedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'newhead', undefined, initialFiles, 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(mockGetViewedFiles).toHaveBeenCalled();
      });
      expect(result.current.viewedFiles.has('src/unchanged.ts')).toBe(false);
    });

    it('writes to the index when toggling a file viewed', async () => {
      const file = createMockDiffFile('src/foo.ts', 'modified', false);
      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'abc', undefined, [file], 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(mockGetViewedFiles).toHaveBeenCalled();
      });

      await act(async () => {
        await result.current.toggleFileViewed('src/foo.ts', file);
      });

      expect(mockRecordViewedHashes).toHaveBeenCalledTimes(1);
      const call = mockRecordViewedHashes.mock.calls[0]!;
      const repoArg = call[0] as string | undefined;
      const entriesArg = call[1] as ViewedHashIndexEntry[];
      expect(repoArg).toBe('repo-1');
      expect(entriesArg).toHaveLength(1);
      const first = entriesArg[0]!;
      expect(first.filePath).toBe('src/foo.ts');
      expect(first.hashVersion).toBe(1);
    });

    it('removes from the index when un-toggling a file', async () => {
      const file = createMockDiffFile('src/foo.ts', 'modified', false);
      mockGetViewedFiles.mockReturnValue([
        {
          filePath: 'src/foo.ts',
          viewedAt: '2026-01-01T00:00:00Z',
          diffContentHash: hashFor('src/foo.ts', 'modified'),
        },
      ]);

      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'abc', undefined, [file], 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true);
      });

      await act(async () => {
        await result.current.toggleFileViewed('src/foo.ts', file);
      });

      expect(mockRemoveViewedHashes).toHaveBeenCalledWith('repo-1', [
        { filePath: 'src/foo.ts', diffContentHash: hashFor('src/foo.ts', 'modified') },
      ]);
    });

    it('flags files as changedSinceViewed when a prior view exists with a different hash', async () => {
      const initialFiles: DiffFile[] = [
        createMockDiffFile('src/changed.ts', 'modified', false),
        createMockDiffFile('src/never-viewed.ts', 'modified', false),
        createMockDiffFile('src/unchanged.ts', 'modified', false),
      ];
      mockGetViewedHashIndex.mockReturnValue({
        version: 1,
        lastModifiedAt: new Date().toISOString(),
        entries: [
          // Prior view of src/changed.ts had a different hash than the current diff.
          {
            filePath: 'src/changed.ts',
            diffContentHash: 'old-hash',
            hashVersion: 1,
            viewedAt: '2026-01-01T00:00:00Z',
          },
          // Prior view of src/unchanged.ts matches the current hash, so it gets hydrated, not flagged.
          {
            filePath: 'src/unchanged.ts',
            diffContentHash: hashFor('src/unchanged.ts', 'modified'),
            hashVersion: 1,
            viewedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'newhead', undefined, initialFiles, 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(result.current.viewedFiles.has('src/unchanged.ts')).toBe(true);
      });

      expect(result.current.changedSinceViewedFiles.has('src/changed.ts')).toBe(true);
      expect(result.current.changedSinceViewedFiles.has('src/never-viewed.ts')).toBe(false);
      expect(result.current.changedSinceViewedFiles.has('src/unchanged.ts')).toBe(false);
    });

    it('clearViewedFiles also clears the per-repo index', async () => {
      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'abc', undefined, [], 'repo-1', [], undefined),
      );

      await waitFor(() => {
        expect(mockGetViewedFiles).toHaveBeenCalled();
      });

      act(() => {
        result.current.clearViewedFiles();
      });

      expect(mockClearViewedHashIndex).toHaveBeenCalledWith('repo-1');
    });
  });

  describe('shared viewed record', () => {
    const file = createMockDiffFile('src/foo.ts', 'modified', false);
    const hash = `hash-${'src/foo.ts-modified'.slice(0, 10)}`;
    const entry: ViewedHashIndexEntry = {
      filePath: 'src/foo.ts',
      diffContentHash: hash,
      hashVersion: 1,
      viewedAt: '2026-01-01T00:00:00.000Z',
    };
    const sharedRecord = (
      entries: ViewedHashIndexEntry[],
      removed: ViewedHashRemoval[] = [],
    ): SharedViewedRecord => ({
      version: 1,
      lastModifiedAt: '2026-01-02T00:00:00.000Z',
      entries,
      removed,
    });
    const indexWith = (entries: ViewedHashIndexEntry[]): ViewedHashIndex => ({
      version: 1,
      lastModifiedAt: '2026-01-01T00:00:00.000Z',
      entries,
    });

    const render = (repositoryId: string | undefined = 'repo-1', cleanRunId?: string) =>
      renderHook(() =>
        useViewedFiles(
          'main',
          'HEAD',
          'newhead',
          undefined,
          [file],
          repositoryId,
          [],
          undefined,
          cleanRunId,
        ),
      );

    it('sends the marks already in this browser when the review loads', async () => {
      mockGetViewedHashIndex.mockReturnValue(indexWith([entry]));

      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

      expect(mockSyncViewedRecord).toHaveBeenCalledWith('repo-1', [entry], undefined);
    });

    it('resends the unmarks kept in this browser when the review loads', async () => {
      const removal = {
        filePath: 'src/foo.ts',
        diffContentHash: hash,
        removedAt: '2026-01-02T00:00:00.000Z',
      };
      mockGetViewedHashIndex.mockReturnValue({ ...indexWith([]), removed: [removal] });

      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

      expect(mockSyncViewedRecord).toHaveBeenCalledWith('repo-1', [], [removal]);
    });

    it('keeps an unmark in this browser even when the request fails', async () => {
      mockGetViewedFiles.mockReturnValue([
        { filePath: 'src/foo.ts', viewedAt: entry.viewedAt, diffContentHash: hash },
      ]);
      mockSyncViewedRecord.mockResolvedValue(null);

      const { result } = render();
      await waitFor(() => expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true));

      await act(async () => {
        await result.current.toggleFileViewed('src/foo.ts', file);
      });

      expect(mockRecordViewedRemovals).toHaveBeenCalledWith('repo-1', [
        expect.objectContaining({ filePath: 'src/foo.ts', diffContentHash: hash }),
      ]);
    });

    it('copies marks from the shared record into the local index', async () => {
      mockSyncViewedRecord.mockResolvedValueOnce(sharedRecord([entry]));

      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

      expect(mockRecordViewedHashes).toHaveBeenCalledWith('repo-1', [entry]);
    });

    it('drops a local mark that was unmarked elsewhere', async () => {
      const removal = {
        filePath: 'src/foo.ts',
        diffContentHash: hash,
        removedAt: '2026-01-02T00:00:00.000Z',
      };
      mockGetViewedFiles.mockReturnValue([
        { filePath: 'src/foo.ts', viewedAt: entry.viewedAt, diffContentHash: hash },
      ]);
      mockGetViewedHashIndex.mockReturnValue(indexWith([]));
      mockSyncViewedRecord.mockResolvedValueOnce(sharedRecord([], [removal]));

      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

      expect(result.current.viewedFiles.has('src/foo.ts')).toBe(false);
      expect(mockRemoveViewedHashes).toHaveBeenCalledWith('repo-1', [removal]);
      expect(mockSaveViewedFiles.mock.lastCall?.[2]).toEqual([]);
    });

    it('keeps a local mark made after the unmark elsewhere', async () => {
      mockGetViewedFiles.mockReturnValue([
        { filePath: 'src/foo.ts', viewedAt: '2026-01-03T00:00:00.000Z', diffContentHash: hash },
      ]);
      mockSyncViewedRecord.mockResolvedValueOnce(
        sharedRecord(
          [],
          [
            {
              filePath: 'src/foo.ts',
              diffContentHash: hash,
              removedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        ),
      );

      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

      expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true);
    });

    it('falls back to the local index when the server fails', async () => {
      mockGetViewedHashIndex.mockReturnValue(indexWith([entry]));
      mockSyncViewedRecord.mockResolvedValueOnce(null);

      const { result } = render();
      await waitFor(() => expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true));
    });

    it('sends a new mark and an unmark to the shared record', async () => {
      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));
      mockSyncViewedRecord.mockClear();

      await act(async () => {
        await result.current.toggleFileViewed('src/foo.ts', file);
      });
      expect(mockSyncViewedRecord).toHaveBeenLastCalledWith(
        'repo-1',
        [expect.objectContaining({ filePath: 'src/foo.ts', diffContentHash: hash })],
        undefined,
      );

      await act(async () => {
        await result.current.toggleFileViewed('src/foo.ts', file);
      });
      expect(mockSyncViewedRecord).toHaveBeenLastCalledWith(
        'repo-1',
        [],
        [expect.objectContaining({ filePath: 'src/foo.ts', diffContentHash: hash })],
      );
    });

    it('keeps marking in the browser when the write fails', async () => {
      mockSyncViewedRecord.mockResolvedValue(null);

      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

      await act(async () => {
        await result.current.toggleFileViewed('src/foo.ts', file);
      });

      expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true);
      expect(mockRecordViewedHashes).toHaveBeenCalled();
    });

    it('sends folder marks and unmarks to the shared record', async () => {
      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));
      mockSyncViewedRecord.mockClear();

      await act(async () => {
        await result.current.setFilesViewed([file], true);
      });
      expect(mockSyncViewedRecord).toHaveBeenLastCalledWith(
        'repo-1',
        [expect.objectContaining({ filePath: 'src/foo.ts' })],
        undefined,
      );

      await act(async () => {
        await result.current.setFilesViewed([file], false);
      });
      expect(mockSyncViewedRecord).toHaveBeenLastCalledWith(
        'repo-1',
        [],
        [expect.objectContaining({ filePath: 'src/foo.ts' })],
      );
    });

    describe('with a clean run', () => {
      const record: ViewedFileRecord = {
        filePath: 'src/foo.ts',
        viewedAt: '2026-01-01T00:00:00.000Z',
        diffContentHash: 'hash',
      };

      it('shows and sends nothing from this browser when the run is new', async () => {
        mockGetAppliedCleanRun.mockReturnValue('old-run');
        mockGetViewedFiles.mockReturnValue([record]);
        mockGetViewedHashIndex.mockReturnValue(indexWith([entry]));

        const { result } = render('repo-1', 'new-run');
        mockGetViewedHashIndex.mockReturnValue(indexWith([]));
        await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

        expect(result.current.viewedFiles.size).toBe(0);
        expect(mockSyncViewedRecord).toHaveBeenCalledWith('repo-1', [], []);
      });

      it('keeps the marks of this browser when the run was already applied', async () => {
        mockGetAppliedCleanRun.mockReturnValue('same-run');
        mockGetViewedFiles.mockReturnValue([record]);
        mockGetViewedHashIndex.mockReturnValue(indexWith([entry]));

        const { result } = render('repo-1', 'same-run');
        await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

        expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true);
        expect(mockSyncViewedRecord).toHaveBeenCalledWith('repo-1', [entry], undefined);
      });
    });

    it('leaves the shared record alone when clearing this browser', async () => {
      const { result } = render();
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));
      mockSyncViewedRecord.mockClear();

      act(() => {
        result.current.clearViewedFiles();
      });

      expect(mockClearViewedHashIndex).toHaveBeenCalledWith('repo-1');
      expect(mockSyncViewedRecord).not.toHaveBeenCalled();
    });

    it('does not call the server without a repository id', async () => {
      const { result } = renderHook(() =>
        useViewedFiles('main', 'HEAD', 'newhead', undefined, [file]),
      );
      await waitFor(() => expect(result.current.hasLoadedInitialViewedFiles).toBe(true));

      await act(async () => {
        await result.current.toggleFileViewed('src/foo.ts', file);
      });

      expect(mockSyncViewedRecord).not.toHaveBeenCalled();
      expect(result.current.viewedFiles.has('src/foo.ts')).toBe(true);
    });
  });
});
