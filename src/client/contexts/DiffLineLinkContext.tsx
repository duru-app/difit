import { createContext, useContext, type ReactNode } from 'react';

import type { DiffLineTarget, DiffPathResolver } from '../utils/diffLineLinks';

export interface DiffLineLinks {
  resolve: DiffPathResolver;
  // from is the link the reader pressed.
  open: (target: DiffLineTarget, from: HTMLElement) => void;
}

const DiffLineLinkContext = createContext<DiffLineLinks | null>(null);

export function DiffLineLinkProvider({
  value,
  children,
}: {
  value: DiffLineLinks;
  children: ReactNode;
}) {
  return <DiffLineLinkContext.Provider value={value}>{children}</DiffLineLinkContext.Provider>;
}

// Null outside a diff, where comment bodies link nothing.
export function useDiffLineLinks(): DiffLineLinks | null {
  return useContext(DiffLineLinkContext);
}
