import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  type CodeSelection,
  type CodeSelectionLayout,
  selectionInCode,
} from '../utils/codeSelection';

const SETTLE_MS = 150;
const HOLD_MS = 1000;

export interface SelectedCode extends CodeSelection {
  range: Range;
}

// Reports a selection only once the mouse button is released or the selection stops changing
// (a long press and its handles on a phone).
export function useCodeSelection(
  containerRef: RefObject<HTMLElement | null>,
  layout: CodeSelectionLayout,
  narrow?: (range: Range, container: Element) => Range | null,
) {
  const [selected, setSelected] = useState<SelectedCode | null>(null);
  const holdUntil = useRef(0);
  const reread = useRef<() => void>(() => {});
  const shown = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let mouseDown = false;

    const drop = () => {
      if (Date.now() < holdUntil.current) return;
      shown.current = false;
      setSelected(null);
    };
    const read = () => {
      const container = containerRef.current;
      const selection = document.getSelection();
      if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        drop();
        return;
      }
      const selectedRange = selection.getRangeAt(0);
      const range = narrow ? narrow(selectedRange, container) : selectedRange;
      const code = range && selectionInCode(range, container, layout);
      if (!range || !code) {
        drop();
        return;
      }
      shown.current = true;
      setSelected({ ...code, range: range.cloneRange() });
    };
    reread.current = read;
    const schedule = () => {
      clearTimeout(timer);
      const container = containerRef.current;
      if (mouseDown || !container) return;
      const selection = document.getSelection();
      const inside =
        (selection?.anchorNode && container.contains(selection.anchorNode)) ||
        (selection?.focusNode && container.contains(selection.focusNode));
      if (inside || shown.current) timer = setTimeout(read, SETTLE_MS);
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 0) mouseDown = true;
    };
    const handleMouseUp = () => {
      if (!mouseDown) return;
      mouseDown = false;
      schedule();
    };

    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [containerRef, layout, narrow]);

  // A tap on the bar can collapse the selection before the tap's click arrives.
  const hold = useCallback(() => {
    holdUntil.current = Date.now() + HOLD_MS;
    setTimeout(() => reread.current(), HOLD_MS);
  }, []);

  const clear = useCallback(() => {
    holdUntil.current = 0;
    shown.current = false;
    setSelected(null);
    document.getSelection()?.removeAllRanges();
  }, []);

  return { selected, hold, clear };
}
