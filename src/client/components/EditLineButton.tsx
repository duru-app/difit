import { Pencil } from 'lucide-react';
import React from 'react';

interface EditLineButtonProps {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export const EditLineButton: React.FC<EditLineButtonProps> = React.memo(({ onClick }) => {
  return (
    <button
      type="button"
      className="w-7 h-7 flex items-center justify-center select-none rounded border border-github-accent bg-github-bg-secondary text-github-accent transition-all duration-150 hover:scale-110 z-10"
      data-edit-line-button="true"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      title="직접 고치기"
      aria-label="줄 직접 고치기"
    >
      <Pencil className="w-4 h-4" />
    </button>
  );
});

EditLineButton.displayName = 'EditLineButton';

const AT_ROW_END = 'right-1.5 top-1/2 -translate-y-1/2';
const HUNK_BUTTON_HEIGHT =
  '[&>[data-edit-line-button]]:h-[calc(1.25rem+2px)] [&>[data-open-in-editor-button]]:h-[calc(1.25rem+2px)]';

export const lineEndPlacement = (hasHunkButton: boolean, rowIndex: number) => {
  if (!hasHunkButton) return AT_ROW_END;
  if (rowIndex >= 2) return `${AT_ROW_END} ${HUNK_BUTTON_HEIGHT}`;
  return `right-[7.625rem] ${HUNK_BUTTON_HEIGHT} ${rowIndex === 0 ? 'top-1' : 'top-1/2 -translate-y-1/2'}`;
};

export function EditHunkButton({
  onClick,
  alwaysShown = false,
}: {
  onClick: () => void;
  alwaysShown?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${alwaysShown ? '' : 'invisible group-focus-within/hunk:visible group-hover/hunk:visible'} absolute right-2 top-1 z-[5] flex w-[6.875rem] select-none items-center justify-center gap-1 whitespace-nowrap rounded border border-github-accent bg-github-bg-secondary px-1 py-0.5 text-xs text-github-text-primary`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Pencil className="w-3 h-3" />
      hunk 고치기
    </button>
  );
}
