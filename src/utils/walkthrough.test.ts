import { describe, expect, it } from 'vitest';

import { parseWalkthrough } from './walkthrough';

describe('parseWalkthrough', () => {
  it('keeps the fields the viewer plays and warns about the ones it does not know yet', () => {
    expect(
      parseWalkthrough({
        cases: [
          {
            title: '정상 흐름',
            setup: '로그인한 사용자',
            steps: [
              {
                file: './src/a.ts',
                line: 3,
                endLine: 5,
                description: '여기서 들어간다.',
                callPath: ['src/b.ts:10'],
              },
              { file: 'src/a.ts', line: 9, endLine: 9, description: '돌아온다.' },
            ],
          },
        ],
      }),
    ).toEqual({
      cases: [
        {
          title: '정상 흐름',
          steps: [
            { file: 'src/a.ts', line: 3, endLine: 5, description: '여기서 들어간다.' },
            { file: 'src/a.ts', line: 9, description: '돌아온다.' },
          ],
        },
      ],
      warnings: ['case: ignored unknown field "setup"', 'step 1: ignored unknown field "callPath"'],
    });
  });

  it.each([
    [{ cases: [{ steps: [] }] }, 'a case needs at least one step'],
    [{ cases: [{ steps: [{ line: 1, description: 'x' }] }] }, 'step 1 needs "file"'],
    [
      { cases: [{ steps: [{ file: 'a', line: 0, description: 'x' }] }] },
      'step 1 needs "line" as a line number from 1',
    ],
    [
      { cases: [{ steps: [{ file: 'a', line: 4, endLine: 2, description: 'x' }] }] },
      'step 1 "endLine" must be a line number not before "line"',
    ],
    [{ cases: [{ steps: [{ file: 'a', line: 1 }] }] }, 'step 1 needs "description"'],
    [[], 'expected a JSON object with "cases"'],
  ])('refuses %j', (value, reason) => {
    expect(() => parseWalkthrough(value)).toThrow(`Invalid walkthrough: ${reason}`);
  });
});
