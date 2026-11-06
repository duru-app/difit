import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { type DiffResponse } from '../../types/diff';
import { getFileElementId, stickyHeaderCover } from '../utils/domUtils';

const INITIAL_RENDERED_FILE_COUNT = 2;
const LAZY_RENDER_ROOT_MARGIN = '1200px 0px';
const SIDEBAR_SCROLL_MAX_ATTEMPTS = 60;
const SIDEBAR_SCROLL_CORRECTION_DELAY_MS = 180;
// How long an element may take to be drawn after the scroll reached its file.
const ELEMENT_WAIT_MS = 3000;
const OVERLAY_SCROLLBAR_PX = 16;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

// Space presses these instead of scrolling.
const SPACE_PRESSES = 'button,[role=button],[role=checkbox],[role=switch],summary';

const isTextField = (element: HTMLElement) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement;

export const diffRevisionKey = (diffData: DiffResponse) =>
  `${diffData.requestedBaseCommitish ?? ''}:${diffData.requestedTargetCommitish ?? ''}:${diffData.requestedBaseMode ?? 'direct'}`;

interface UseLazyDiffRenderingOptions {
  diffData: DiffResponse | null;
  diffScrollContainerRef: React.RefObject<HTMLElement | null>;
  setDiffData: React.Dispatch<React.SetStateAction<DiffResponse | null>>;
}

interface UseLazyDiffRenderingReturn {
  renderedFilePaths: Set<string>;
  ensureFileRendered: (filePath: string) => void;
  ensureFilesRenderedUpTo: (filePath: string) => void;
  registerLazyFileContainer: (filePath: string, node: HTMLDivElement | null) => void;
  // With elementId, scrolls to that element, or to a reviewed file's header while it is not drawn.
  // When the element above it named by alsoShowId fits on screen together with it, that one lands
  // at the top instead, with the element below it.
  scrollFileIntoDiffContainer: (filePath: string, elementId?: string, alsoShowId?: string) => void;
  isFileScrolledPastContainerTop: (filePath: string) => boolean;
}

