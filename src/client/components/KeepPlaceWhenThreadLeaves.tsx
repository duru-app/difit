import { useLayoutEffect } from 'react';

import { runsOffTheTopOf, visibleTopOf } from '../utils/domUtils';

const CARD_ID_PREFIX = 'comment-thread-';
const FILE_COMMENT = '[id^="file-comment-"]';
const FOLDED_ROW = 'tr[data-folded-lines]';

interface FoldedRows {
  body: HTMLElement;
  count: number;
  above: number;
}

interface ReaderBlock {
  cardId: string;
  folds: FoldedRows | null;
  above: Element[];
  fileLevel: { list: HTMLElement | null; fileSection: HTMLElement | null } | null;
}

const holderOf = (part: HTMLElement) => {
  const fileComment = part.closest<HTMLElement>(FILE_COMMENT);
  if (fileComment) return fileComment;
  const cell = part.closest('td');
  if (!cell || part instanceof HTMLTableRowElement) return part;
  let holder = part;
  while (holder.parentElement && holder.parentElement !== cell) holder = holder.parentElement;
  return holder;
};

const aboveOf = (holder: HTMLElement) => {
  const found: Element[] = [];
  const collect = (from: Element) => {
    for (let item = from.previousElementSibling; item; item = item.previousElementSibling) {
      found.push(item);
    }
  };
  collect(holder);
  const row = holder.closest('tr');
  if (row && row !== holder) collect(row);
  return found;
};

const foldedRowsAround = (reader: HTMLElement): FoldedRows | null => {
  const body = reader.closest<HTMLElement>('tbody');
  if (!body) return null;
  const rows = [...body.querySelectorAll(FOLDED_ROW)];
  const above = rows.filter(
    (row) => reader.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING,
  ).length;
  return { body, count: rows.length, above };
};

const isCodeRow = (element: Element) => element.querySelector('[data-line-number-cell]') !== null;

const holdsThread = (element: Element) =>
  element.matches('[data-thread-overlay]') ||
  element.querySelector(`[data-thread-overlay],[id^="${CARD_ID_PREFIX}"]`) !== null;

const blocksUnderReader = () => {
  const overlays = new Map<string, HTMLElement[]>();
  for (const overlay of document.querySelectorAll<HTMLElement>('[data-thread-overlay]')) {
    const threadId = overlay.dataset.threadOverlay ?? '';
    overlays.set(threadId, [...(overlays.get(threadId) ?? []), overlay]);
  }
  const found = new Map<string, ReaderBlock>();
  for (const card of document.querySelectorAll<HTMLElement>(`[id^="${CARD_ID_PREFIX}"]`)) {
    const threadId = card.id.slice(CARD_ID_PREFIX.length);
    const visible = visibleTopOf(card);
    if (!visible) continue;
    const holders = [...(overlays.get(threadId) ?? []), card].map(holderOf);
    const reader = holders.find((holder) => {
      const { top, bottom } = holder.getBoundingClientRect();
      return runsOffTheTopOf(top, bottom, visible.top);
    });
    if (!reader) continue;
    const isFileLevel = reader.matches(FILE_COMMENT);
    found.set(threadId, {
      cardId: card.id,
      folds: foldedRowsAround(reader),
      above: aboveOf(reader),
      fileLevel: isFileLevel
        ? { list: reader.parentElement, fileSection: card.closest('[data-file-path]') }
        : null,
    });
  }
  return found;
};

const newlyFoldedRow = (folds: FoldedRows | null) => {
  if (!folds?.body.isConnected) return null;
  const rows = folds.body.querySelectorAll<HTMLElement>(FOLDED_ROW);
  return rows.length > folds.count ? (rows[folds.above] ?? null) : null;
};

const alignAfterLeaving = ({ cardId, folds, above, fileLevel }: ReaderBlock) => {
  if (document.getElementById(cardId)) return;
  const folded = newlyFoldedRow(folds);
  const foldedVisible = folded && visibleTopOf(folded);
  if (folded && foldedVisible) {
    foldedVisible.diff.scrollTop += folded.getBoundingClientRect().top - foldedVisible.top;
    return;
  }
  for (const candidate of above) {
    if (!(candidate instanceof HTMLElement) || !candidate.isConnected) continue;
    const alignsTop = isCodeRow(candidate);
    if (!alignsTop && !holdsThread(candidate)) continue;
    const visible = visibleTopOf(candidate);
    if (!visible) return;
    const rect = candidate.getBoundingClientRect();
    visible.diff.scrollTop += (alignsTop ? rect.top : rect.bottom) - visible.top;
    return;
  }
  const place = [fileLevel?.list, fileLevel?.fileSection].find((item) => item?.isConnected);
  const visible = place && visibleTopOf(place);
  if (place && visible) visible.diff.scrollTop += place.getBoundingClientRect().top - visible.top;
};

let measured: Map<string, ReaderBlock> | null = null;

export function KeepPlaceWhenThreadLeaves({ threadId }: { threadId: string }) {
  useLayoutEffect(
    () => () => {
      if (!measured) {
        measured = blocksUnderReader();
        queueMicrotask(() => {
          measured = null;
        });
      }
      const block = measured.get(threadId);
      if (block) queueMicrotask(() => alignAfterLeaving(block));
    },
    [threadId],
  );
  return null;
}
