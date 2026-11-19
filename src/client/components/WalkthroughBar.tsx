import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import type { WalkthroughCase } from '../../types/diff';
import { callPathTarget } from '../../utils/walkthrough';
import { useDiffLineLinks } from '../contexts/DiffLineLinkContext';
import {
  WALKTHROUGH_AUTOPLAY_INTERVAL_MS,
  type WalkthroughPlaybackAction,
} from '../utils/walkthroughPlayback';

interface WalkthroughBarProps {
  cases: readonly WalkthroughCase[];
  caseIndex: number;
  index: number;
  playing: boolean;
  shown: boolean;
  onPlay: (action: WalkthroughPlaybackAction) => void;
  onClose: () => void;
}

const BUTTON_CLASS =
  'inline-flex items-center gap-0.5 rounded-md border border-github-border px-2 py-0.5 text-xs text-github-text-primary hover:bg-github-bg-tertiary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

const STEP_KEY_OPTIONS = { scopes: 'navigation', enableOnFormTags: false, preventDefault: true };

const LABEL_CLASS = 'font-semibold text-github-text-secondary';

function CallPathEntry({ entry }: { entry: string }) {
  const links = useDiffLineLinks();
  const target = callPathTarget(entry);
  const file = target && links?.resolve(target.file);
  if (!links || !target || !file) return <span className="font-mono">{entry}</span>;
  return (
    <button
      type="button"
      title={`Go to ${entry}`}
      onClick={(event) => links.open({ ...target, file }, event.currentTarget)}
      className="cursor-pointer font-mono text-sky-400 hover:text-sky-300 underline underline-offset-4"
    >
      {entry}
    </button>
  );
}

function StepValues({ label, values }: { label: string; values?: Record<string, string> }) {
  if (!values) return null;
  return (
    <>
      <dt className={LABEL_CLASS}>{label}</dt>
      <dd className="min-w-0">
        <ul aria-label={label} className="flex flex-wrap gap-x-3 gap-y-0.5">
          {Object.entries(values).map(([name, value]) => (
            <li key={name} className="font-mono break-all text-github-text-primary">
              {name} = {value}
            </li>
          ))}
        </ul>
      </dd>
    </>
  );
}

export function WalkthroughBar({
  cases,
  caseIndex,
  index,
  playing,
  shown,
  onPlay,
  onClose,
}: WalkthroughBarProps) {
  useHotkeys('mod+left', () => onPlay({ type: 'previous' }), STEP_KEY_OPTIONS, [onPlay]);
  useHotkeys('mod+right', () => onPlay({ type: 'next' }), STEP_KEY_OPTIONS, [onPlay]);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(
      () => onPlayRef.current({ type: 'tick' }),
      WALKTHROUGH_AUTOPLAY_INTERVAL_MS,
    );
    return () => clearTimeout(timer);
  }, [playing, caseIndex, index]);

  const walkthroughCase = cases[caseIndex];
  const step = walkthroughCase?.steps[index];
  if (!walkthroughCase || !step) return null;
  const { steps, setup } = walkthroughCase;
  const { callPath, variables, stateChanges, error } = step;
  const location = `${step.file}:${step.line}${step.endLine === undefined ? '' : `-${step.endLine}`}`;

  return (
    <div
      role="region"
      aria-label="따라가기"
      data-walkthrough-bar
      className={`shrink-0 flex items-start gap-3 px-4 py-2 text-sm bg-github-bg-secondary border-b border-github-border border-l-4 ${error ? 'border-l-[var(--color-walkthrough-error-border)]' : 'border-l-[var(--color-walkthrough-step-border)]'}`}
    >
      <div className="shrink-0 flex flex-col items-start gap-0.5 pt-0.5">
        <span className="text-xs font-semibold text-github-text-primary">따라가기</span>
        {cases.length > 1 && (
          <select
            aria-label="경우"
            value={caseIndex}
            onChange={(event) =>
              onPlay({ type: 'selectCase', caseIndex: Number(event.target.value) })
            }
            className="max-w-48 truncate rounded-md border border-github-border bg-github-bg-primary px-1 py-0.5 text-xs text-github-text-primary"
          >
            {cases.map((item, itemIndex) => (
              <option key={itemIndex} value={itemIndex}>
                {item.title ?? `경우 ${itemIndex + 1}`}
              </option>
            ))}
          </select>
        )}
        <span className="text-xs tabular-nums text-github-text-secondary">
          {index + 1} / {steps.length}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        {setup !== undefined && (
          <p className="mb-0.5 text-xs text-github-text-secondary break-words">
            <span className="mr-1.5 font-semibold">처음 상태</span>
            <span>{setup}</span>
          </p>
        )}
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-github-text-muted">
          <span className="font-mono">{location}</span>
          {error && (
            <span className="font-semibold text-[var(--color-walkthrough-error-border)]">
              오류로 끝나는 단계
            </span>
          )}
          {!shown && <span className="text-github-warning">diff 에 안 보이는 줄</span>}
        </p>
        <p className="text-github-text-primary break-words">{step.description}</p>
        {(callPath || variables || stateChanges) && (
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
            {callPath && (
              <>
                <dt className={LABEL_CLASS}>호출 경로</dt>
                <dd className="min-w-0">
                  <ol aria-label="호출 경로" className="flex flex-wrap gap-x-1.5 gap-y-0.5">
                    {callPath.map((entry, entryIndex) => (
                      <li
                        key={entryIndex}
                        className="break-all after:ml-1.5 after:text-github-text-muted after:content-['→'] last:after:content-none"
                      >
                        <CallPathEntry entry={entry} />
                      </li>
                    ))}
                  </ol>
                </dd>
              </>
            )}
            <StepValues label="변수" values={variables} />
            <StepValues label="바뀌는 상태" values={stateChanges} />
          </dl>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <button
          type="button"
          aria-label="이전 단계"
          className={BUTTON_CLASS}
          disabled={index === 0}
          onClick={() => onPlay({ type: 'previous' })}
        >
          <ChevronLeft size={14} />
          이전
        </button>
        <button
          type="button"
          aria-label={playing ? '자동 재생 멈춤' : '자동 재생'}
          className={BUTTON_CLASS}
          disabled={!playing && index === steps.length - 1}
          onClick={() => onPlay({ type: 'play' })}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
          {playing ? '멈춤' : '재생'}
        </button>
        <button
          type="button"
          aria-label="다음 단계"
          className={BUTTON_CLASS}
          disabled={index === steps.length - 1}
          onClick={() => onPlay({ type: 'next' })}
        >
          다음
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          aria-label="따라가기 닫기"
          title="따라가기 닫기"
          className="ml-1 p-1 text-github-text-muted hover:text-github-text-primary"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
