import type { DiffCommentMessage, FixupLines, ThreadFixup } from '../types/diff.js';

type FixupIdentity = Pick<ThreadFixup, 'sha' | 'patchId'>;

export function findFixup(
  { fixupSha, patchId }: Pick<FixupLines, 'fixupSha' | 'patchId'>,
  fixups: readonly FixupIdentity[],
): FixupIdentity | undefined {
  return (
    fixups.find(({ sha }) => sha === fixupSha) ??
    (patchId ? fixups.find((fixup) => fixup.patchId === patchId) : undefined)
  );
}

export function currentFixupSha(
  lines: Pick<FixupLines, 'fixupSha' | 'patchId'>,
  fixups: readonly FixupIdentity[],
): string {
  return findFixup(lines, fixups)?.sha ?? lines.fixupSha;
}

export function withCurrentFixupShas<T extends { messages: DiffCommentMessage[] }>(
  thread: T,
  fixups: readonly FixupIdentity[],
): T {
  if (fixups.length === 0 || thread.messages.every((message) => !message.fixupLines)) {
    return thread;
  }
  return {
    ...thread,
    messages: thread.messages.map((message) =>
      message.fixupLines
        ? {
            ...message,
            fixupLines: {
              ...message.fixupLines,
              fixupSha: currentFixupSha(message.fixupLines, fixups),
            },
          }
        : message,
    ),
  };
}
