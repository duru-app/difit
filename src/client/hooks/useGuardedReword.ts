import { useMemo, useState } from 'react';

import type { RewordControls } from '../components/CommitMessageForm';

export function useGuardedReword(reword: RewordControls | undefined) {
  const [isSaving, setIsSaving] = useState(false);
  const [movedBranches, setMovedBranches] = useState<string[]>([]);
  const guarded = useMemo<RewordControls | undefined>(
    () =>
      reword && {
        ...reword,
        save: async (request) => {
          setIsSaving(true);
          setMovedBranches([]);
          try {
            const result = await reword.save(request);
            if ('saved' in result) setMovedBranches(result.movedBranches);
            return result;
          } finally {
            setIsSaving(false);
          }
        },
      },
    [reword],
  );
  return {
    reword: guarded,
    isSaving,
    movedBranches,
    dismissMovedBranches: () => setMovedBranches([]),
  };
}
