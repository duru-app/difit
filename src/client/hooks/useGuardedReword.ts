import { useMemo, useState } from 'react';

import type { RewordControls } from '../components/CommitMessageForm';

export function useGuardedReword(reword: RewordControls | undefined) {
  const [isSaving, setIsSaving] = useState(false);
  const guarded = useMemo<RewordControls | undefined>(
    () =>
      reword && {
        load: reword.load,
        save: async (request) => {
          setIsSaving(true);
          try {
            return await reword.save(request);
          } finally {
            setIsSaving(false);
          }
        },
      },
    [reword],
  );
  return { reword: guarded, isSaving };
}
