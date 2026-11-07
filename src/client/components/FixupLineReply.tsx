import { type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react';

import type { DiffChunk, DiffLine, FixupLines, LineSelection, ThreadFixup } from '../../types/diff';
import { commitLocationLabel, endOfLine, locationLabel } from '../../utils/commentPosition';
import { appearsResolved, pendingFixupsFor } from '../../utils/reviewDecisions';
import { useFixupOverlay } from '../contexts/FixupOverlayContext';
import { useLinePickState } from '../contexts/LinePickContext';
import { useCanHover } from '../hooks/useCanHover';
import { fixupLinesLabel, fixupLinesPlace } from '../utils/fixupLines';
import { type AnsweredThread, type FixupFile, fixupFileKey } from '../utils/fixupSpread';

import { CommentForm } from './CommentForm';
import { PickControls } from './LinePickParts';

export const fixupLineOf = (line: DiffLine): LineSelection | null => {
  const lineNumber = line.type === 'delete' ? line.oldLineNumber : line.newLineNumber;
  if (lineNumber === undefined) return null;
  return { side: line.type === 'delete' ? 'old' : 'new', lineNumber };
};

const sameLine = (a: LineSelection | null, b: LineSelection) =>
  a?.side === b.side && a.lineNumber === b.lineNumber;

export interface FixupLineReplying {
  isPicked: (line: LineSelection) => boolean;
  press: (line: LineSelection, event: MouseEvent) => void;
  click: (line: LineSelection, event: MouseEvent) => void;
  addsLines: boolean;
  hover: (line: LineSelection) => void;
  isFormUnder: (line: LineSelection) => boolean;
  form: ReactNode;
}

export function useFixupLineReply({
  fixup,
  file,
  chunks,
  threads,
}: {
  fixup: Pick<ThreadFixup, 'sha' | 'patchId'>;
  file: FixupFile;
  chunks: readonly DiffChunk[];
  threads: readonly AnsweredThread[];
}): FixupLineReplying | undefined {
  const { replyToThread, fixupsByThread, decisions, recordDecision } = useFixupOverlay();
  const lines = useMemo(() => chunks.flatMap((chunk) => chunk.lines), [chunks]);
  const store = useLinePickState(lines, null);
  const canHover = useCanHover();
  const [drag, setDrag] = useState<{
    from: LineSelection;
    to: LineSelection;
    adds: boolean;
  } | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const { open, openBetween, addBetween } = store;
  const picking = store.pick !== null;

  useEffect(() => {
    if (!picking) setDraft('');
  }, [picking]);

  useEffect(() => {
    if (!drag) return undefined;
    // Deferred past the click that follows mouseup, which closes empty comment forms.
    const swallowClick = (event: Event) => event.stopPropagation();
    const finish = () => {
      if (drag.adds && !sameLine(drag.from, drag.to)) {
        document.addEventListener('click', swallowClick, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallowClick, true), 0);
      }
      setTimeout(() => {
        if (sameLine(drag.from, drag.to)) {
          if (!drag.adds) open(drag.from.side, drag.from.lineNumber);
        } else if (drag.adds) addBetween(drag.from, drag.to, 'unified');
        else openBetween(drag.from, drag.to, 'unified');
        setDrag(null);
      }, 0);
    };
    document.addEventListener('mouseup', finish);
    return () => document.removeEventListener('mouseup', finish);
  }, [drag, open, openBetween, addBetween]);

  const target = threads.find(({ id }) => id === chosenId) ?? threads[0];
  if (!replyToThread || !target) return undefined;

  const ranges = store.pick ? store.ranges('unified') : [];
  const last = ranges.at(-1);
  const resolved = appearsResolved(target.id, fixupsByThread.get(target.id) ?? [], decisions);

  const picksOnClick = (event: MouseEvent) =>
    event.shiftKey || event.ctrlKey || event.metaKey || store.addMode;

  const submit = (body: string) => {
    const fixupLines: FixupLines = {
      fixupSha: fixup.sha,
      patchId: fixup.patchId,
      filePath: file.path,
      ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
      ranges: ranges.map(({ side, line }) => ({
        side,
        line,
        code: store.contentOf(side, line),
      })),
    };
    replyToThread(target.id, body, { fixupLines });
    if (resolved) recordDecision(target.id, 'unresolved', '');
    store.close();
    return Promise.resolve();
  };

  const dragged = drag ? store.between(drag.from, drag.to, 'unified') : undefined;
  const marked = drag?.adds
    ? [...(store.pick?.lines ?? []), ...(dragged ?? [])]
    : (dragged ?? store.pick?.lines);

  return {
    isPicked: (line) => marked?.some((picked) => sameLine(picked, line)) ?? false,
    press: (line, event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const adds = picksOnClick(event);
      if (event.shiftKey) return;
      if (!adds) store.setAnchor(line);
      setDrag({ from: line, to: line, adds });
    },
    click: (line, event) => {
      if (!picksOnClick(event)) return;
      if (event.shiftKey) store.extend(line, 'unified');
      else store.toggle(line);
    },
    addsLines: store.addMode,
    hover: (line) => {
      if (drag && !sameLine(drag.to, line)) setDrag({ ...drag, to: line });
    },
    isFormUnder: (line) =>
      last !== undefined && line.side === last.side && line.lineNumber === endOfLine(last.line),
    form: last && (
      <CommentForm
        label="fixup 줄에 답글"
        location={fixupLinesLabel({
          fixupSha: fixup.sha,
          filePath: file.path,
          ranges,
        })}
        header={
          <>
            {threads.length > 1 && (
              <label className="mb-2 flex items-center gap-2 text-xs text-github-text-secondary">
                답글을 달 지적
                <select
                  value={target.id}
                  onChange={(event) => setChosenId(event.target.value)}
                  className="min-w-0 rounded border border-github-border bg-github-bg-secondary px-1 py-0.5 font-mono text-github-text-primary"
                >
                  {threads.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {'file' in thread
                        ? locationLabel(thread.file, thread.line, thread.extraLines, thread.side)
                        : commitLocationLabel(thread)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <PickControls store={store} ranges={[]} canHover={canHover} />
          </>
        }
        value={draft}
        onValueChange={setDraft}
        onSubmit={submit}
        onCancel={store.close}
        submitLabel={resolved ? '답글 달고 다시 열기' : '답글'}
        placeholder="이 줄에 답글..."
      />
    ),
  };
}

const NO_PLACE_REASONS = {
  hidden: '수정을 겹쳐 보기를 켜면 갈 수 있습니다',
  gone: '지금 이력에 없는 fixup이라 갈 곳이 없습니다',
  rejected: '거절한 fixup은 겹쳐 보기에 나오지 않아 갈 수 없습니다',
  notShown: '이 fixup은 겹쳐 보기에 나오지 않아 갈 수 없습니다',
};

function noPlaceReason(state: {
  loaded: boolean;
  inHistory: boolean;
  drawn: boolean | undefined;
  rejected: boolean;
  enabled: boolean;
}): string | undefined {
  if (!state.loaded) return undefined;
  if (!state.inHistory) return NO_PLACE_REASONS.gone;
  if (state.rejected) return NO_PLACE_REASONS.rejected;
  if (state.drawn === false) return NO_PLACE_REASONS.notShown;
  return state.enabled ? undefined : NO_PLACE_REASONS.hidden;
}

export function FixupLinesButton({ lines, threadId }: { lines: FixupLines; threadId: string }) {
  const {
    revealFixupLines,
    fixupsByThread,
    decisions,
    enabled,
    fixupsLoaded,
    reachableFixupFiles,
  } = useFixupOverlay();
  const canHover = useCanHover();
  const [reasonOpen, setReasonOpen] = useState(false);
  const place = fixupLinesPlace(lines, fixupsByThread);
  const label = fixupLinesLabel({ ...lines, fixupSha: place.fixupSha });
  const threadFixups = fixupsByThread.get(threadId) ?? [];
  const isPlaceFixup = ({ sha }: { sha: string }) => sha === place.fixupSha;
  const rejected =
    threadFixups.some(isPlaceFixup) &&
    !pendingFixupsFor(threadId, threadFixups, decisions).some(isPlaceFixup);
  const drawn = reachableFixupFiles?.has(
    fixupFileKey({ fixupSha: place.fixupSha, path: place.path }),
  );
  const noPlace = noPlaceReason({
    loaded: fixupsLoaded,
    inHistory: place.inHistory,
    drawn,
    rejected,
    enabled,
  });
  const hasPlace = noPlace === undefined;
  useEffect(() => {
    if (hasPlace) setReasonOpen(false);
  }, [hasPlace]);
  const where = lines.oldPath ? `${lines.oldPath} → ${lines.filePath}` : lines.filePath;
  return (
    <>
      <button
        type="button"
        title={noPlace ? `${where}\n${noPlace}` : where}
        aria-label={noPlace ? `${label}, ${noPlace}` : undefined}
        aria-disabled={noPlace ? true : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (!noPlace) revealFixupLines(lines, threadId);
          else if (!canHover) setReasonOpen((open) => !open);
        }}
        className={`mb-1 max-w-full truncate rounded border border-github-warning/60 bg-github-bg-secondary px-1.5 py-0.5 font-mono text-xs text-github-text-secondary ${
          noPlace
            ? 'cursor-not-allowed! opacity-50'
            : 'hover:text-github-text-primary hover:underline'
        }`}
      >
        {label}
      </button>
      {noPlace && reasonOpen && !canHover && (
        <p className="mb-1 break-keep text-xs text-github-text-secondary">{noPlace}</p>
      )}
    </>
  );
}
