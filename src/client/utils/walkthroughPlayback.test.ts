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
  {
    title: '중간에 실패',
    steps: [steps(4)[0]!, { ...steps(4)[1]!, error: true }, steps(4)[2]!, steps(4)[3]!],
  },
];

describe('playWalkthrough', () => {
  it('moves to the next and the previous step', () => {
    const start = { caseIndex: 0, stepIndex: 0, playing: false };

    const next = playWalkthrough(start, { type: 'next' }, cases);

    expect(next).toEqual({ caseIndex: 0, stepIndex: 1, playing: false });
    expect(playWalkthrough(next, { type: 'previous' }, cases)).toEqual(start);
  });

  it('stays on the first step going back and on the last step going on', () => {
    expect(
      playWalkthrough({ caseIndex: 0, stepIndex: 0, playing: false }, { type: 'previous' }, cases),
    ).toEqual({
      caseIndex: 0,
      stepIndex: 0,
      playing: false,
    });
    expect(
      playWalkthrough({ caseIndex: 1, stepIndex: 1, playing: false }, { type: 'next' }, cases),
    ).toEqual({
      caseIndex: 1,
      stepIndex: 1,
      playing: false,
    });
  });

  it('goes to the first step of the case it switches to', () => {
    expect(
      playWalkthrough(
        { caseIndex: 0, stepIndex: 2, playing: false },
        { type: 'selectCase', caseIndex: 1 },
        cases,
      ),
    ).toEqual({ caseIndex: 1, stepIndex: 0, playing: false });
  });

  it('keeps the step when the reviewer picks the case already shown', () => {
    const state = { caseIndex: 0, stepIndex: 2, playing: false };

    expect(playWalkthrough(state, { type: 'selectCase', caseIndex: 0 }, cases)).toBe(state);
  });

  it('ignores a case the walkthrough does not have', () => {
    const state = { caseIndex: 0, stepIndex: 1, playing: false };

    expect(playWalkthrough(state, { type: 'selectCase', caseIndex: cases.length }, cases)).toBe(
      state,
    );
  });

  describe('autoplay', () => {
    const playing = (caseIndex: number, stepIndex: number) => ({
      caseIndex,
      stepIndex,
      playing: true,
    });

    it('starts playing on play and advances one step on each tick', () => {
      const started = playWalkthrough(
        { caseIndex: 0, stepIndex: 0, playing: false },
        { type: 'play' },
        cases,
      );

      expect(started).toEqual(playing(0, 0));
      expect(playWalkthrough(started, { type: 'tick' }, cases)).toEqual(playing(0, 1));
    });

    it('stops on a second press of play', () => {
      expect(playWalkthrough(playing(0, 1), { type: 'play' }, cases)).toEqual({
        caseIndex: 0,
        stepIndex: 1,
        playing: false,
      });
    });

    it('stops when it reaches the last step', () => {
      expect(playWalkthrough(playing(0, 1), { type: 'tick' }, cases)).toEqual({
        caseIndex: 0,
        stepIndex: 2,
        playing: false,
      });
    });

    it('stops on a step that ends in an error', () => {
      expect(playWalkthrough(playing(2, 0), { type: 'tick' }, cases)).toEqual({
        caseIndex: 2,
        stepIndex: 1,
        playing: false,
      });
    });

    it('plays on past the error step it was started on', () => {
      const started = playWalkthrough(
        { caseIndex: 2, stepIndex: 1, playing: false },
        { type: 'play' },
        cases,
      );

      expect(playWalkthrough(started, { type: 'tick' }, cases)).toEqual(playing(2, 2));
    });

    it('does not start on the last step', () => {
      const state = { caseIndex: 0, stepIndex: 2, playing: false };

      expect(playWalkthrough(state, { type: 'play' }, cases)).toBe(state);
    });

    it('stops when the reviewer moves to the next or the previous step', () => {
      expect(playWalkthrough(playing(0, 1), { type: 'next' }, cases)).toEqual({
        caseIndex: 0,
        stepIndex: 2,
        playing: false,
      });
      expect(playWalkthrough(playing(0, 1), { type: 'previous' }, cases)).toEqual({
        caseIndex: 0,
        stepIndex: 0,
        playing: false,
      });
    });

    it('stops when the reviewer switches case', () => {
      expect(playWalkthrough(playing(0, 1), { type: 'selectCase', caseIndex: 1 }, cases)).toEqual({
        caseIndex: 1,
        stepIndex: 0,
        playing: false,
      });
    });

    it('ignores a tick that arrives after playback stopped', () => {
      const state = { caseIndex: 0, stepIndex: 0, playing: false };

      expect(playWalkthrough(state, { type: 'tick' }, cases)).toBe(state);
    });
  });
});
