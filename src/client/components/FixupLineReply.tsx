import { type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react';

import type { DiffChunk, DiffLine, FixupLines, LineSelection, ThreadFixup } from '../../types/diff';
import { commitLocationLabel, endOfLine, locationLabel } from '../../utils/commentPosition';
import { appearsResolved } from '../../utils/reviewDecisions';
import { useFixupOverlay } from '../contexts/FixupOverlayContext';
import { useLinePickState } from '../contexts/LinePickContext';
import { useCanHover } from '../hooks/useCanHover';
import { fixupLinesLabel } from '../utils/fixupLines';
import type { AnsweredThread, FixupFile } from '../utils/fixupSpread';

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
  const [drag, setDrag] = useState<{ from: LineSelection; to: LineSelection } | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const { open, openBetween } = store;

  useEffect(() => {
    if (!drag) return undefined;
    // Deferred past the click that follows mouseup, which closes empty comment forms.
    const finish = () =>
      setTimeout(() => {
        if (sameLine(drag.from, drag.to)) open(drag.from.side, drag.from.lineNumber);
        else openBetween(drag.from, drag.to, 'unified');
        setDrag(null);
      }, 0);
    document.addEventListener('mouseup', finish);
    return () => document.removeEventListener('mouseup', finish);
  }, [drag, open, openBetween]);

  const target = threads.find(({ id }) => id === chosenId) ?? threads[0];
  if (!replyToThread || !target) return undefined;

  const ranges = store.pick ? store.ranges('unified') : [];
  const last = ranges.at(-1);
  const resolved = appearsResolved(target.id, fixupsByThread.get(target.id) ?? [], decisions);

  const submit = (body: string) => {
    const fixupLines: FixupLines = {
      fixupSha: fixup.sha,
      patchId: fixup.patchId,
      filePath: file.path,
      ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
      ranges: ranges.map(({ side, line }) => ({ side, line, code: store.contentOf(side, line) })),
    };
    replyToThread(target.id, body, { fixupLines });
    if (resolved) recordDecision(target.id, 'unresolved', '');
    store.close();
    return Promise.resolve();
  };

  return {
    isPicked: (line) => store.pick?.lines.some((picked) => sameLine(picked, line)) ?? false,
    press: (line, event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (event.shiftKey) store.extend(line, 'unified');
      else if (event.ctrlKey || event.metaKey || store.addMode) store.toggle(line);
      else {
        store.setAnchor(line);
        setDrag({ from: line, to: line });
      }
    },
    hover: (line) => {
      if (drag && !sameLine(drag.to, line)) setDrag({ ...drag, to: line });
    },
    isFormUnder: (line) =>
      last !== undefined && line.side === last.side && line.lineNumber === endOfLine(last.line),
    form: last && (
      <div className="font-sans">
        <CommentForm
          label="fixup 줄에 답글"
          title={fixupLinesLabel({ fixupSha: fixup.sha, filePath: file.path, ranges })}
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
          onSubmit={submit}
          onCancel={store.close}
          submitLabel={resolved ? '답글 달고 다시 열기' : '답글'}
          placeholder="이 줄에 답글..."
        />
      </div>
    ),
  };
}

export function FixupLinesButton({ lines }: { lines: FixupLines }) {
  const { revealFixupLines } = useFixupOverlay();
  return (
    <button
      type="button"
      title={lines.oldPath ? `${lines.oldPath} → ${lines.filePath}` : lines.filePath}
      onClick={(event) => {
        event.stopPropagation();
        revealFixupLines(lines);
      }}
      className="mb-1 max-w-full truncate rounded border border-github-warning/60 bg-github-bg-secondary px-1.5 py-0.5 font-mono text-xs text-github-text-secondary hover:text-github-text-primary hover:underline"
    >
      {fixupLinesLabel(lines)}
    </button>
  );
}
