import { type ComponentProps, useCallback, useMemo, useState } from 'react';

import type { CommentThread } from '../../types/diff';
import type { FixupOverlayState } from '../contexts/FixupOverlayContext';
import { type MergedChunk, useExpandedLines } from '../hooks/useExpandedLines';
import { fixupFileElementId } from '../utils/domUtils';
import {
  type FixupOnlyFiles,
  fixupDiffFile,
  fixupFileKey,
  fixupFileLabels,
} from '../utils/fixupSpread';

import { DiffViewer } from './DiffViewer';

type DiffViewerProps = ComponentProps<typeof DiffViewer>;

type ViewerProps = Pick<
  DiffViewerProps,
  | 'diffMode'
  | 'showAuthorBadges'
  | 'syntaxTheme'
  | 'onResolveThread'
  | 'onReplyToThread'
  | 'onRemoveMessage'
  | 'onUpdateMessage'
  | 'onOpenInEditor'
>;

interface CommonProps extends ViewerProps {
  // Keyed by fixupFileKey of the group's fixup and the file path.
  threadsByFixupFile: ReadonlyMap<string, CommentThread[]>;
  // A comment added in a group's section is made on that group's fixup, named by its sha.
  onAddComment?: (
    fixupSha: string,
    ...comment: Parameters<NonNullable<DiffViewerProps['onAddComment']>>
  ) => Promise<void>;
  fixupOverlay: FixupOverlayState;
}

interface FixupOnlySectionsProps extends CommonProps {
  groups: readonly FixupOnlyFiles[];
  // Line ids of these sections are numbered from here so they never clash with a review file's.
  firstFileIndex: number;
}

interface FixupOnlyGroupProps extends CommonProps {
  group: FixupOnlyFiles;
  firstFileIndex: number;
}

const NO_THREADS: CommentThread[] = [];
const NO_CHUNKS: MergedChunk[] = [];
const NOT_VIEWED = new Set<string>();

function FixupOnlyGroup({
  group,
  threadsByFixupFile,
  firstFileIndex,
  fixupOverlay,
  onAddComment,
  ...viewerProps
}: FixupOnlyGroupProps) {
  const { fixup, files } = group;
  const parentSha = `${fixup.sha}^`;
  const addComment = useMemo<DiffViewerProps['onAddComment']>(
    () => onAddComment && ((...comment) => onAddComment(fixup.sha, ...comment)),
    [onAddComment, fixup.sha],
  );
  const sections = useMemo(
    () => files.map((file) => ({ file: fixupDiffFile(file), labels: fixupFileLabels(file) })),
    [files],
  );
  const { isLoading, openLines, readLines, prefetchFileContent, getMergedChunks } =
    useExpandedLines({
      baseCommitish: parentSha,
      targetCommitish: fixup.sha,
      diffIdentity: fixup.sha,
    });
  const mergedChunks = useMemo(
    () => sections.map(({ file }) => getMergedChunks(file)),
    [sections, getMergedChunks],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(files.filter((file) => file.isGenerated).map((file) => file.path)),
  );
  const focused = fixupOverlay.focusedFixupFile;
  const [seenFocus, setSeenFocus] = useState(focused);
  if (focused !== seenFocus) {
    setSeenFocus(focused);
    if (focused?.fixupSha === fixup.sha && collapsed.has(focused.path)) {
      setCollapsed(new Set([...collapsed].filter((path) => path !== focused.path)));
    }
  }
  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  const toggleAllCollapsed = useCallback(
    (shouldCollapse: boolean) =>
      setCollapsed(new Set(shouldCollapse ? files.map((file) => file.path) : [])),
    [files],
  );

  return (
    <section aria-label={`fixup ${fixup.shortSha}에서만 수정한 파일`}>
      <h2 className="mt-5 mb-3 pb-1.5 border-b-2 border-github-warning text-[13px] font-semibold text-github-warning">
        fixup {fixup.shortSha}에서만 수정한 파일 — 승인하면 원래 커밋에 합쳐진다
      </h2>
      {sections.map(({ file, labels }, index) => {
        const isFocused = focused?.fixupSha === fixup.sha && focused.path === file.path;
        return (
          <div
            key={file.path}
            id={fixupFileElementId(fixup.sha, file.path)}
            data-fixup-only-file={file.path}
            // The lines are the fixup's own diff, so a deleted line is in the fixup's parent.
            data-symbol-old-ref={parentSha}
            data-symbol-old-path={file.oldPath ?? file.path}
            data-symbol-new-ref={fixup.sha}
            className={`mb-6 ${isFocused ? 'rounded-md border-2 border-github-accent' : ''}`}
          >
            <DiffViewer
              {...viewerProps}
              file={file}
              threads={
                threadsByFixupFile.get(fixupFileKey({ fixupSha: fixup.sha, path: file.path })) ??
                NO_THREADS
              }
              onAddComment={addComment}
              headerLabels={labels}
              reviewedFiles={NOT_VIEWED}
              collapsedFiles={collapsed}
              onToggleCollapsed={toggleCollapsed}
              onToggleAllCollapsed={toggleAllCollapsed}
              baseCommitish={parentSha}
              targetCommitish={fixup.sha}
              fileIndex={firstFileIndex + index}
              fixupOverlay={fixupOverlay}
              mergedChunks={mergedChunks[index] ?? NO_CHUNKS}
              openLines={openLines}
              readLines={readLines}
              prefetchFileContent={prefetchFileContent}
              isExpandLoading={isLoading}
            />
          </div>
        );
      })}
    </section>
  );
}

export function FixupOnlySections({
  groups,
  firstFileIndex,
  fixupOverlay,
  ...groupProps
}: FixupOnlySectionsProps) {
  const withoutDirectEdit = useMemo(() => ({ ...fixupOverlay, directEdit: null }), [fixupOverlay]);

  return groups.map((group, groupIndex) => (
    <FixupOnlyGroup
      key={group.fixup.sha}
      {...groupProps}
      fixupOverlay={withoutDirectEdit}
      group={group}
      firstFileIndex={groups
        .slice(0, groupIndex)
        .reduce((index, earlier) => index + earlier.files.length, firstFileIndex)}
    />
  ));
}
