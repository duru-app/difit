import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { ExternalLink, MessageSquare, Pencil } from 'lucide-react';
import React, { useState } from 'react';

import { CommentButton } from './CommentButton';
import { EditLineButton, lineEndPlacement } from './EditLineButton';
import { OpenInEditorButton } from './OpenInEditorButton';

interface LineActionsProps {
  canHover: boolean;
  onCommentMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onCommentClick?: () => void;
  onComment?: () => void;
  onEditLine?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenInEditor?: () => void;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function LineNumberActions({
  canHover,
  onCommentMouseDown,
  onCommentClick,
  onComment,
  onEditLine,
  onOpenInEditor,
}: LineActionsProps) {
  if (canHover)
    return onCommentMouseDown ? (
      <CommentButton onMouseDown={onCommentMouseDown} onClick={onCommentClick} />
    ) : null;
  if (!onComment && !onEditLine && !onOpenInEditor) return null;
  return (
    <LineActionMenu onComment={onComment} onEditLine={onEditLine} onOpenInEditor={onOpenInEditor} />
  );
}

export function LineEndActions({
  onEditLine,
  onOpenInEditor,
  placement = lineEndPlacement(false, 0),
}: Pick<LineActionsProps, 'onEditLine' | 'onOpenInEditor'> & { placement?: string }) {
  if (!onEditLine && !onOpenInEditor) return null;
  return (
    <div className={`absolute ${placement} z-10 flex gap-1`}>
      {onOpenInEditor && <OpenInEditorButton onClick={onOpenInEditor} />}
      {onEditLine && <EditLineButton onClick={onEditLine} />}
    </div>
  );
}

const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-github-text-primary hover:bg-github-bg-tertiary';

function LineActionMenu({
  onComment,
  onEditLine,
  onOpenInEditor,
}: Pick<LineActionsProps, 'onComment' | 'onEditLine' | 'onOpenInEditor'>) {
  const [isOpen, setIsOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);
  const hasMenu = Boolean(onEditLine || onOpenInEditor);

  const choose = (action: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    action();
  };

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded z-10"
        style={{
          backgroundColor: 'var(--color-yellow-btn-bg)',
          color: 'var(--color-yellow-btn-text)',
          border: '1px solid var(--color-yellow-btn-border)',
        }}
        {...getReferenceProps({
          onMouseDown: stop,
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            if (hasMenu) setIsOpen((open) => !open);
            else onComment?.();
          },
        })}
        aria-label={hasMenu ? '줄 메뉴' : 'Add a comment'}
        title={hasMenu ? '지적 달기 · 직접 고치기 · 에디터에서 열기' : 'Add a comment'}
      >
        <MessageSquare className="w-4 h-4" />
      </button>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-[60] min-w-40 rounded-md border border-github-border bg-github-bg-secondary p-1 shadow-lg"
            {...getFloatingProps({ onMouseDown: stop })}
          >
            {onComment && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_CLASS}
                onClick={choose(onComment)}
              >
                <MessageSquare className="w-4 h-4" />
                지적 달기
              </button>
            )}
            {onEditLine && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_CLASS}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOpen(false);
                  onEditLine(e);
                }}
              >
                <Pencil className="w-4 h-4" />
                직접 고치기
              </button>
            )}
            {onOpenInEditor && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_CLASS}
                onClick={choose(onOpenInEditor)}
              >
                <ExternalLink className="w-4 h-4" />
                에디터에서 열기
              </button>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
