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
