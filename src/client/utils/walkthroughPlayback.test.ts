import { describe, expect, it } from 'vitest';

import type { WalkthroughCase } from '../../types/diff';

import { playWalkthrough } from './walkthroughPlayback';

const steps = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    file: 'a.ts',
    line: index + 1,
    description: `단계 ${index + 1}`,
  }));
const cases: WalkthroughCase[] = [
  { title: '정상 흐름', steps: steps(3) },
  { title: '오류 흐름', steps: steps(2) },
];

describe('playWalkthrough', () => {
  it('moves to the next and the previous step', () => {
    const start = { caseIndex: 0, stepIndex: 0 };

    const next = playWalkthrough(start, { type: 'next' }, cases);

    expect(next).toEqual({ caseIndex: 0, stepIndex: 1 });
    expect(playWalkthrough(next, { type: 'previous' }, cases)).toEqual(start);
  });

  it('stays on the first step going back and on the last step going on', () => {
    expect(playWalkthrough({ caseIndex: 0, stepIndex: 0 }, { type: 'previous' }, cases)).toEqual({
      caseIndex: 0,
      stepIndex: 0,
    });
    expect(playWalkthrough({ caseIndex: 1, stepIndex: 1 }, { type: 'next' }, cases)).toEqual({
      caseIndex: 1,
      stepIndex: 1,
    });
  });

  it('goes to the first step of the case it switches to', () => {
    expect(
      playWalkthrough({ caseIndex: 0, stepIndex: 2 }, { type: 'selectCase', caseIndex: 1 }, cases),
    ).toEqual({ caseIndex: 1, stepIndex: 0 });
  });

  it('keeps the step when the reviewer picks the case already shown', () => {
    const state = { caseIndex: 0, stepIndex: 2 };

    expect(playWalkthrough(state, { type: 'selectCase', caseIndex: 0 }, cases)).toBe(state);
  });

  it('ignores a case the walkthrough does not have', () => {
    const state = { caseIndex: 0, stepIndex: 1 };

    expect(playWalkthrough(state, { type: 'selectCase', caseIndex: 2 }, cases)).toBe(state);
  });
});
