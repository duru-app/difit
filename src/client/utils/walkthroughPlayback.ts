import type { WalkthroughCase } from '../../types/diff';

export interface WalkthroughPlayback {
  caseIndex: number;
  stepIndex: number;
  playing: boolean;
}

export type WalkthroughPlaybackAction =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'selectCase'; caseIndex: number }
  | { type: 'play' }
  | { type: 'tick' };

export function playWalkthrough(
  state: WalkthroughPlayback,
  action: WalkthroughPlaybackAction,
  cases: readonly WalkthroughCase[],
): WalkthroughPlayback {
  const steps = cases[state.caseIndex]?.steps ?? [];
  const last = Math.max(steps.length - 1, 0);
  switch (action.type) {
    case 'next':
      return { ...state, stepIndex: Math.min(state.stepIndex + 1, last), playing: false };
    case 'previous':
      return { ...state, stepIndex: Math.max(state.stepIndex - 1, 0), playing: false };
    case 'selectCase':
      if (action.caseIndex === state.caseIndex || !cases[action.caseIndex]) return state;
      return { caseIndex: action.caseIndex, stepIndex: 0, playing: false };
    case 'play':
      if (state.playing) return { ...state, playing: false };
      if (state.stepIndex >= last) return state;
      return { ...state, playing: true };
    case 'tick': {
      if (!state.playing) return state;
      const stepIndex = Math.min(state.stepIndex + 1, last);
      const stops = stepIndex === last || steps[stepIndex]?.error === true;
      return { ...state, stepIndex, playing: !stops };
    }
  }
}
