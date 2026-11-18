import { structuredPatch } from 'diff';
import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'web-tree-sitter';

import type { DiffChunk } from '../types/diff.js';

import { classifyChunks, MAX_CLASSIFIED_RUNS_PER_FILE } from './change-kind.js';

function chunksOf(oldText: string, newText: string, context = 3): DiffChunk[] {
  const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context });
  return patch.hunks.map((hunk) => ({
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines
      .filter((line) => !line.startsWith('\\'))
      .map((line) => ({
        type: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : 'normal',
        content: line.slice(1),
      })),
  }));
}

async function kindsOf(path: string, oldText: string, newText: string, context?: number) {
  return classifyChunks(path, oldText, newText, chunksOf(oldText, newText, context));
}

async function kindOf(path: string, oldText: string, newText: string) {
  const kinds = await kindsOf(path, oldText, newText);
  expect(kinds).toHaveLength(1);
  return kinds?.[0];
}

describe('classifyChunks', () => {
  describe('while other requests wait', () => {
    it('lets the server answer between the parses of one file', async () => {
      let turns = 0;
      let waiting = true;
      const countTurns = () => {
        turns += 1;
        if (waiting) setImmediate(countTurns);
      };
      setImmediate(countTurns);
      const turnsAtEachParse: number[] = [];
      const parse = Parser.prototype.parse;
      const spy = vi.spyOn(Parser.prototype, 'parse').mockImplementation(function (
        this: Parser,
        ...args: Parameters<Parser['parse']>
      ) {
        turnsAtEachParse.push(turns);
        return parse.apply(this, args);
      });

      await kindsOf(
        'turns.ts',
        'a(); // old\nb(); // old\nc();\n',
        'a(); // new\nb(); // old\nd();\n',
        0,
      );
      waiting = false;
      spy.mockRestore();

      expect(turnsAtEachParse.length).toBeGreaterThan(3);
      for (const [index, atParse] of turnsAtEachParse.entries()) {
        if (index > 0) expect(atParse).toBeGreaterThan(turnsAtEachParse[index - 1]!);
      }
    });

    it('keeps files in different languages apart when they arrive together', async () => {
      const results = await Promise.all([
        kindOf('apart.ts', 'f(); // old\n', 'f(); // new\n'),
        kindOf('apart.py', 'f()  # old\n', 'f()  # new\n'),
        kindOf('apart.go', 'package a // old\n', 'package b // old\n'),
        kindOf('apart.js', 'g(); // old\n', 'h(); // old\n'),
      ]);

      expect(results).toEqual(['comment', 'comment', 'code', 'code']);
    });

    it('does not parse content it has already judged', async () => {
      const oldText = 'first(); // old\n';
      const newText = 'first(); // new\n';
      expect(await kindOf('remembered.ts', oldText, newText)).toBe('comment');
      const parse = vi.spyOn(Parser.prototype, 'parse');

      expect(await kindOf('remembered-again.ts', oldText, newText)).toBe('comment');
      expect(parse).not.toHaveBeenCalled();

      expect(await kindOf('remembered.ts', oldText, 'second(); // new\n')).toBe('code');
      expect(parse).toHaveBeenCalled();
      parse.mockRestore();
    });
  });

  describe('TypeScript', () => {
    it('sees a changed line comment as a comment change', async () => {
      expect(await kindOf('a.ts', 'const a = 1; // old\n', 'const a = 1; // new\n')).toBe(
        'comment',
      );
    });

    it('sees a changed block comment as a comment change', async () => {
      expect(
        await kindOf(
          'a.ts',
          '/**\n * Old.\n */\nexport const a = 1;\n',
          '/**\n * New.\n */\nexport const a = 1;\n',
        ),
      ).toBe('comment');
    });

    it('sees an added comment line as a comment change', async () => {
      expect(await kindOf('a.ts', 'f();\ng();\n', 'f();\n// why g runs\ng();\n')).toBe('comment');
    });

    it('sees reformatting as a whitespace change', async () => {
      expect(await kindOf('a.ts', 'if(a){b()}\n', 'if (a) {\n  b();\n}\n')).toBe('code');
      expect(await kindOf('a.ts', 'if(a){b();}\n', 'if (a) {\n  b();\n}\n')).toBe('whitespace');
    });

    it('sees // inside a string as code', async () => {
      expect(await kindOf('a.ts', 'const u = "http://a";\n', 'const u = "http://b";\n')).toBe(
        'code',
      );
    });

    it('sees a template literal line that looks like a comment as code', async () => {
      expect(
        await kindOf(
          'a.ts',
          'const q = `\nSELECT 1\n// keep\n`;\n',
          'const q = `\nSELECT 1\n// drop\n`;\n',
        ),
      ).toBe('code');
    });

    it('sees whitespace inside a template literal as code', async () => {
      expect(await kindOf('a.ts', 'const q = `\n  a\n`;\n', 'const q = `\n    a\n`;\n')).toBe(
        'code',
      );
    });

    it('sees a line that changes both a comment and code as code', async () => {
      expect(await kindOf('a.ts', 'const a = 1; // one\n', 'const a = 2; // two\n')).toBe('code');
    });

    it('sees code turned into a comment as code', async () => {
      expect(await kindOf('a.ts', 'f();\ng();\n', 'f();\n// g();\n')).toBe('code');
    });

    it('sees a removed @ts-expect-error as code', async () => {
      expect(await kindOf('a.ts', '// @ts-expect-error\nf(x);\n', 'f(x);\n')).toBe('code');
    });

    it('sees a changed eslint-disable comment as code', async () => {
      expect(
        await kindOf(
          'a.ts',
          'f(); // eslint-disable-line no-console\n',
          'f(); // eslint-disable-line\n',
        ),
      ).toBe('code');
    });

    it('sees a changed triple-slash reference as code', async () => {
      expect(
        await kindOf(
          'a.ts',
          '/// <reference path="a.d.ts" />\nf();\n',
          '/// <reference path="b.d.ts" />\nf();\n',
        ),
      ).toBe('code');
    });

    it('sees a removed pure annotation as code', async () => {
      expect(await kindOf('a.ts', 'const a = /*#__PURE__*/ f();\n', 'const a = f();\n')).toBe(
        'code',
      );
    });

    it('sees a changed test environment comment as code', async () => {
      // Split so that vitest does not read the pragma as one for this file.
      const pragma = '@vitest-' + 'environment';
      expect(
        await kindOf('a.test.ts', `// ${pragma} node\nf();\n`, `// ${pragma} happy-dom\nf();\n`),
      ).toBe('code');
    });

    it('reads comments with non-ASCII text', async () => {
      expect(
        await kindOf('a.ts', '// 한글 주석\nconst a = "é";\n', '// 바뀐 주석\nconst a = "é";\n'),
      ).toBe('comment');
      expect(await kindOf('a.ts', '// 한글\nconst a = "é";\n', '// 한글\nconst a = "è";\n')).toBe(
        'code',
      );
    });

    it('answers unknown when either side does not parse', async () => {
      expect(await kindOf('a.ts', 'const a = (;\n// old\n', 'const a = (;\n// new\n')).toBe(
        'unknown',
      );
    });

    it('classifies every chunk of a file on its own', async () => {
      const filler = Array.from({ length: 12 }, (_, index) => `f${index}();`).join('\n');
      const oldText = `// top old\n${filler}\nconst last = 1;\n`;
      const newText = `// top new\n${filler}\nconst last = 2;\n`;
      expect(await kindsOf('a.ts', oldText, newText)).toEqual(['comment', 'code']);
    });

    it('puts a chunk with a comment run and a code run under code', async () => {
      expect(await kindsOf('a.ts', '// a\nf();\ng();\n', '// b\nf();\nh();\n')).toEqual(['code']);
    });

    it('gives up on files with too many changed runs', async () => {
      const lines = Array.from(
        { length: MAX_CLASSIFIED_RUNS_PER_FILE + 1 },
        (_, i) => `f(${i}); // a`,
      );
      const kinds = await kindsOf(
        'a.ts',
        `${lines.join('\nx();\n')}\n`,
        `${lines.map((line) => line.replace('// a', '// b')).join('\nx();\n')}\n`,
        0,
      );
      expect(new Set(kinds)).toEqual(new Set(['unknown']));
    });
  });

  describe('TSX', () => {
    it('sees // in JSX text as code', async () => {
      expect(
        await kindOf('a.tsx', 'const e = <p>// old</p>;\n', 'const e = <p>// new</p>;\n'),
      ).toBe('code');
    });

    it('sees a JSX comment as a comment change', async () => {
      expect(
        await kindOf(
          'a.tsx',
          'const e = <p>{/* old */}hi</p>;\n',
          'const e = <p>{/* new */}hi</p>;\n',
        ),
      ).toBe('comment');
    });
  });

  describe('JavaScript', () => {
    it('sees a comment change as a comment change', async () => {
      expect(await kindOf('a.js', 'f(); /* old */\n', 'f(); /* new */\n')).toBe('comment');
    });

    it('sees a regex holding // as code', async () => {
      expect(await kindOf('a.js', 'const r = /a\\/\\/b/;\n', 'const r = /a\\/\\/c/;\n')).toBe(
        'code',
      );
    });
  });

  describe('Python', () => {
    it('sees a comment change as a comment change', async () => {
      expect(await kindOf('a.py', 'x = 1  # old\n', 'x = 1  # new\n')).toBe('comment');
    });

    it('sees # inside a string as code', async () => {
      expect(await kindOf('a.py', 's = "a#old"\n', 's = "a#new"\n')).toBe('code');
    });

    it('sees # inside an f-string as code', async () => {
      expect(await kindOf('a.py', 's = f"{d["#"]} x"\n', 's = f"{d["#"]} z"\n')).toBe('code');
    });

    it('sees a docstring change as code', async () => {
      expect(
        await kindOf(
          'a.py',
          'def f():\n    """Old."""\n    return 1\n',
          'def f():\n    """New."""\n    return 1\n',
        ),
      ).toBe('code');
    });

    it('sees a dedent as code', async () => {
      expect(await kindOf('a.py', 'if a:\n    b()\n    c()\n', 'if a:\n    b()\nc()\n')).toBe(
        'code',
      );
    });

    it('sees a removed type: ignore as code', async () => {
      expect(await kindOf('a.py', 'x = f()  # type: ignore\n', 'x = f()\n')).toBe('code');
    });
  });

  describe('Go', () => {
    it('sees a comment change as a comment change', async () => {
      expect(
        await kindOf(
          'a.go',
          'package a\n\n// Old.\nfunc F() {}\n',
          'package a\n\n// New.\nfunc F() {}\n',
        ),
      ).toBe('comment');
    });

    it('sees // inside a raw string as code', async () => {
      expect(
        await kindOf('a.go', 'package a\n\nvar s = `// a`\n', 'package a\n\nvar s = `// b`\n'),
      ).toBe('code');
    });

    it('sees a changed go:build line as code', async () => {
      expect(
        await kindOf('a.go', '//go:build linux\n\npackage a\n', '//go:build darwin\n\npackage a\n'),
      ).toBe('code');
    });
  });

  describe('Rust', () => {
    it('sees a nested block comment change as a comment change', async () => {
      expect(
        await kindOf(
          'a.rs',
          '/* a /* b */ old */\nfn f() {}\n',
          '/* a /* b */ new */\nfn f() {}\n',
        ),
      ).toBe('comment');
    });

    it('sees // inside a string as code', async () => {
      expect(await kindOf('a.rs', 'const S: &str = "// a";\n', 'const S: &str = "// b";\n')).toBe(
        'code',
      );
    });
  });

  describe('Java', () => {
    it('sees a comment change as a comment change', async () => {
      expect(await kindOf('A.java', 'class A {\n  // old\n}\n', 'class A {\n  // new\n}\n')).toBe(
        'comment',
      );
    });

    it('sees // inside a text block as code', async () => {
      expect(
        await kindOf(
          'A.java',
          'class A {\n  String s = """\n    // a\n    """;\n}\n',
          'class A {\n  String s = """\n    // b\n    """;\n}\n',
        ),
      ).toBe('code');
    });
  });

  describe('CSS', () => {
    it('sees a comment change as a comment change', async () => {
      expect(
        await kindOf('a.css', 'a { color: red; /* old */ }\n', 'a { color: red; /* new */ }\n'),
      ).toBe('comment');
    });

    it('sees /* inside a string as code', async () => {
      expect(
        await kindOf(
          'a.css',
          'a::after { content: "/* a */"; }\n',
          'a::after { content: "/* b */"; }\n',
        ),
      ).toBe('code');
    });

    it('sees a descendant selector change as code', async () => {
      expect(await kindOf('a.css', 'a b { color: red; }\n', 'ab { color: red; }\n')).toBe('code');
    });
  });

  describe('Bash', () => {
    it('sees a trailing comment change as a comment change', async () => {
      expect(await kindOf('a.sh', 'ls # old\n', 'ls # new\n')).toBe('comment');
    });

    it('sees # inside a word as code', async () => {
      expect(await kindOf('a.sh', 'echo a#b\n', 'echo a#c\n')).toBe('code');
    });

    it('sees # inside a heredoc as code', async () => {
      expect(await kindOf('a.sh', 'cat <<EOF\n# old\nEOF\n', 'cat <<EOF\n# new\nEOF\n')).toBe(
        'code',
      );
    });

    it('sees a shebang change as code', async () => {
      expect(await kindOf('a.sh', '#!/bin/sh\nls\n', '#!/bin/bash\nls\n')).toBe('code');
    });
  });

  it('returns null for a language it does not parse', async () => {
    expect(await kindsOf('a.rb', 'x = 1 # old\n', 'x = 1 # new\n')).toBeNull();
  });

  it('answers unknown when the chunks do not match the files', async () => {
    const chunks = chunksOf('a();\n', 'b();\n');
    expect(await classifyChunks('a.ts', 'c();\n', 'b();\n', chunks)).toEqual(['unknown']);
  });
});
