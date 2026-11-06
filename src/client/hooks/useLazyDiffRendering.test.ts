import { act, render, renderHook } from '@testing-library/react';
import { createElement, useLayoutEffect } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { DiffResponse } from '../../types/diff';
import { getFileElementId } from '../utils/domUtils';

import { useLazyDiffRendering } from './useLazyDiffRendering';

function renderLazyDiffRendering(container: HTMLElement | null) {
  return renderHook(() =>
    useLazyDiffRendering({
      diffData: null,
      diffScrollContainerRef: { current: container },
      setDiffData: () => {},
    }),
  );
}

function stubRect(element: HTMLElement, top: number, height = 100) {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      height,
    }) as DOMRect;
}

describe('useLazyDiffRendering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('isFileScrolledPastContainerTop', () => {
    const filePath = 'src/example.ts';

    function setup(containerTop: number, targetTop: number) {
      const container = document.createElement('div');
      stubRect(container, containerTop);
      const target = document.createElement('div');
      target.id = getFileElementId(filePath);
      stubRect(target, targetTop);
      document.body.appendChild(target);

      return renderLazyDiffRendering(container);
    }

    it('returns true when the file header is scrolled above the container top', () => {
      const { result } = setup(50, 20);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(true);
    });

    it('returns false when the file header is visible below the container top', () => {
      const { result } = setup(50, 120);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(false);
    });

    it('returns false when the file header is aligned with the container top', () => {
      const { result } = setup(50, 50);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(false);
    });

    it('returns false when the scroll container is not available', () => {
      const target = document.createElement('div');
      target.id = getFileElementId(filePath);
      stubRect(target, 0);
      document.body.appendChild(target);

      const { result } = renderLazyDiffRendering(null);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(false);
    });

    it('returns false when the file element does not exist', () => {
      const container = document.createElement('div');
      stubRect(container, 0);

      const { result } = renderLazyDiffRendering(container);
      expect(result.current.isFileScrolledPastContainerTop('missing/file.ts')).toBe(false);
    });
  });

  describe('scrollFileIntoDiffContainer', () => {
    const diffData: DiffResponse = {
      commit: 'abc',
      files: [
        { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, chunks: [] },
        { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, chunks: [] },
      ],
      ignoreWhitespace: false,
      isEmpty: false,
    };

    function setup(
      elements: Array<{ id: string; top: number; rendered?: boolean }>,
      containerHeight?: number,
    ) {
      const container = document.createElement('div');
      stubRect(container, 0, containerHeight);
      const scrollTo = vi.fn();
      container.scrollTo = scrollTo as typeof container.scrollTo;
      elements.forEach(({ id, top, rendered }) => {
        const element = document.createElement('div');
        element.id = id;
        if (rendered !== undefined) element.dataset.rendered = String(rendered);
        stubRect(element, top);
        document.body.appendChild(element);
      });
      const { result } = renderHook(() =>
        useLazyDiffRendering({
          diffData,
          diffScrollContainerRef: { current: container },
          setDiffData: () => {},
        }),
      );
      return { scroll: result.current.scrollFileIntoDiffContainer, scrollTo };
    }

    const reviewSections = [
      { id: getFileElementId('a.ts'), top: 100, rendered: true },
      { id: getFileElementId('b.ts'), top: 400, rendered: true },
    ];

    it('scrolls to an element inside a reviewed file', async () => {
      const { scroll, scrollTo } = setup([...reviewSections, { id: 'box', top: 520 }]);

      scroll('b.ts', 'box');

      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 520 }));
    });

    it("scrolls to the reviewed file's header when the element is not drawn", async () => {
      const { scroll, scrollTo } = setup(reviewSections);

      scroll('b.ts', 'box');

      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 400 }));
    });

    it('does not scroll to an element below the reviewed files while one of them is not drawn', async () => {
      const { scroll, scrollTo } = setup([
        reviewSections[0]!,
        { ...reviewSections[1]!, rendered: false },
        { id: 'only', top: 900 },
      ]);

      scroll('c.ts', 'only');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(scrollTo).not.toHaveBeenCalled();
    });

    // A reviewed file whose header sticks to the container top while its lines scroll under it.
    function reviewFileWithHeader(path: string, top: number, headerHeight: number) {
      const section = document.createElement('div');
      section.id = getFileElementId(path);
      section.dataset.filePath = path;
      section.dataset.rendered = 'true';
      stubRect(section, top);
      const header = document.createElement('div');
      header.dataset.fileHeader = '';
      header.getBoundingClientRect = () => ({ top, height: headerHeight }) as DOMRect;
      section.appendChild(header);
      document.body.appendChild(section);
      return section;
    }

    function setupWithHeaders(containerHeight?: number) {
      const container = document.createElement('div');
      stubRect(container, 0, containerHeight);
      const scrollTo = vi.fn();
      container.scrollTo = scrollTo as typeof container.scrollTo;
      reviewFileWithHeader('a.ts', 100, 60);
      const section = reviewFileWithHeader('b.ts', 400, 60);
      const { result } = renderHook(() =>
        useLazyDiffRendering({
          diffData,
          diffScrollContainerRef: { current: container },
          setDiffData: () => {},
        }),
      );
      const drawBox = (top: number) => {
        const box = document.createElement('div');
        box.id = 'box';
        stubRect(box, top);
        section.appendChild(box);
      };
      return {
        scroll: result.current.scrollFileIntoDiffContainer,
        scrollTo,
        drawBox,
        container,
        section,
      };
    }

    it("lands an element inside a reviewed file below that file's sticky header", async () => {
      const { scroll, scrollTo, drawBox } = setupWithHeaders();
      drawBox(520);

      scroll('b.ts', 'box');

      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled());
      const [{ top }] = scrollTo.mock.calls.at(-1) as [{ top: number }];
      expect(top).toBeLessThanOrEqual(520 - 60);
    });

    it("keeps the line above the element below that file's sticky header", async () => {
      const { scroll, scrollTo, drawBox, container, section } = setupWithHeaders(1000);
      Object.defineProperty(container, 'scrollTop', { value: 500 });
      stubRect(section, -300, 1200);
      const line = document.createElement('div');
      line.id = 'line';
      stubRect(line, 30);
      section.appendChild(line);
      drawBox(100);

      scroll('b.ts', 'box', 'line');

      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 30 - 68 }));
    });

    it('lands the file itself with its header at the container top', async () => {
      const { scroll, scrollTo } = setupWithHeaders();

      scroll('b.ts');

      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 400 }));
    });

    it('moves on to the element when it is drawn after the scroll reached its file', async () => {
      const { scroll, scrollTo, drawBox } = setupWithHeaders();

      scroll('b.ts', 'box');
      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 400 }));
      // Past the one correction after landing, as when the hidden lines it sits on are still being fetched.
      await new Promise((resolve) => setTimeout(resolve, 400));
      drawBox(900);

      await vi.waitFor(() => {
        const [{ top }] = scrollTo.mock.calls.at(-1) as [{ top: number }];
        expect(top).toBeGreaterThan(400);
        expect(top).toBeLessThanOrEqual(900 - 60);
      });
    });

    describe('when the user scrolls while the element is not drawn yet', () => {
      async function landOnFileThen(userScroll: (container: HTMLElement) => void) {
        const { scroll, scrollTo, drawBox, container } = setupWithHeaders();
        document.body.appendChild(container);
        scroll('b.ts', 'box');
        await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 400 }));

        userScroll(container);
        const callsBefore = scrollTo.mock.calls.length;
        drawBox(900);
        await new Promise((resolve) => setTimeout(resolve, 400));
        return scrollTo.mock.calls.slice(callsBefore);
      }

      it('stays where a wheel took it', async () => {
        expect(
          await landOnFileThen((container) =>
            container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })),
          ),
        ).toEqual([]);
      });

      it('stays where a touch drag took it', async () => {
        expect(
          await landOnFileThen((container) =>
            container.dispatchEvent(new Event('touchmove', { bubbles: true })),
          ),
        ).toEqual([]);
      });

      it('stays where a scroll key took it', async () => {
        expect(
          await landOnFileThen(() =>
            document.body.dispatchEvent(
              new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }),
            ),
          ),
        ).toEqual([]);
      });

      it('still moves on to the element after arrow keys typed into a text box', async () => {
        const typed = await landOnFileThen(() => {
          const textarea = document.createElement('textarea');
          document.body.appendChild(textarea);
          textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
        });
        expect(typed.length).toBeGreaterThan(0);
      });

      it('stays where a scroll key pressed on a line of the diff took it', async () => {
        expect(
          await landOnFileThen((container) => {
            const line = document.createElement('div');
            line.tabIndex = 0;
            container.appendChild(line);
            line.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
          }),
        ).toEqual([]);
      });

      it('still moves on to the element after arrow keys move through a list outside the diff', async () => {
        const moved = await landOnFileThen(() => {
          const row = document.createElement('div');
          row.tabIndex = 0;
          document.body.appendChild(row);
          row.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
        });
        expect(moved.length).toBeGreaterThan(0);
      });

      it('still moves on to the element after space presses a button in the diff', async () => {
        const pressed = await landOnFileThen((container) => {
          const button = document.createElement('button');
          container.appendChild(button);
          button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
        });
        expect(pressed.length).toBeGreaterThan(0);
      });

      it('still moves on to the element after space toggles a checkbox in the diff', async () => {
        const toggled = await landOnFileThen((container) => {
          const checkbox = document.createElement('div');
          checkbox.setAttribute('role', 'checkbox');
          checkbox.tabIndex = 0;
          container.appendChild(checkbox);
          checkbox.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
        });
        expect(toggled.length).toBeGreaterThan(0);
      });

      // A browser follows a pointerdown with a mousedown, also for a tap.
      const pressAt = (target: Element, init: MouseEventInit, pointerType = 'mouse') => {
        target.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, pointerType, ...init }),
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...init }));
      };

      const pressContainerAt = (
        container: HTMLElement,
        clientX: number,
        clientY: number,
        box: Partial<
          Record<'offsetWidth' | 'offsetHeight' | 'scrollWidth' | 'scrollHeight', number>
        > = {},
        pointerType = 'mouse',
      ) => {
        const sizes = {
          clientWidth: 300,
          clientHeight: 500,
          offsetWidth: 310,
          offsetHeight: 510,
          scrollWidth: 300,
          scrollHeight: 500,
          ...box,
        };
        Object.entries(sizes).forEach(([name, value]) =>
          Object.defineProperty(container, name, { configurable: true, value }),
        );
        pressAt(container, { button: 0, clientX, clientY }, pointerType);
      };
      // Overlay scrollbars take no layout space and are drawn over the content's edge.
      const overlay = { offsetWidth: 300, offsetHeight: 500 };

      it('stays where dragging an overlay scrollbar of the diff took it', async () => {
        expect(
          await landOnFileThen((container) =>
            pressContainerAt(container, 295, 50, { ...overlay, scrollHeight: 2000 }),
          ),
        ).toEqual([]);
      });

      it('stays where dragging an overlay horizontal scrollbar of the diff took it', async () => {
        expect(
          await landOnFileThen((container) =>
            pressContainerAt(container, 150, 495, { ...overlay, scrollWidth: 900 }),
          ),
        ).toEqual([]);
      });

      it('stays where a pen dragging the scrollbar of the diff took it', async () => {
        expect(
          await landOnFileThen((container) => pressContainerAt(container, 305, 50, {}, 'pen')),
        ).toEqual([]);
      });

      it('still moves on to the element after a tap on the bottom edge of a diff with overlay scrollbars', async () => {
        const tapped = await landOnFileThen((container) =>
          pressContainerAt(container, 150, 495, { ...overlay, scrollWidth: 900 }, 'touch'),
        );
        expect(tapped.length).toBeGreaterThan(0);
      });

      it('still moves on to the element after a tap on the right edge of a diff with overlay scrollbars', async () => {
        const tapped = await landOnFileThen((container) =>
          pressContainerAt(container, 295, 50, { ...overlay, scrollHeight: 2000 }, 'touch'),
        );
        expect(tapped.length).toBeGreaterThan(0);
      });

      it('still moves on to the element after a click on the right edge of a diff that does not scroll', async () => {
        const clicked = await landOnFileThen((container) =>
          pressContainerAt(container, 295, 50, overlay),
        );
        expect(clicked.length).toBeGreaterThan(0);
      });

      it('still moves on to the element after a click beside a classic scrollbar', async () => {
        const clicked = await landOnFileThen((container) =>
          pressContainerAt(container, 295, 50, { scrollHeight: 2000 }),
        );
        expect(clicked.length).toBeGreaterThan(0);
      });

      it('still moves on to the element after a click away from an overlay scrollbar', async () => {
        const clicked = await landOnFileThen((container) =>
          pressContainerAt(container, 150, 50, {
            ...overlay,
            scrollHeight: 2000,
            scrollWidth: 900,
          }),
        );
        expect(clicked.length).toBeGreaterThan(0);
      });

      it('stays where dragging the scrollbar of the diff took it', async () => {
        expect(await landOnFileThen((container) => pressContainerAt(container, 305, 50))).toEqual(
          [],
        );
      });

      it('still moves on to the element after a click on the empty bottom of the diff', async () => {
        const clicked = await landOnFileThen((container) => pressContainerAt(container, 150, 480));
        expect(clicked.length).toBeGreaterThan(0);
      });

      it('stays where a middle-button scroll in the diff took it', async () => {
        expect(
          await landOnFileThen((container) => {
            const line = document.createElement('div');
            container.appendChild(line);
            pressAt(line, { button: 1 });
          }),
        ).toEqual([]);
      });

      it('still moves on to the element after a click on a line of the diff', async () => {
        const clicked = await landOnFileThen((container) => {
          const line = document.createElement('div');
          container.appendChild(line);
          pressAt(line, { button: 0 });
        });
        expect(clicked.length).toBeGreaterThan(0);
      });

      it('still moves on to the element after a wheel outside the diff', async () => {
        const wheeled = await landOnFileThen(() =>
          document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })),
        );
        expect(wheeled.length).toBeGreaterThan(0);
      });
    });

    it('scrolls to an element outside the reviewed files', async () => {
      const { scroll, scrollTo } = setup([...reviewSections, { id: 'only', top: 900 }]);

      scroll('c.ts', 'only');

      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 900 }));
    });

    describe('with a line above the element to keep in sight', () => {
      const setupLineAndBox = (boxTop: number) =>
        setup([...reviewSections, { id: 'line', top: 300 }, { id: 'box', top: boxTop }], 1000);

      it('brings the line to the top even when it and the element are already in sight', async () => {
        const { scroll, scrollTo } = setupLineAndBox(500);

        scroll('b.ts', 'box', 'line');

        await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 300 }));
      });

      it('brings the line to the top with the element below it when the element is below the screen', async () => {
        const { scroll, scrollTo } = setupLineAndBox(1100);

        scroll('b.ts', 'box', 'line');

        await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 300 }));
      });

      it('puts the element at the top when it and the line do not fit together', async () => {
        const { scroll, scrollTo } = setupLineAndBox(1300);

        scroll('b.ts', 'box', 'line');

        await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1300 }));
      });
    });
  });

  describe('when another selection is shown', () => {
    const selection = (target: string, paths: string[]): DiffResponse => ({
      commit: target,
      files: paths.map((path) => ({
        path,
        status: 'modified',
        additions: 1,
        deletions: 0,
        chunks: [],
      })),
      ignoreWhitespace: false,
      isEmpty: false,
      requestedBaseCommitish: 'base',
      requestedTargetCommitish: target,
    });

    function setup(initial: DiffResponse) {
      const container = document.createElement('div');
      const scrollTo = vi.fn();
      container.scrollTo = scrollTo as typeof container.scrollTo;
      const committed: Array<{ diffData: DiffResponse; paths: string[] }> = [];
      const hook = renderHook(
        ({ diffData }: { diffData: DiffResponse }) => {
          const lazy = useLazyDiffRendering({
            diffData,
            diffScrollContainerRef: { current: container },
            setDiffData: () => {},
          });
          useLayoutEffect(() => {
            committed.push({ diffData, paths: [...lazy.renderedFilePaths] });
          });
          return lazy;
        },
        { initialProps: { diffData: initial } },
      );
      return { ...hook, committed, scrollTo };
    }

    it('draws only its first files from its first render', () => {
      const first = selection('one', ['a.ts', 'b.ts', 'c.ts']);
      const { result, rerender, committed } = setup(first);
      act(() => result.current.ensureFileRendered('c.ts'));

      const next = selection('two', ['x.ts', 'y.ts']);
      rerender({ diffData: next });

      const shown = committed.filter((entry) => entry.diffData === next);
      expect(shown.length).toBeGreaterThan(0);
      for (const entry of shown) expect(entry.paths.sort()).toEqual(['x.ts', 'y.ts']);
    });

    it('scrolls the diff back to the top, but not when the same selection is reloaded', () => {
      const { rerender, scrollTo } = setup(selection('one', ['a.ts']));

      rerender({ diffData: selection('one', ['a.ts', 'b.ts']) });
      expect(scrollTo).not.toHaveBeenCalled();

      rerender({ diffData: selection('two', ['x.ts']) });
      expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    });

    it("leaves its files to its own observer, not the previous selection's", () => {
      const observed: Array<{ observer: number; path: string | undefined }> = [];
      let created = 0;
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          private readonly id = created++;
          observe(node: HTMLElement) {
            observed.push({ observer: this.id, path: node.dataset.filePath });
          }
          unobserve() {}
          disconnect() {}
        },
      );
      const container = document.createElement('div');
      const Files = ({ diffData }: { diffData: DiffResponse }) => {
        const { registerLazyFileContainer } = useLazyDiffRendering({
          diffData,
          diffScrollContainerRef: { current: container },
          setDiffData: () => {},
        });
        return diffData.files.map(({ path }) =>
          createElement('div', {
            key: `${diffData.commit}:${path}`,
            'data-file-path': path,
            ref: (node: HTMLDivElement | null) => registerLazyFileContainer(path, node),
          }),
        );
      };
      const paths = (count: number, prefix: string) =>
        Array.from({ length: count }, (_, index) => `${prefix}${index}.ts`);

      const { rerender } = render(
        createElement(Files, { diffData: selection('one', paths(12, 'a')) }),
      );
      const firstObserver = created - 1;
      rerender(createElement(Files, { diffData: selection('two', paths(12, 'x')) }));

      const newFiles = observed.filter(({ path }) => path?.startsWith('x'));
      expect(newFiles.length).toBeGreaterThan(0);
      expect(newFiles.every(({ observer }) => observer > firstObserver)).toBe(true);
      vi.unstubAllGlobals();
    });
  });
});
