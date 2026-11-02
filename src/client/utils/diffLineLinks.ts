export interface DiffLineTarget {
  file: string;
  line: number;
  endLine: number;
}

// The diff file a written path names, or null when it names none or several.
export type DiffPathResolver = (written: string) => string | null;

interface DiffLineLinkMatch {
  start: number;
  end: number;
  target: DiffLineTarget;
}

const PATH_CHAR = String.raw`[\p{L}\p{N}_.@~+\-]`;
const PATH_LINE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@~+\-/\\:])((?:${PATH_CHAR}+/)*${PATH_CHAR}+):(\d+)(?:-(\d+))?(?![\p{L}\p{N}_]|-\d)`,
  'gu',
);

// A path with fewer leading directories than the diff's names a file only when one file ends with it.
export function createDiffPathResolver(paths: readonly string[]): DiffPathResolver {
  const known = new Set(paths);
  return (written) => {
    const path = written.replace(/^\.\//, '');
    if (known.has(path)) return path;
    const [only, ...others] = paths.filter((candidate) => candidate.endsWith(`/${path}`));
    return only !== undefined && others.length === 0 ? only : null;
  };
}

function findDiffLineLinks(text: string, resolve: DiffPathResolver): DiffLineLinkMatch[] {
  const found: DiffLineLinkMatch[] = [];
  for (const match of text.matchAll(PATH_LINE)) {
    const [whole, written, from, to] = match;
    if (written === undefined || from === undefined) continue;
    const file = resolve(written);
    const line = Number(from);
    const endLine = to === undefined ? line : Number(to);
    if (file === null || line < 1 || endLine < line) continue;
    found.push({
      start: match.index,
      end: match.index + whole.length,
      target: { file, line, endLine },
    });
  }
  return found;
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, string | number> };
}

const linkNode = ({ file, line, endLine }: DiffLineTarget, child: MarkdownNode): MarkdownNode => ({
  type: 'diffLineLink',
  data: {
    hName: 'button',
    hProperties: { dataFile: file, dataLine: line, dataEndLine: endLine },
  },
  children: [child],
});

function linkText(value: string, resolve: DiffPathResolver): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let last = 0;
  for (const { start, end, target } of findDiffLineLinks(value, resolve)) {
    if (start > last) nodes.push({ type: 'text', value: value.slice(last, start) });
    nodes.push(linkNode(target, { type: 'text', value: value.slice(start, end) }));
    last = end;
  }
  if (nodes.length === 0) return [{ type: 'text', value }];
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}

function linkInlineCode(node: MarkdownNode, resolve: DiffPathResolver): MarkdownNode {
  const written = (node.value ?? '').trim();
  const [only, ...others] = findDiffLineLinks(written, resolve);
  if (!only || others.length > 0 || only.start !== 0 || only.end !== written.length) return node;
  return linkNode(only.target, node);
}

// Text and inline code naming `path:line` or `path:start-end` of a diff file become links;
// code blocks and existing links stay as they are.
export function remarkDiffLineLinks({ resolve }: { resolve: DiffPathResolver }) {
  const linkChildren = (node: MarkdownNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value) return linkText(child.value, resolve);
      if (child.type === 'inlineCode') return [linkInlineCode(child, resolve)];
      linkChildren(child);
      return [child];
    });
  };
  return (tree: MarkdownNode) => {
    linkChildren(tree);
  };
}

const numberProperty = (value: unknown) =>
  typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;

export function diffLineTargetOf(
  properties: Record<string, unknown> | undefined,
): DiffLineTarget | null {
  const file = properties?.dataFile;
  const line = numberProperty(properties?.dataLine);
  const endLine = numberProperty(properties?.dataEndLine);
  if (typeof file !== 'string' || !Number.isInteger(line) || !Number.isInteger(endLine)) {
    return null;
  }
  return { file, line, endLine };
}

export function linesOf({ line, endLine }: DiffLineTarget, limit: number): number[] {
  const count = Math.min(endLine - line + 1, limit);
  return Array.from({ length: count }, (_, index) => line + index);
}
