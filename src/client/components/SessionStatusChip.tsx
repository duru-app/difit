import { useEffect, useState } from 'react';

import type { SessionStatus } from '../../types/watch';
import { isSessionConnected, sessionCheckedAgoMs } from '../../utils/sessionStatus';

interface SessionStatusChipProps {
  status: SessionStatus;
  // Date.now() when the status arrived; checkedAgoMs counts from then.
  receivedAt: number;
}

export function SessionStatusChip({ status, receivedAt }: SessionStatusChipProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status, receivedAt]);

  const elapsed = Math.max(0, now - receivedAt);
  const connected = isSessionConnected(status, elapsed);
  const ago = sessionCheckedAgoMs(status, elapsed);
  const label = connected ? '세션 연결됨' : '세션 끊김';
  const detail =
    connected && ago !== null
      ? `세션 연결됨 · 마지막 확인 ${Math.floor(ago / 1000)}초 전`
      : '세션 끊김 · 지금 남긴 지적은 아직 아무 세션도 받지 않음';

  return (
    <span
      role="status"
      data-testid="session-status"
      data-connected={connected ? 'true' : 'false'}
      title={detail}
      aria-label={detail}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs ${
        connected
          ? 'border-github-accent text-github-text-primary'
          : 'border-github-danger text-github-danger'
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${connected ? 'bg-github-accent' : 'bg-github-danger'}`}
      />
      {label}
    </span>
  );
}
