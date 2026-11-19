import { describe, expect, it } from 'vitest';

import type { Walkthrough } from '../types/diff';

import { cloneWalkthrough, parseWalkthrough } from './walkthrough';

describe('parseWalkthrough', () => {
  it('keeps the fields the viewer plays and warns about the ones it does not know yet', () => {
    expect(
      parseWalkthrough({
        cases: [
          {
            title: '정상 흐름',
            setup: '로그인한 사용자가 저장을 누른다.',
            owner: 'agent',
            steps: [
              {
                file: './src/a.ts',
                line: 3,
                endLine: 5,
                description: '여기서 들어간다.',
                note: 'later',
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
          setup: '로그인한 사용자가 저장을 누른다.',
          steps: [
            { file: 'src/a.ts', line: 3, endLine: 5, description: '여기서 들어간다.' },
            { file: 'src/a.ts', line: 9, description: '돌아온다.' },
          ],
        },
      ],
      warnings: ['case: ignored unknown field "owner"', 'step 1: ignored unknown field "note"'],
    });
  });

  it('keeps every case in order and names the case in the warnings when there are several', () => {
    expect(
      parseWalkthrough({
        cases: [
          { title: '정상 흐름', steps: [{ file: 'a.ts', line: 1, description: '저장한다.' }] },
          {
            setup: '디스크가 가득 찼다.',
            steps: [{ file: 'a.ts', line: 4, description: '실패한다.', vars: {} }],
          },
        ],
      }),
    ).toEqual({
      cases: [
        { title: '정상 흐름', steps: [{ file: 'a.ts', line: 1, description: '저장한다.' }] },
        {
          setup: '디스크가 가득 찼다.',
          steps: [{ file: 'a.ts', line: 4, description: '실패한다.' }],
        },
      ],
      warnings: ['case 2 step 1: ignored unknown field "vars"'],
    });
  });

  it('keeps the call path, variable values, state changes and error mark of a step', () => {
    expect(
      parseWalkthrough({
        cases: [
          {
            steps: [
              {
                file: 'src/a.ts',
                line: 3,
                description: '저장에 실패한다.',
                callPath: ['./src/main.ts:12', 'src/b.ts:40-42'],
                variables: { path: '"/tmp/x"', size: '0' },
                stateChanges: { 'cache.dirty': 'false → true' },
                error: true,
              },
              {
                file: 'src/a.ts',
                line: 9,
                description: '돌아온다.',
                callPath: [],
                variables: {},
                stateChanges: {},
                error: false,
              },
            ],
          },
        ],
      }),
    ).toEqual({
      cases: [
        {
          steps: [
            {
              file: 'src/a.ts',
              line: 3,
              description: '저장에 실패한다.',
              callPath: ['src/main.ts:12', 'src/b.ts:40-42'],
              variables: { path: '"/tmp/x"', size: '0' },
              stateChanges: { 'cache.dirty': 'false → true' },
              error: true,
            },
            { file: 'src/a.ts', line: 9, description: '돌아온다.' },
          ],
        },
      ],
      warnings: [],
    });
  });

  it('copies a stored walkthrough without sharing its call path or values', () => {
    const stored: Walkthrough = {
      commit: 'abc',
      cases: [
        {
          steps: [
            {
              file: 'a.ts',
              line: 1,
              description: 'x',
              callPath: ['b.ts:2'],
              variables: { n: '1' },
              stateChanges: { s: 'on' },
              error: true,
            },
          ],
        },
      ],
    };

    const copy = cloneWalkthrough(stored);
    copy.cases[0]?.steps[0]?.callPath?.push('c.ts:3');
    if (copy.cases[0]?.steps[0]?.variables) copy.cases[0].steps[0].variables.n = '2';

    expect(copy.cases[0]?.steps[0]?.error).toBe(true);
    expect(copy.cases[0]?.steps[0]?.stateChanges).toEqual({ s: 'on' });
    expect(stored.cases[0]?.steps[0]?.callPath).toEqual(['b.ts:2']);
    expect(stored.cases[0]?.steps[0]?.variables).toEqual({ n: '1' });
  });

  it.each([
    [
      { cases: [{ steps: [{ file: 'a', line: 1, description: 'x', callPath: 'b:1' }] }] },
      'step 1 "callPath" must be a list of "path:line" entries',
    ],
    [
      { cases: [{ steps: [{ file: 'a', line: 1, description: 'x', callPath: ['b.ts'] }] }] },
      'step 1 "callPath" entry "b.ts" must be "path:line" or "path:line-endLine"',
    ],
    [
      { cases: [{ steps: [{ file: 'a', line: 1, description: 'x', callPath: ['b.ts:5-2'] }] }] },
      'step 1 "callPath" entry "b.ts:5-2" must be "path:line" or "path:line-endLine"',
    ],
    [
      { cases: [{ steps: [{ file: 'a', line: 1, description: 'x', variables: { n: 1 } }] }] },
      'step 1 "variables" must map names to string values',
    ],
    [
      { cases: [{ steps: [{ file: 'a', line: 1, description: 'x', stateChanges: ['s'] }] }] },
      'step 1 "stateChanges" must map names to string values',
    ],
    [
      { cases: [{ steps: [{ file: 'a', line: 1, description: 'x', error: 'yes' }] }] },
      'step 1 "error" must be true or false',
    ],
    [
      { cases: [{ steps: [{ file: 'a', line: 1, description: 'x' }] }, { steps: [] }] },
      'case 2 needs at least one step',
    ],
    [
      { cases: [{ setup: 3, steps: [{ file: 'a', line: 1, description: 'x' }] }] },
      '"setup" must be a string',
    ],
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
