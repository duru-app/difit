import { LEFT_BRANCHES_REASON, leftBranchesNotice, movedBranchesNotice } from '../utils/directEdit';

import { NoticeBar } from './NoticeBar';

interface MovedBranchesNoticeProps {
  branches: readonly string[];
  left?: readonly string[];
  onDismiss: () => void;
}

export function MovedBranchesNotice({ branches, left, onDismiss }: MovedBranchesNoticeProps) {
  if (branches.length === 0 && !left?.length) return null;
  return (
    <NoticeBar onDismiss={onDismiss}>
      {branches.length > 0 && <span className="block">{movedBranchesNotice(branches)}</span>}
      {left?.length ? (
        <span className="block" title={LEFT_BRANCHES_REASON}>
          {leftBranchesNotice(left)}
        </span>
      ) : null}
    </NoticeBar>
  );
}
