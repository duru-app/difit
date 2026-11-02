import type { ComponentType } from 'react';

import type {
  CommentThread,
  DiffFile,
  DiffSide,
  ExtraCommentLines,
  DiffViewMode,
  ExpandedRange,
  LineNumber,
  ReviewerReplyFields,
} from '../../types/diff';
import type { AppearanceSettings } from '../components/SettingsModal';
import type { CursorPosition } from '../hooks/keyboardNavigation';
import type { MergedChunk } from '../hooks/useExpandedLines';

export type DiffViewerBodyProps = {
  file: DiffFile;
  threads: CommentThread[];
  showAuthorBadges?: boolean;
  diffMode: DiffViewMode;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  baseCommitish?: string;
  targetCommitish?: string;
  cursor?: CursorPosition | null;
  fileIndex?: number;
  mergedChunks: MergedChunk[];
  foldCommentChanges?: boolean;
  isExpandLoading: boolean;
  openHiddenLines: (file: DiffFile, ranges: readonly ExpandedRange[]) => Promise<void>;
  onAddComment?: (
    line: LineNumber,
    body: string,
    codeContent?: string,
    side?: DiffSide,
    extra?: ExtraCommentLines,
  ) => Promise<void>;
  onResolveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string, fields?: ReviewerReplyFields) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  onOpenInEditor?: (filePath: string, lineNumber: number) => void;
  onLineClick?: (
    fileIndex: number,
    chunkIndex: number,
    lineIndex: number,
    side: 'left' | 'right',
  ) => void;
  commentTrigger?: { fileIndex: number; chunkIndex: number; lineIndex: number } | null;
  onCommentTriggerHandled?: () => void;
};

export type DiffViewerRegistration = {
  id: string;
  match: (file: DiffFile) => boolean;
  Component: ComponentType<DiffViewerBodyProps>;
  canExpandHiddenLines?: (file: DiffFile) => boolean;
};
