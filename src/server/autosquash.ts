import { AUTOSQUASH_PREFIX } from '../types/diff.js';

// Orders commits the way `git rebase --autosquash` does: a fixup, squash or amend names its target
// by exact subject, then by commit id, then by subject prefix, and moves behind it.

export interface TodoCommit {
  sha: string;
  subject: string;
}

export function squashTarget(commits: TodoCommit[], index: number): TodoCommit | undefined {
  const subject = commits[index]?.subject ?? '';
  if (!AUTOSQUASH_PREFIX.test(subject)) return undefined;
  const earlier = commits.slice(0, index);
  let named = subject;
  while (AUTOSQUASH_PREFIX.test(named)) named = named.replace(AUTOSQUASH_PREFIX, '');
  return (
    earlier.find((commit) => commit.subject === named) ??
    (/^[0-9a-f]{4,64}$/.test(named)
      ? earlier.find((commit) => commit.sha.startsWith(named))
      : undefined) ??
    earlier.find((commit) => commit.subject.startsWith(named))
  );
}

export function autosquashGroups(commits: TodoCommit[]): TodoCommit[][] {
  const groupOf = new Map<string, TodoCommit[]>();
  const groups: TodoCommit[][] = [];
  commits.forEach((commit, index) => {
    const target = squashTarget(commits, index);
    let group = target && groupOf.get(target.sha);
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(commit);
    groupOf.set(commit.sha, group);
  });
  return groups;
}
