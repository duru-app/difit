import type {
  DiffLine,
  DirectEditRejection,
  ExpandedLine,
  LineNumber,
  RewordRejection,
  RewriteWarning,
} from '../../types/diff';

export interface EditRange {
  start: number;
  end: number;
}

export function newSideLineNumbers(lines: ReadonlyArray<DiffLine | ExpandedLine>): Set<number> {
  const numbers = new Set<number>();
  for (const line of lines) {
    if (line.type !== 'delete' && line.newLineNumber !== undefined) {
      numbers.add(line.newLineNumber);
    }
  }
  return numbers;
}

export function rangeShown(lineNumbers: ReadonlySet<number>, range: EditRange): boolean {
  for (let lineNumber = range.start; lineNumber <= range.end; lineNumber++) {
    if (!lineNumbers.has(lineNumber)) return false;
  }
  return true;
}

export function hunkRange(lineNumbers: ReadonlySet<number>): EditRange | null {
  if (lineNumbers.size === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const lineNumber of lineNumbers) {
    if (lineNumber < start) start = lineNumber;
    if (lineNumber > end) end = lineNumber;
  }
  return end - start + 1 === lineNumbers.size ? { start, end } : null;
}

export interface ChangedPart {
  // Indexes into the lines, end exclusive.
  from: number;
  to: number;
  // The added lines of the part's one run of changes; null when the run only deletes.
  range: EditRange | null;
}

// Splits a hunk before each run of changed lines but the first, so a part holds one run with the
// unchanged lines before it, and the last part those after it too.
export function changedParts(lines: readonly DiffLine[]): ChangedPart[] {
  const isChanged = (line: DiffLine | undefined) => line?.type === 'add' || line?.type === 'delete';
  const parts: ChangedPart[] = [];
  let part: ChangedPart = { from: 0, to: 0, range: null };
  let partHasRun = false;
  lines.forEach((line, index) => {
    if (!isChanged(line)) return;
    if (partHasRun && !isChanged(lines[index - 1])) {
      parts.push({ ...part, to: index });
      part = { from: index, to: index, range: null };
    }
    partHasRun = true;
    if (line.type === 'add' && line.newLineNumber !== undefined) {
      part.range = { start: part.range?.start ?? line.newLineNumber, end: line.newLineNumber };
    }
  });
  parts.push({ ...part, to: lines.length });
  return parts;
}