export function useLazyDiffRendering({
  diffData,
  diffScrollContainerRef,
  setDiffData,
}: UseLazyDiffRenderingOptions): UseLazyDiffRenderingReturn {
  const [renderedFilePaths, setRenderedFilePaths] = useState<Set<string>>(new Set());
  const renderedFilePathsRef = useRef<Set<string>>(new Set());
  const lazyFileObserverRef = useRef<IntersectionObserver | null>(null);
  const lazyFileNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const generatedStatusCheckedRef = useRef<Set<string>>(new Set());
  const scrollRequestIdRef = useRef(0);

  // Reset while rendering, so the first render of another selection draws only its first files.
  const revisionKey = diffData ? diffRevisionKey(diffData) : null;
  const [renderedRevisionKey, setRenderedRevisionKey] = useState<string | null>(null);
  if (renderedRevisionKey !== revisionKey) {
    const nextPaths = new Set(
      (diffData?.files ?? []).slice(0, INITIAL_RENDERED_FILE_COUNT).map((file) => file.path),
    );
    renderedFilePathsRef.current = nextPaths;
    // Left to the previous selection's observer, its files would all be drawn while the first
    // files are still empty; its effect cleanup disconnects it.
    lazyFileObserverRef.current = null;
    generatedStatusCheckedRef.current.clear();
    setRenderedRevisionKey(revisionKey);
    setRenderedFilePaths(nextPaths);
  }

  const shownRevisionKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = shownRevisionKeyRef.current;
    shownRevisionKeyRef.current = revisionKey;
    if (previous !== null && revisionKey !== null && previous !== revisionKey) {
      diffScrollContainerRef.current?.scrollTo({ top: 0 });
    }
  }, [revisionKey, diffScrollContainerRef]);

  // The user scrolling the diff drops a scroll still waiting for its target.
  useEffect(() => {
    const cancelPendingScroll = () => {
      scrollRequestIdRef.current += 1;
    };
    const isInDiff = (target: EventTarget | null) => {
      const container = diffScrollContainerRef.current;
      return !!container && target instanceof Node && container.contains(target);
    };
    const onPointerScroll = (event: Event) => {
      if (isInDiff(event.target)) cancelPendingScroll();
    };
    const isOnScrollbar = (event: PointerEvent) => {
      const container = diffScrollContainerRef.current;
      if (!container || event.target !== container) return false;
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left - container.clientLeft;
      const y = event.clientY - rect.top - container.clientTop;
      if (x >= container.clientWidth || y >= container.clientHeight) return true;
      const style = getComputedStyle(container);
      const borders = (start: string, end: string) =>
        (parseFloat(start) || 0) + (parseFloat(end) || 0);
      const hasOverlayScrollbarY =
        container.scrollHeight > container.clientHeight &&
        container.offsetWidth -
          container.clientWidth -
          borders(style.borderLeftWidth, style.borderRightWidth) <=
          0;
      const hasOverlayScrollbarX =
        container.scrollWidth > container.clientWidth &&
        container.offsetHeight -
          container.clientHeight -
          borders(style.borderTopWidth, style.borderBottomWidth) <=
          0;
      return (
        (hasOverlayScrollbarY && x >= container.clientWidth - OVERLAY_SCROLLBAR_PX) ||
        (hasOverlayScrollbarX && y >= container.clientHeight - OVERLAY_SCROLLBAR_PX)
      );
    };
    // A touch never drags a scrollbar; a mouse or pen does, and its middle button starts autoscroll.
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (isOnScrollbar(event) || (event.button === 1 && isInDiff(event.target))) {
        cancelPendingScroll();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || isTextField(target))) {
        return;
      }
      if (event.key === ' ' && target instanceof Element && target.closest(SPACE_PRESSES)) return;
      if (target === document.body || target === document.documentElement || isInDiff(target)) {
        cancelPendingScroll();
      }
    };
    const passive = { capture: true, passive: true };
    window.addEventListener('wheel', onPointerScroll, passive);
    window.addEventListener('touchmove', onPointerScroll, passive);
    window.addEventListener('pointerdown', onPointerDown, passive);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('wheel', onPointerScroll, passive);
      window.removeEventListener('touchmove', onPointerScroll, passive);
      window.removeEventListener('pointerdown', onPointerDown, passive);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [diffScrollContainerRef]);

  const ensureFileRendered = useCallback((filePath: string) => {
    const node = lazyFileNodesRef.current.get(filePath);
    if (node && lazyFileObserverRef.current) {
      lazyFileObserverRef.current.unobserve(node);
    }

    setRenderedFilePaths((prev) => {
      if (prev.has(filePath)) return prev;
      const next = new Set(prev);
      next.add(filePath);
      renderedFilePathsRef.current = next;
      return next;
    });
  }, []);

  const registerLazyFileContainer = useCallback((filePath: string, node: HTMLDivElement | null) => {
    const observer = lazyFileObserverRef.current;
    const previousNode = lazyFileNodesRef.current.get(filePath);
    if (previousNode && observer) {
      observer.unobserve(previousNode);
    }

    if (!node) {
      lazyFileNodesRef.current.delete(filePath);
      return;
    }

    lazyFileNodesRef.current.set(filePath, node);
    if (renderedFilePathsRef.current.has(filePath) || !observer) {
      return;
    }
    observer.observe(node);
  }, []);

  useEffect(() => {
    if (lazyFileObserverRef.current) {
      lazyFileObserverRef.current.disconnect();
    }

    if (!diffData) {
      lazyFileObserverRef.current = null;
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setRenderedFilePaths((prev) => {
          let changed = false;
          const next = new Set(prev);

          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const path = (entry.target as HTMLElement).dataset.filePath;
            if (!path || next.has(path)) return;
            next.add(path);
            observer.unobserve(entry.target);
            changed = true;
          });

          if (changed) {
            renderedFilePathsRef.current = next;
          }
          return changed ? next : prev;
        });
      },
      {
        root: diffScrollContainerRef.current,
        rootMargin: LAZY_RENDER_ROOT_MARGIN,
      },
    );

    lazyFileObserverRef.current = observer;
    lazyFileNodesRef.current.forEach((node, filePath) => {
      if (!renderedFilePathsRef.current.has(filePath)) {
        observer.observe(node);
      }
    });

    return () => {
      observer.disconnect();
      lazyFileObserverRef.current = null;
    };
  }, [diffData, diffScrollContainerRef]);

  const ensureFilesRenderedUpTo = useCallback(
    (filePath: string) => {
      if (!diffData) return;
      const targetIndex = diffData.files.findIndex((file) => file.path === filePath);
      if (targetIndex < 0) return;

      const observer = lazyFileObserverRef.current;

      setRenderedFilePaths((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (let i = 0; i <= targetIndex; i++) {
          const path = diffData.files[i]?.path;
          if (path && !next.has(path)) {
            next.add(path);
            changed = true;
            const node = lazyFileNodesRef.current.get(path);
            if (node && observer) {
              observer.unobserve(node);
            }
          }
        }
        if (changed) {
          renderedFilePathsRef.current = next;
        }
        return changed ? next : prev;
      });
    },
    [diffData],
  );

  const isFileScrolledPastContainerTop = useCallback(
    (filePath: string) => {
      const scrollContainer = diffScrollContainerRef.current;
      const target = document.getElementById(getFileElementId(filePath));
      if (!scrollContainer || !target) {
        return false;
      }

      const containerRect = scrollContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return targetRect.top < containerRect.top - 1;
    },
    [diffScrollContainerRef],
  );

  const scrollFileIntoDiffContainer = useCallback(
    (filePath: string, elementId?: string, alsoShowId?: string) => {
      const files = diffData?.files ?? [];
      const targetIndex = files.findIndex((file) => file.path === filePath);
      // An element outside the reviewed files sits below all of them.
      const lastAbove = targetIndex >= 0 ? targetIndex : elementId ? files.length - 1 : -1;
      const lastAbovePath = files[lastAbove]?.path;
      if (lastAbovePath !== undefined) ensureFilesRenderedUpTo(lastAbovePath);

      const requiredSectionIds =
        lastAbove >= 0
          ? files.slice(0, lastAbove + 1).map((file) => getFileElementId(file.path))
          : elementId
            ? []
            : [getFileElementId(filePath)];
      const requestId = scrollRequestIdRef.current + 1;
      scrollRequestIdRef.current = requestId;

      const areRequiredSectionsReady = () => {
        for (const sectionId of requiredSectionIds) {
          const sectionNode = document.getElementById(sectionId);
          if (!sectionNode || sectionNode.dataset.rendered !== 'true') {
            return false;
          }
        }
        return true;
      };

      // Which of the two it landed on, or null when neither is drawn yet.
      const scrollToFile = (): 'element' | 'file' | null => {
        const scrollContainer = diffScrollContainerRef.current;
        const fileSection =
          !elementId || targetIndex >= 0
            ? document.getElementById(getFileElementId(filePath))
            : null;
        const element = elementId ? document.getElementById(elementId) : null;
        const target = element || fileSection;
        if (!scrollContainer || !target) {
          return null;
        }

        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const cover = stickyHeaderCover(target);
        let offset = targetRect.top - containerRect.top - cover;
        const alsoShown = element && alsoShowId ? document.getElementById(alsoShowId) : null;
        if (alsoShown) {
          const alsoShownTop = alsoShown.getBoundingClientRect().top - containerRect.top;
          const targetBottom = targetRect.bottom - containerRect.top;
          if (targetBottom - alsoShownTop <= containerRect.height - cover) {
            offset = alsoShownTop - cover;
          }
        }

        scrollContainer.scrollTo({
          top: Math.max(0, scrollContainer.scrollTop + offset),
        });
        return element ? 'element' : 'file';
      };

      const correctLater = () => {
        window.setTimeout(() => {
          if (scrollRequestIdRef.current !== requestId) {
            return;
          }
          scrollToFile();
        }, SIDEBAR_SCROLL_CORRECTION_DELAY_MS);
      };

      const waitForElement = (id: string, deadline: number) => {
        requestAnimationFrame(() => {
          if (scrollRequestIdRef.current !== requestId) {
            return;
          }
          if (document.getElementById(id)) {
            scrollToFile();
            correctLater();
          } else if (Date.now() < deadline) {
            waitForElement(id, deadline);
          }
        });
      };

      let attempts = 0;
      const attemptScroll = () => {
        requestAnimationFrame(() => {
          if (scrollRequestIdRef.current !== requestId) {
            return;
          }

          if (!areRequiredSectionsReady()) {
            if (attempts < SIDEBAR_SCROLL_MAX_ATTEMPTS) {
              attempts++;
              attemptScroll();
            }
            return;
          }

          const landed = scrollToFile();
          if (!landed) {
            if (attempts < SIDEBAR_SCROLL_MAX_ATTEMPTS) {
              attempts++;
              attemptScroll();
            }
            return;
          }

          correctLater();
          if (landed === 'file' && elementId) {
            waitForElement(elementId, Date.now() + ELEMENT_WAIT_MS);
          }
        });
      };
      attemptScroll();
    },
    [diffData, diffScrollContainerRef, ensureFilesRenderedUpTo],
  );

  useEffect(() => {
    if (!diffData || diffData.targetCommitish === 'stdin') return;

    const ref = diffData.targetCommitish || 'HEAD';
    const generatedStatusRevisionKey = `${diffData.requestedBaseCommitish ?? ''}...${diffData.requestedTargetCommitish ?? ''}:${diffData.requestedBaseMode ?? 'direct'}`;

    diffData.files.forEach((file) => {
      if (
        !renderedFilePaths.has(file.path) ||
        file.isGenerated !== false ||
        file.status === 'deleted'
      ) {
        return;
      }

      const cacheKey = `${generatedStatusRevisionKey}:${ref}:${file.path}`;
      if (generatedStatusCheckedRef.current.has(cacheKey)) {
        return;
      }
      generatedStatusCheckedRef.current.add(cacheKey);

      const encodedPath = encodeURIComponent(file.path);
      fetch(`/api/generated-status/${encodedPath}?ref=${encodeURIComponent(ref)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((payload: { isGenerated?: unknown } | null) => {
          if (!payload || payload.isGenerated !== true) return;

          setDiffData((prev) => {
            if (!prev) return prev;
            if (
              prev.requestedBaseCommitish !== diffData.requestedBaseCommitish ||
              prev.requestedTargetCommitish !== diffData.requestedTargetCommitish ||
              prev.requestedBaseMode !== diffData.requestedBaseMode
            ) {
              return prev;
            }

            let changed = false;
            const nextFiles = prev.files.map((candidate) => {
              if (candidate.path !== file.path || candidate.isGenerated) {
                return candidate;
              }
              changed = true;
              return { ...candidate, isGenerated: true };
            });

            return changed ? { ...prev, files: nextFiles } : prev;
          });
        })
        .catch(() => {
          // Ignore generated status fetch failures and keep fast path.
        });
    });
  }, [diffData, renderedFilePaths, setDiffData]);

  return {
    renderedFilePaths,
    ensureFileRendered,
    ensureFilesRenderedUpTo,
    registerLazyFileContainer,
    scrollFileIntoDiffContainer,
    isFileScrolledPastContainerTop,
  };
}
