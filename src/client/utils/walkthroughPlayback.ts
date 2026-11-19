import type { WalkthroughCase } from '../../types/diff';

export interface WalkthroughPlayback {
  caseIndex: number;
  stepIndex: number;
}

export type WalkthroughPlaybackAction =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'selectCase'; caseIndex: number };

export function playWalkthrough(
  state: WalkthroughPlayback,
  action: WalkthroughPlaybackAction,
  cases: readonly WalkthroughCase[],
): WalkthroughPlayback {
  const last = (cases[state.caseIndex]?.steps.length ?? 1) - 1;
  switch (action.type) {
    case 'next':
      return { ...state, stepIndex: Math.min(state.stepIndex + 1, last) };
    case 'previous':
      return { ...state, stepIndex: Math.max(state.stepIndex - 1, 0) };
    case 'selectCase':
      if (action.caseIndex === state.caseIndex || !cases[action.caseIndex]) return state;
      return { caseIndex: action.caseIndex, stepIndex: 0 };
  }
}
