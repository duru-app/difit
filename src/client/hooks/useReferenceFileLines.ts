import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchBlobText } from '../utils/fileTokens';

// Each file is read once while `gitRef` stays; a file absent from the result is still loading,
// and `null` means it could not be read. `gitRef` undefined forgets every file.
export function useReferenceFileLines(
  files: readonly string[],
  gitRef: string | undefined,
): ReadonlyMap<string, string[] | null> {
  const [read, setRead] = useState<{ gitRef: string; lines: Map<string, string[] | null> }>();
  const requested = useRef<{ gitRef: string; files: Set<string> } | undefined>(undefined);
  const filesKey = files.join('\n');

  useEffect(() => {
    if (gitRef === undefined) {
      requested.current = undefined;
      setRead(undefined);
      return;
    }
    if (requested.current?.gitRef !== gitRef) {
      requested.current = { gitRef, files: new Set() };
    }
    const asked = requested.current;
    for (const file of filesKey === '' ? [] : filesKey.split('\n')) {
      if (asked.files.has(file)) continue;
      asked.files.add(file);
      void fetchBlobText(file, gitRef).then((text) => {
        if (requested.current !== asked) return;
        const lines = text === null ? null : text.replace(/\r\n/g, '\n').split('\n');
        if (lines?.at(-1) === '') lines.pop();
        setRead((previous) => ({
          gitRef,
          lines: new Map(previous?.gitRef === gitRef ? previous.lines : []).set(file, lines),
        }));
      });
    }
  }, [filesKey, gitRef]);

  return useMemo(
    () => (read && read.gitRef === gitRef ? read.lines : new Map<string, string[] | null>()),
    [read, gitRef],
  );
}
