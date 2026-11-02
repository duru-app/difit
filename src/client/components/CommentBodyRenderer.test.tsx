import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiffLineLinkProvider } from '../contexts/DiffLineLinkContext';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import { createDiffPathResolver } from '../utils/diffLineLinks';

import { CommentBodyRenderer } from './CommentBodyRenderer';

describe('CommentBodyRenderer', () => {
  it('renders plain text', () => {
    render(<CommentBodyRenderer body="Just a plain comment" />);

    expect(screen.getByText('Just a plain comment')).toBeInTheDocument();
  });

  it('renders bold text as <strong>', () => {
    const { container } = render(<CommentBodyRenderer body="This is **important**" />);

    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent('important');
  });

  it('renders inline code as <code>', () => {
    const { container } = render(<CommentBodyRenderer body="Use `foo()` here" />);

    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('foo()');
  });

  it('renders strikethrough via GFM', () => {
    const { container } = render(<CommentBodyRenderer body="~~removed~~" />);

    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del).toHaveTextContent('removed');
  });

  it('keeps single newlines as line breaks', () => {
    const { container } = render(<CommentBodyRenderer body={'line one\nline two'} />);

    expect(container.querySelector('br')).not.toBeNull();
    expect(container).toHaveTextContent('line one');
    expect(container).toHaveTextContent('line two');
  });

  it('keeps consecutive spaces inside paragraphs', () => {
    const { container } = render(<CommentBodyRenderer body={'aligned:    value'} />);

    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.textContent).toBe('aligned:    value');
    expect(paragraph?.className).toContain('whitespace-pre-wrap');
  });

  it('treats 4-space indented lines as code blocks (markdown semantics)', () => {
    const { container } = render(<CommentBodyRenderer body={'intro\n\n    indented line'} />);

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent('indented line');
  });

  it('renders fenced code blocks inside <pre>', () => {
    const { container } = render(
      <CommentBodyRenderer body={'Check this:\n\n```ts\nconst x = 1;\n```'} />,
    );

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent('const x = 1;');
  });

  it('keeps each line of a multi-line fenced code block on its own line', () => {
    const { container } = render(
      <CommentBodyRenderer body={'```js\nconsole.log(1);\n// comment\nconsole.log(2);\n```'} />,
    );

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('console.log(1);\n// comment\nconsole.log(2);');
  });

  it('renders fenced diff blocks with addition/deletion backgrounds', () => {
    const { container } = render(
      <CommentBodyRenderer body={'```diff\n- const x = 1;\n+ const x = 2;\n  unchanged\n```'} />,
    );

    const addedLine = container.querySelector('.bg-diff-addition-bg');
    const deletedLine = container.querySelector('.bg-diff-deletion-bg');
    expect(addedLine).not.toBeNull();
    expect(addedLine).toHaveTextContent('+ const x = 2;');
    expect(deletedLine).not.toBeNull();
    expect(deletedLine).toHaveTextContent('- const x = 1;');
    expect(container).toHaveTextContent('unchanged');
  });

  it('renders safe links as anchors', () => {
    const { container } = render(
      <CommentBodyRenderer body="See [docs](https://example.com/docs)" />,
    );

    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('href', 'https://example.com/docs');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveTextContent('docs');
  });

  it('does not render unsafe links as anchors', () => {
    const { container } = render(<CommentBodyRenderer body="Click [here](javascript:alert(1))" />);

    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('here');
  });

  it('does not render raw HTML', () => {
    const { container } = render(<CommentBodyRenderer body='<img src="x" onerror="alert(1)">' />);

    expect(container.querySelector('img')).toBeNull();
  });

  it('renders suggestion blocks with the suggested code', () => {
    const { container } = render(
      <WordHighlightProvider>
        <CommentBodyRenderer
          body={'Try this:\n\n```suggestion\nconst y = 2;\n```'}
          originalCode="const y = 1;"
        />
      </WordHighlightProvider>,
    );

    expect(container).toHaveTextContent('Try this:');
    expect(container).toHaveTextContent('const y = 2;');
    expect(container).toHaveTextContent('const y = 1;');
    expect(container.querySelector('.bg-diff-addition-bg')).not.toBeNull();
    expect(container.querySelector('.bg-diff-deletion-bg')).not.toBeNull();
  });

  it('renders markdown around suggestion blocks', () => {
    const { container } = render(
      <WordHighlightProvider>
        <CommentBodyRenderer
          body={'**Before** the block\n\n```suggestion\nnew code\n```\n\n*After* the block'}
        />
      </WordHighlightProvider>,
    );

    expect(container.querySelector('strong')).toHaveTextContent('Before');
    expect(container.querySelector('em')).toHaveTextContent('After');
    expect(container).toHaveTextContent('new code');
  });

  describe('path:line links', () => {
    const DIFF_PATHS = [
      'src/client/App.tsx',
      'src/client/components/CommentThreadCard.tsx',
      'src/cli/index.ts',
      'src/server/index.ts',
    ];
    const renderInDiff = (body: string) => {
      const open = vi.fn();
      const view = render(
        <DiffLineLinkProvider value={{ resolve: createDiffPathResolver(DIFF_PATHS), open }}>
          <CommentBodyRenderer body={body} />
        </DiffLineLinkProvider>,
      );
      return { ...view, open };
    };
    const lineLinks = () => screen.queryAllByRole('button', { name: /:\d/ });

    it('opens the file and line written in the text', () => {
      const { open } = renderInDiff('Same problem at src/client/App.tsx:2302, see there.');

      const link = screen.getByRole('button', { name: 'src/client/App.tsx:2302' });
      fireEvent.click(link);

      expect(open).toHaveBeenCalledWith({ file: 'src/client/App.tsx', line: 2302, endLine: 2302 });
      expect(screen.getByText(/Same problem at/)).toHaveTextContent(
        'Same problem at src/client/App.tsx:2302, see there.',
      );
    });

    it('opens a range of lines', () => {
      const { open } = renderInDiff('Look at src/cli/index.ts:10-20');

      fireEvent.click(screen.getByRole('button', { name: 'src/cli/index.ts:10-20' }));

      expect(open).toHaveBeenCalledWith({ file: 'src/cli/index.ts', line: 10, endLine: 20 });
    });

    it('links inline code that names a line of a diff file', () => {
      const { open } = renderInDiff('Also in `CommentThreadCard.tsx:120`.');

      const link = screen.getByRole('button', { name: 'CommentThreadCard.tsx:120' });
      expect(link.querySelector('code')).not.toBeNull();
      fireEvent.click(link);

      expect(open).toHaveBeenCalledWith({
        file: 'src/client/components/CommentThreadCard.tsx',
        line: 120,
        endLine: 120,
      });
    });

    it('links a shortened path only when one diff file ends with it', () => {
      renderInDiff('client/App.tsx:5 and index.ts:7 and server/index.ts:9');

      expect(lineLinks().map((link) => link.textContent)).toEqual([
        'client/App.tsx:5',
        'server/index.ts:9',
      ]);
    });

    it('leaves paths outside the diff, code blocks and URLs as plain text', () => {
      const { container } = renderInDiff(
        [
          'Not in the diff: src/other.ts:3 and `src/other.ts:4`.',
          'A URL: https://github.com/duru-app/difit/blob/main/src/client/App.tsx:12',
          'A [link](https://example.com) and [src/cli/index.ts:3](https://example.com/x)',
          'Inline code with more: `see src/cli/index.ts:3`',
          '',
          '```',
          'src/client/App.tsx:2302',
          '```',
        ].join('\n'),
      );

      expect(lineLinks()).toEqual([]);
      expect(container.querySelector('pre')).toHaveTextContent('src/client/App.tsx:2302');
    });

    it('links nothing outside a diff', () => {
      render(<CommentBodyRenderer body="See src/client/App.tsx:2302" />);

      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});
