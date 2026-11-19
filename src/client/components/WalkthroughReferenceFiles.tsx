import { Fragment, useEffect, useMemo, useRef } from 'react';

import { useHighlightedCode } from '../hooks/useHighlightedCode';
import { tokenizeContent } from '../utils/fileTokens';
import { getPrismLanguageFromFilename } from '../utils/languageDetection';
import type { ReferenceFile } from '../utils/walkthroughStep';

import { EnhancedPrismSyntaxHighlighter } from './EnhancedPrismSyntaxHighlighter';
import { FilePathText } from './FilePathText';
import type { AppearanceSettings } from './SettingsModal';

interface ReferenceStep {
  file: string;
  line: number;
  endLine: number;
}

type ReferenceFileWithLines = ReferenceFile & { lines: readonly string[] };

interface WalkthroughReferenceFilesProps {
  // Read at the walkthrough's commit, whose lines its steps name.
  files: readonly ReferenceFileWithLines[];
  step: ReferenceStep | null;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  onShowLine: (file: string, elementId: string) => void;
}

export const referenceLineId = (file: string, line: number) =>
  `walkthrough-reference-${file}:${line}`;

const MAX_HIGHLIGHTED_LINE_LENGTH = 10_000;

const CODE_CLASS =
  'whitespace-pre-wrap break-all text-github-text-primary select-text [&_pre]:m-0 [&_pre]:p-0 [&_pre]:!bg-transparent [&_pre]:font-inherit [&_pre]:text-inherit [&_pre]:leading-inherit [&_code]:!bg-transparent [&_code]:font-inherit [&_code]:text-inherit [&_code]:leading-inherit';

function ReferenceFileView({
  file,
  parts,
  lines,
  step,
  syntaxTheme,
  onShowLine,
}: ReferenceFileWithLines & Omit<WalkthroughReferenceFilesProps, 'files'>) {
  const language = useMemo(() => getPrismLanguageFromFilename(file), [file]);
  const { ready: grammarReady } = useHighlightedCode(language);

  const tokens = useMemo(
    () => (grammarReady ? tokenizeContent(lines.join('\n'), language) : null),
    [grammarReady, lines, language],
  );
  const shownParts = parts
    .map(({ start, end }) => ({ start, end: Math.min(end, lines.length) }))
    .filter(({ start, end }) => start <= end);

  const stepHere = step?.file === file ? step : null;
  const showLineRef = useRef(onShowLine);
  showLineRef.current = onShowLine;
  const stepLine = stepHere?.line;
  const shownStepLine = stepLine !== undefined && stepLine <= lines.length ? stepLine : null;
  useEffect(() => {
    if (shownStepLine !== null) showLineRef.current(file, referenceLineId(file, shownStepLine));
  }, [file, shownStepLine, stepHere?.endLine]);

  return (
    <section
      aria-label={`참고 파일 ${file}`}
      data-walkthrough-reference={file}
      className="mb-6 rounded-md border border-dashed border-github-border"
    >
      <div className="flex items-center gap-2 border-b border-github-border bg-github-bg-secondary px-4 py-2 text-sm">
        <span className="shrink-0 rounded-full border border-[var(--color-walkthrough-step-border)] px-2 py-0.5 text-xs font-semibold text-[var(--color-walkthrough-step-border)]">
          참고
        </span>
        <FilePathText path={file} className="font-mono text-github-text-primary" />
      </div>
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {shownParts.map(({ start, end }, partIndex) => {
            const previousEnd = shownParts[partIndex - 1]?.end;
            return (
              <Fragment key={start}>
                {previousEnd !== undefined && (
                  <tr>
                    <td
                      colSpan={2}
                      className="bg-github-bg-secondary px-4 py-0.5 text-github-text-muted"
                    >
                      {`⋯ ${start - previousEnd - 1}줄 생략`}
                    </td>
                  </tr>
                )}
                {lines.slice(start - 1, end).map((content, index) => {
                  const lineNumber = start + index;
                  const lineTokens = tokens?.[lineNumber - 1];
                  const isStep =
                    stepHere !== null &&
                    lineNumber >= stepHere.line &&
                    lineNumber <= stepHere.endLine;
                  return (
                    <tr
                      key={lineNumber}
                      id={referenceLineId(file, lineNumber)}
                      data-reference-line={lineNumber}
                      {...(isStep && { 'data-walkthrough-step': '' })}
                    >
                      <td className="w-12 select-none border-r border-github-border px-2 text-right align-top text-github-text-muted">
                        {lineNumber}
                      </td>
                      <td className="px-3 align-top">
                        {content.length > MAX_HIGHLIGHTED_LINE_LENGTH ? (
                          <span className={CODE_CLASS}>{content}</span>
                        ) : (
                          <EnhancedPrismSyntaxHighlighter
                            code={content}
                            className={CODE_CLASS}
                            syntaxTheme={syntaxTheme}
                            filename={file}
                            precomputedTokens={lineTokens ? [lineTokens] : null}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// Not review files, so they take no comments and no part in the file list.
export function WalkthroughReferenceFiles({ files, ...rest }: WalkthroughReferenceFilesProps) {
  if (files.length === 0) return null;
  return (
    <section aria-label="따라가기 참고 파일" className="mt-5">
      <h2 className="mb-3 border-b-2 border-[var(--color-walkthrough-step-border)] pb-1.5 text-[13px] font-semibold text-[var(--color-walkthrough-step-border)]">
        따라가기 참고 파일 — 이번 리뷰에서 바뀌지 않은 파일, 따라가기를 닫으면 사라진다
      </h2>
      {files.map((reference) => (
        <ReferenceFileView key={reference.file} {...reference} {...rest} />
      ))}
    </section>
  );
}
