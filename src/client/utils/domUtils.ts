import { NAVIGATION_SELECTORS } from '../constants/navigation';

/**
 * Utilities for safe DOM manipulation
 */

// Use a Map to store stable IDs for files
const fileIdMap = new Map<string, string>();
let fileIdCounter = 0;

/**
 * Get a stable, safe DOM ID for a file path
 * Uses an internal counter to ensure uniqueness without exposing file paths
 */
export function getFileElementId(filePath: string): string {
  if (!fileIdMap.has(filePath)) {
    fileIdMap.set(filePath, `file-${++fileIdCounter}`);
  }
  return fileIdMap.get(filePath) ?? '';
}

export const fixupFileElementId = (fixupSha: string, path: string) =>
  `fixup-${fixupSha.slice(0, 12)}-${getFileElementId(path)}`;

const ELEMENT_GAP_BELOW_HEADER_PX = 8;

// The file header sticks to the container top and covers an element of that file landing there.
export const stickyHeaderCover = (target: HTMLElement) => {
  const header = target
    .closest('[data-file-path]')
    ?.querySelector<HTMLElement>('[data-file-header]');
  if (!header || target.contains(header)) return 0;
  return header.getBoundingClientRect().height + ELEMENT_GAP_BELOW_HEADER_PX;
};

export const visibleTopOf = (target: HTMLElement) => {
  const diff = target.closest<HTMLElement>(NAVIGATION_SELECTORS.SCROLL_CONTAINER);
  if (!diff) return null;
  return { diff, top: diff.getBoundingClientRect().top + stickyHeaderCover(target) };
};

export const runsOffTheTopOf = (top: number, bottom: number, visibleTop: number) =>
  top < visibleTop && bottom > visibleTop;
