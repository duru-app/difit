import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import type {
  CommentThread,
  DiffLine,
  DiffSide,
  LineNumber,
  LineSelection,
  SidedLine,
} from '../../types/diff';
import {
  extendTo,
  type LinePick,
  linesBetween,
  pickLines,
  placeCard,
  type PickLayout,
  pickRows,
  rangesOfPick,
  samePickLines,
  toggleLine,
} from '../utils/linePick';

const FLASH_MS = 1400;

export interface LinePickStore {
  // The lines the open comment form is on; null while no form is open.
  pick: LinePick | null;
  quote?: string;
  // Plain clicks on line numbers add and take out lines, for screens without Ctrl.
  addMode: boolean;
  flashedThreadId: string | null;
  start: (side: DiffSide, line: LineNumber, quote?: string) => void;
  // Like start, but closes the form when it is already open on exactly these lines.
  open: (side: DiffSide, line: LineNumber) => void;
  // Like open, on every line of the rows from one line to the other.
  openBetween: (from: LineSelection, to: LineSelection, layout: PickLayout) => void;
  toggle: (selection: LineSelection) => void;
  extend: (selection: LineSelection, layout: PickLayout) => void;
  between: (from: LineSelection, to: LineSelection, layout: PickLayout) => LineSelection[];
  ranges: (layout: PickLayout) => SidedLine[];
  placeCard: (
    thread: Pick<CommentThread, 'line' | 'extraLines' | 'side'>,
    layout: PickLayout,
  ) => { card: SidedLine; others: SidedLine[] } | null;
  // The line clicked last, where a Shift+click starts.
  setAnchor: (selection: LineSelection) => void;
  setAddMode: (on: boolean) => void;
  close: () => void;
  contentOf: (side: DiffSide, line: LineNumber) => string;
  flash: (threadId: string) => void;
}

const lineNumberOn = (line: DiffLine, side: DiffSide) =>
  side === 'old' ? line.oldLineNumber : line.newLineNumber;

const sameAnchor = (a: LineSelection | null, b: LineSelection | null) =>
  !!a && !!b && a.side === b.side && a.lineNumber === b.lineNumber;

// `cursorLine` is the line under the keyboard cursor: a Ctrl+click picks the line clicked before
// it too while the cursor still sits there.
function useLinePickState(
  lines: readonly DiffLine[],
  cursorLine: LineSelection | null,
): LinePickStore {
  const [pick, setPick] = useState<LinePick | null>(null);
  const [quote, setQuote] = useState<string | undefined>();
  const [anchor, setAnchor] = useState<LineSelection | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [flashedThreadId, setFlashedThreadId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cursorLineRef = useRef(cursorLine);
  cursorLineRef.current = cursorLine;

  useEffect(
    () => () => {
      clearTimeout(flashTimer.current);
    },
    [],
  );

  const rows = useMemo(
    () => ({ unified: pickRows(lines, 'unified'), split: pickRows(lines, 'split') }),
    [lines],
  );

  const apply = useCallback((next: LinePick | null) => {
    setPick(next);
    setQuote(undefined);
    if (!next) setAddMode(false);
  }, []);

  const close = useCallback(() => {
    setPick(null);
    setQuote(undefined);
    setAddMode(false);
  }, []);

  const start = useCallback((side: DiffSide, line: LineNumber, nextQuote?: string) => {
    setPick(pickLines(side, line));
    setQuote(nextQuote);
  }, []);

  const open = useCallback(
    (side: DiffSide, line: LineNumber) => {
      const next = pickLines(side, line);
      if (quote === undefined && samePickLines(pick, next)) close();
      else start(side, line);
    },
    [pick, quote, close, start],
  );

  const between = useCallback(
    (from: LineSelection, to: LineSelection, layout: PickLayout) =>
      linesBetween(rows[layout], from, to),
    [rows],
  );

  const openBetween = useCallback(
    (from: LineSelection, to: LineSelection, layout: PickLayout) => {
      const lines = between(from, to, layout);
      const next = { lines, anchor: from, span: lines, adding: false };
      if (quote === undefined && samePickLines(pick, next)) close();
      else apply(next);
    },
    [pick, quote, close, apply, between],
  );

  const toggle = useCallback(
    (selection: LineSelection) => {
      const seed = sameAnchor(anchor, cursorLineRef.current) ? (anchor ?? undefined) : undefined;
      apply(toggleLine(pick, selection, seed));
      setAnchor(selection);
    },
    [anchor, pick, apply],
  );

  const extend = useCallback(
    (selection: LineSelection, layout: PickLayout) => {
      apply(extendTo(pick, anchor, selection, rows[layout]));
      if (!pick?.adding) setAnchor(selection);
    },
    [pick, anchor, rows, apply],
  );

  const ranges = useCallback(
    (layout: PickLayout) => (pick ? rangesOfPick(pick, rows[layout]) : []),
    [pick, rows],
  );

  const placeCardOn = useCallback(
    (thread: Pick<CommentThread, 'line' | 'extraLines' | 'side'>, layout: PickLayout) =>
      placeCard(thread, rows[layout]),
    [rows],
  );

  const contentOf = useCallback(
    (side: DiffSide, line: LineNumber) => {
      const [start, end] = Array.isArray(line) ? line : [line, line];
      return lines
        .filter((diffLine) => {
          const lineNumber = lineNumberOn(diffLine, side);
          return lineNumber !== undefined && lineNumber >= start && lineNumber <= end;
        })
        .map((diffLine) => diffLine.content)
        .join('\n');
    },
    [lines],
  );

  const flash = useCallback((threadId: string) => {
    setFlashedThreadId(threadId);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashedThreadId(null), FLASH_MS);
  }, []);

  return useMemo(
    () => ({
      pick,
      quote,
      addMode,
      flashedThreadId,
      start,
      open,
      openBetween,
      toggle,
      extend,
      between,
      ranges,
      placeCard: placeCardOn,
      setAnchor,
      setAddMode,
      close,
      contentOf,
      flash,
    }),
    [
      pick,
      quote,
      addMode,
      flashedThreadId,
      start,
      open,
      openBetween,
      toggle,
      extend,
      between,
      ranges,
      placeCardOn,
      close,
      contentOf,
      flash,
    ],
  );
}

const LinePickContext = createContext<LinePickStore | null>(null);

// Shares one pick across the parts of a file's diff, so a comment can take lines from several.
export function LinePickProvider({
  lines,
  cursorLine,
  children,
}: {
  lines: readonly DiffLine[];
  cursorLine: LineSelection | null;
  children: ReactNode;
}) {
  const store = useLinePickState(lines, cursorLine);
  return <LinePickContext.Provider value={store}>{children}</LinePickContext.Provider>;
}

export function useLinePick(
  lines: readonly DiffLine[],
  cursorLine: LineSelection | null,
): LinePickStore {
  const own = useLinePickState(lines, cursorLine);
  return useContext(LinePickContext) ?? own;
}

export function cursorLineOf(
  line: DiffLine | undefined,
  cursorSide: 'left' | 'right' | undefined,
): LineSelection | null {
  if (!line) return null;
  const side: DiffSide = cursorSide === 'left' ? 'old' : 'new';
  const lineNumber = lineNumberOn(line, side);
  return lineNumber === undefined ? null : { side, lineNumber };
}
