import { useEffect, useState } from 'react';

import { copyTextToClipboard } from '../utils/clipboard';

const COPIED_MS = 2000;
const COPIED_SHA_LENGTH = 10;

export function useCopyCommitHash() {
  const [copied, setCopied] = useState<{ sha: string } | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyHash = async (sha: string) => {
    try {
      await copyTextToClipboard(sha.slice(0, COPIED_SHA_LENGTH));
      setCopied({ sha });
    } catch (error) {
      console.error('Failed to copy commit hash:', error);
    }
  };
  return { copiedSha: copied?.sha ?? null, copyHash };
}
