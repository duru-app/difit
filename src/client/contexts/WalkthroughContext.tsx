import { createContext, useContext, type ReactNode } from 'react';

export interface WalkthroughStepLines {
  file: string;
  lines: ReadonlySet<number>;
}

const WalkthroughStepContext = createContext<WalkthroughStepLines | null>(null);

export function WalkthroughStepProvider({
  value,
  children,
}: {
  value: WalkthroughStepLines | null;
  children: ReactNode;
}) {
  return (
    <WalkthroughStepContext.Provider value={value}>{children}</WalkthroughStepContext.Provider>
  );
}

export function useIsWalkthroughStepLine(
  file: string | undefined,
): (newLine: number | undefined) => boolean {
  const step = useContext(WalkthroughStepContext);
  return (newLine) =>
    step !== null && file === step.file && newLine !== undefined && step.lines.has(newLine);
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