// The BOM stays on the first line and each line loses only the CR of its CRLF ending, so the
// lines match the committed bytes the server compares them with.
export async function fetchLinesAt(
  filePath: string,
  ref: string,
  range: EditRange,
): Promise<string[] | null> {
  try {
    const response = await fetch(
      `/api/blob/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!response.ok) return null;
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (range.start < 1 || range.end > lines.length) return null;
    return lines.slice(range.start - 1, range.end).map((line) => line.replace(/\r$/, ''));
  } catch {
    return null;
  }
}

export function rangeOfLine(line: LineNumber): EditRange {
  return typeof line === 'number' ? { start: line, end: line } : { start: line[0], end: line[1] };
}

export function rangesOverlap(a: EditRange, b: EditRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

const EARLIER_EDIT_NOTE =
  '앞서 직접 고쳐 만든 fixup 커밋이 HEAD에 남아 있을 수 있습니다. 화면에서 되돌린 수정도 커밋은 그대로 남습니다.';

const FAILURE_MESSAGES: Record<DirectEditRejection, string> = {
  'stale-view': '화면의 코드가 리뷰 대상 커밋과 다릅니다. 새로고침한 뒤 다시 고쳐 주세요.',
  'target-not-in-head':
    '리뷰 대상 커밋이 지금 체크아웃한 브랜치에 없습니다. 그 커밋이 있는 브랜치로 옮긴 뒤 고쳐 주세요.',
  'detached-head': 'HEAD가 브랜치에 있지 않습니다. 브랜치를 체크아웃한 뒤 고쳐 주세요.',
  'not-a-file': '심볼릭 링크나 서브모듈은 고칠 수 없습니다. 일반 파일만 고칠 수 있습니다.',
  binary: '바이너리 파일은 고칠 수 없습니다.',
  'not-utf8': 'UTF-8 텍스트가 아닌 파일은 고칠 수 없습니다.',
  'missing-at-head': '이 파일이 HEAD에 없습니다. 뒤 커밋에서 지워졌거나 이름이 바뀌었습니다.',
  'dirty-file': '이 파일에 커밋하지 않은 변경이 있습니다. 먼저 커밋하거나 치운 뒤 고쳐 주세요.',
  'operation-in-progress': 'rebase, merge, cherry-pick이 도중에 멈춰 있어 커밋할 수 없습니다.',
  conflict: `뒤 커밋이 같은 줄이나 바로 옆 줄을 바꿔 두어 합칠 수 없습니다. ${EARLIER_EDIT_NOTE}`,
  'fold-conflict':
    '리뷰 범위 안의 어느 커밋에 접어도 autosquash가 충돌합니다. 뒤 커밋이 바꾼 줄과 떨어진 곳을 고쳐 주세요.',
  'no-change': `HEAD에는 이미 이렇게 고쳐져 있습니다. ${EARLIER_EDIT_NOTE}`,
  'head-moved': '저장하는 동안 HEAD가 계속 바뀌어 커밋하지 못했습니다. 잠시 뒤 다시 저장해 주세요.',
  'commit-failed': 'fixup 커밋을 만들지 못했습니다. 아래 출력을 확인해 주세요.',
  'thread-has-fixup': '이 지적에는 판정을 기다리는 수정이 이미 있습니다.',
  'thread-opened-by-edit': '직접 고쳐서 연 스레드는 다시 고치지 않습니다. 줄에서 새로 고쳐 주세요.',
  'card-changed':
    '그사이 이 지적이 해결되었거나, 카드의 fixup이 거절되었거나, 새 fixup이 올라왔습니다. 카드를 다시 확인한 뒤 고쳐 주세요.',
  'outside-fixup':
    '카드에서는 이 fixup이 바꾼 줄만 고칠 수 있습니다. 다른 줄은 diff 본문에서 고쳐 주세요.',
  'no-fold-target':
    '이 fixup이 접힐 커밋을 리뷰 범위에서 찾지 못해 그 위에 고칠 수 없습니다. 지적에 답글로 알려 주세요.',
};

const COMMITTED_UNAPPROVED_MESSAGE =
  '고친 내용은 fixup 커밋으로 남았지만, 저장하는 사이 이 지적이 해결되거나 지워졌거나 카드의 fixup이 거절되어 아무것도 승인하지 않았습니다. 지적이 남아 있으면 카드를 다시 확인해 판정해 주세요.';

export function directEditFailureMessage(
  reason: DirectEditRejection | undefined,
  error: string,
  committed = false,
): string {
  if (committed && reason === 'card-changed') return COMMITTED_UNAPPROVED_MESSAGE;
  return reason ? FAILURE_MESSAGES[reason] : error;
}

const REWORD_FAILURE_MESSAGES: Record<RewordRejection, string> = {
  'stale-view': '그사이 이 커밋의 메시지가 바뀌었습니다. 닫았다가 다시 열어 고쳐 주세요.',
  'target-not-in-head': FAILURE_MESSAGES['target-not-in-head'],
  'detached-head': FAILURE_MESSAGES['detached-head'],
  'operation-in-progress':
    'rebase, merge, cherry-pick, revert가 도중에 멈춰 있어 이력을 바꿀 수 없습니다.',
  'merge-commit': '머지 커밋의 메시지는 고칠 수 없습니다.',
  'agent-working':
    '에이전트가 작업 중입니다. 에이전트가 답하거나 그 지적을 해결한 뒤 다시 저장해 주세요.',
  'empty-message': '메시지를 비울 수는 없습니다.',
  'no-change': '메시지가 바뀌지 않았습니다.',
  'needs-confirmation': '이력을 바꾸기 전에 확인이 필요합니다.',
  conflict:
    '다시 쌓다가 충돌해 저장 전 이력으로 되돌렸습니다. 머지 때 손으로 푼 충돌이나 머지 안에서 고친 내용은 다시 만들 수 없습니다. 아래 출력을 확인해 주세요.',
  'head-moved': '저장하는 동안 HEAD가 바뀌어 이력을 바꾸지 않았습니다. 다시 저장해 주세요.',
  'commit-failed':
    '이력을 다시 쓰지 못해 저장 전 이력 그대로 두었습니다. 아래 출력을 확인해 주세요.',
};

const REWRITE_WARNING_MESSAGES: Record<RewriteWarning, string> = {
  'default-branch': '기본 브랜치의 이력이 바뀝니다.',
  'pushed-commit': 'push한 커밋이 바뀝니다. 다시 올리려면 force push가 필요합니다.',
};

export function rewordFailureMessage(
  reason: RewordRejection | undefined,
  error: string,
  warnings?: readonly RewriteWarning[],
): string {
  if (warnings && warnings.length > 0) {
    return warnings.map((warning) => REWRITE_WARNING_MESSAGES[warning]).join(' ');
  }
  return reason ? REWORD_FAILURE_MESSAGES[reason] : error;
}
