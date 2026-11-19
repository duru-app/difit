import { createContext, useContext, type ReactNode } from 'react';

// The lines of the current step and of its call path; the other steps are not drawn.
export interface WalkthroughLines {
  step: { file: string; lines: ReadonlySet<number>; error: boolean } | null;
  callPath: ReadonlyMap<string, ReadonlySet<number>>;
}

const WalkthroughStepContext = createContext<WalkthroughLines | null>(null);

export function WalkthroughStepProvider({
  value,
  children,
}: {
  value: WalkthroughLines | null;
  children: ReactNode;
}) {
  return (
    <WalkthroughStepContext.Provider value={value}>{children}</WalkthroughStepContext.Provider>
  );
}

export type WalkthroughRowAttributes =
  | { 'data-walkthrough-step': '' | 'error' }
  | { 'data-walkthrough-call': '' }
  | Record<string, never>;

const NO_MARK: WalkthroughRowAttributes = {};

export function useWalkthroughRowAttributes(
  file: string | undefined,
): (newLine: number | undefined) => WalkthroughRowAttributes {
  const lines = useContext(WalkthroughStepContext);
  return (newLine) => {
    if (lines === null || file === undefined || newLine === undefined) return NO_MARK;
    const { step, callPath } = lines;
    if (step && step.file === file && step.lines.has(newLine)) {
      return { 'data-walkthrough-step': step.error ? 'error' : '' };
    }
    return callPath.get(file)?.has(newLine) ? { 'data-walkthrough-call': '' } : NO_MARK;
  };
}

export type OpenWalkthrough = (threadId: string, messageId: string) => void;

const OpenWalkthroughContext = createContext<OpenWalkthrough | null>(null);

export function OpenWalkthroughProvider({
  value,
  children,
}: {
  value: OpenWalkthrough;
  children: ReactNode;
}) {
  return (
    <OpenWalkthroughContext.Provider value={value}>{children}</OpenWalkthroughContext.Provider>
  );
}

// Null outside a diff, where a reply's walkthrough has no lines to step through.
export function useOpenWalkthrough(): OpenWalkthrough | null {
  return useContext(OpenWalkthroughContext);
}
