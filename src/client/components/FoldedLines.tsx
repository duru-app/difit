import { UnfoldVertical } from 'lucide-react';

import type { DiffLine, DiffSide, LineNumber } from '../../types/diff';
import { type EditRange, rangeOfLine } from '../utils/directEdit';

export interface FoldedLines {
  start: number;
  end: number;
  summary: string;
  folded: boolean;
  locked?: boolean;
  onToggle: () => void;
}

export const NO_FOLDS: readonly FoldedLines[] = [];

export const foldAt = (folds: readonly FoldedLines[], index: number) =>
  folds.find((fold) => index >= fold.start && index <= fold.end);

type PickedLines = { side: DiffSide; lineNumber: LineNumber };

export function lockFoldsUnderForms(
  folds: readonly FoldedLines[],
  lines: DiffLine[],
  commentingLines: PickedLines | readonly PickedLines[] | null,
  editing: EditRange | null,
): readonly FoldedLines[] {
  const forms: { side: DiffSide; range: EditRange }[] = [];
  for (const { side, lineNumber } of [commentingLines ?? []].flat()) {
    forms.push({ side, range: rangeOfLine(lineNumber) });
  }
  if (editing) forms.push({ side: 'new', range: editing });
  if (folds.length === 0 || forms.length === 0) return folds;

  const touches = (fold: FoldedLines) => {
    for (let index = fold.start; index <= fold.end; index++) {
      const line = lines[index];
      const held = forms.some(({ side, range }) => {
        const lineNumber = side === 'old' ? line?.oldLineNumber : line?.newLineNumber;
        return lineNumber !== undefined && range.start <= lineNumber && lineNumber <= range.end;
      });
      if (held) return true;
    }
    return false;
  };
  let changed = false;
  const lockedFolds = folds.map((fold) => {
    if (!touches(fold)) return fold;
    changed = true;
    return { ...fold, folded: false, locked: true };
  });
  return changed ? lockedFolds : folds;
}

function FoldedLinesButton({ fold }: { fold: FoldedLines }) {
  return (
    <button
      type="button"
      onClick={fold.onToggle}
      disabled={fold.locked}
      title={fold.locked ? '입력창이 열려 있는 동안에는 접을 수 없습니다' : undefined}
      aria-expanded={!fold.folded}
      aria-label={`${fold.summary} · ${fold.folded ? '펼치기' : '접기'}`}
      className={`grid w-full grid-cols-[var(--line-number-width)_1fr] text-left font-mono enabled:cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
        fold.folded
          ? 'border-y border-github-border bg-github-bg-tertiary text-sm text-github-text-muted enabled:hover:bg-github-bg-secondary enabled:hover:text-github-text-primary'
          : 'text-xs text-github-text-muted enabled:hover:text-github-accent'
      }`}
    >
      {fold.folded ? (
        <>
          <span className="flex items-center justify-center border-r border-github-border text-github-text-primary">
            <UnfoldVertical size={16} aria-hidden="true" />
          </span>
          <span className="px-3 py-1.5">{fold.summary}</span>
        </>
      ) : (
        <>
          <span />
          <span className="px-3 py-0.5">{`▾ ${fold.summary} · 접기`}</span>
        </>
      )}
    </button>
  );
}

export function FoldedLinesRow({ fold, colSpan }: { fold: FoldedLines; colSpan: number }) {
  return (
    <tr data-folded-lines>
      <td colSpan={colSpan} className="p-0">
        <FoldedLinesButton fold={fold} />
      </td>
    </tr>
  );
}
