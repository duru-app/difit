import { leftBranchesNotice, movedBranchesNotice } from '../utils/directEdit';

import { NoticeBar } from './NoticeBar';

interface MovedBranchesNoticeProps {
  branches: readonly string[];
  left?: readonly string[];
  onDismiss: () => void;
}

export function MovedBranchesNotice({ branches, left, onDismiss }: MovedBranchesNoticeProps) {
  if (branches.length === 0 && !left?.length) return null;
  return (
    <NoticeBar
      text={[
        branches.length > 0 ? movedBranchesNotice(branches) : '',
        left?.length ? leftBranchesNotice(left) : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDismiss={onDismiss}
    />
  );
}
