import React from 'react';

import { type DiffLine, type ExpandedLine } from '../../types/diff';
import { codeCellAttributes } from '../utils/codeSelection';
import { type DiffSegment } from '../utils/wordLevelDiff';

import { DiffCodeLine } from './DiffCodeLine';
import { LineEndActions, LineNumberActions } from './LineActions';
import type { AppearanceSettings } from './SettingsModal';

interface DiffLineRowProps {
  line: DiffLine | ExpandedLine;
  index: number;
  lineId?: string;
  isCurrentLine?: boolean;
  hoveredLineIndex: number | null;
  selectedLineStyle: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onMouseMove: () => void;
  onCommentButtonMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onCommentButtonClick?: () => void;
  onComment?: () => void;
  onLineNumberMouseDown: (e: React.MouseEvent<HTMLTableCellElement>) => void;
  canHover: boolean;
  onOpenInEditor?: () => void;
  onEditLine?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  lineEndActionsPlacement?: string;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  onClick?: (e: React.MouseEvent<HTMLTableRowElement>) => void;
  filename?: string;
  oldFilename?: string;
  diffSegments?: DiffSegment[];
}

const getLineClass = (line: DiffLine | ExpandedLine) => {
  // Expanded lines have a subtle different background
  if ('isExpanded' in line && line.isExpanded) {
    return 'bg-github-bg-tertiary/80';
  }
  switch (line.type) {
    case 'add':
      return 'bg-diff-addition-bg';
    case 'delete':
      return 'bg-diff-deletion-bg';
    default:
      return 'bg-transparent';
  }
};

export const DiffLineRow: React.FC<DiffLineRowProps> = React.memo(
  ({
    line,
    index,
    lineId,
    isCurrentLine = false,
    hoveredLineIndex,
    selectedLineStyle,
    onMouseEnter,
    onMouseLeave,
    onMouseMove,
    onCommentButtonMouseDown,
    onCommentButtonClick,
    onComment,
    onLineNumberMouseDown,
    canHover,
    onOpenInEditor,
    onEditLine,
    lineEndActionsPlacement,
    syntaxTheme,
    onClick,
    filename,
    oldFilename,
    diffSegments,
  }) => {
    const lineNumber = line.newLineNumber || line.oldLineNumber;
    const showLineActions = hoveredLineIndex === index && lineNumber;
    const side = line.type === 'delete' ? 'old' : 'new';
    const sideLineNumber = side === 'old' ? line.oldLineNumber : line.newLineNumber;

    const highlightClass = isCurrentLine ? 'keyboard-cursor' : '';

    return (
      <tr
        id={lineId}
        data-diff-line-row="true"
        className={`group ${getLineClass(line)} relative ${selectedLineStyle} ${highlightClass} cursor-pointer`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onMouseMove={onMouseMove}
        onClick={onClick}
      >
        <td
          className="w-[var(--line-number-width)] min-w-[var(--line-number-width)] max-w-[var(--line-number-width)] px-2 max-md:px-0.5 max-md:text-[11px] text-right text-github-text-muted bg-github-bg-secondary border-r border-github-border select-none align-top relative"
          onMouseDown={onLineNumberMouseDown}
          data-line-number-cell
        >
          {line.oldLineNumber || ''}
        </td>
        <td
          className="w-[var(--line-number-width)] min-w-[var(--line-number-width)] max-w-[var(--line-number-width)] px-2 max-md:px-0.5 max-md:text-[11px] text-right text-github-text-muted bg-github-bg-secondary border-r border-github-border select-none align-top relative overflow-visible"
          onMouseDown={onLineNumberMouseDown}
          data-line-number-cell
        >
          <span>{line.newLineNumber || ''}</span>
          {showLineActions && (
            <LineNumberActions
              canHover={canHover}
              onCommentMouseDown={onCommentButtonMouseDown}
              onCommentClick={onCommentButtonClick}
              onComment={onComment}
              onEditLine={onEditLine}
              onOpenInEditor={onOpenInEditor}
            />
          )}
        </td>
        <td
          className="p-0 w-full relative align-top"
          data-symbol-side={side}
          data-symbol-path={side === 'old' ? (oldFilename ?? filename) : filename}
          data-symbol-line={sideLineNumber}
          {...codeCellAttributes(side, sideLineNumber)}
        >
          <DiffCodeLine
            line={line}
            syntaxTheme={syntaxTheme}
            filename={filename}
            diffSegments={diffSegments}
          />
          {showLineActions && canHover && (
            <LineEndActions
              onEditLine={onEditLine}
              onOpenInEditor={onOpenInEditor}
              placement={lineEndActionsPlacement}
            />
          )}
        </td>
      </tr>
    );
  },
);

DiffLineRow.displayName = 'DiffLineRow';
