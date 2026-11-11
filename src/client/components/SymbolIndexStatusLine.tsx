import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  ExternalLink,
  Info,
  LoaderCircle,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { SymbolIndexLogResponse, SymbolSearchResponse } from '../../types/diff';
import type { SymbolIndexState } from '../../types/watch';
import { copyTextToClipboard } from '../utils/clipboard';

export const SCIP_JAVA_INSTALL =
  'coursier bootstrap --standalone -o scip-java com.sourcegraph:scip-java_2.13:0.12.3 --main com.sourcegraph.scip_java.ScipJava';
const INSTALL_GUIDE = 'https://github.com/duru-app/difit#scip-java-설치';

interface SymbolIndexStatusLineProps {
  index?: SymbolSearchResponse['index'];
  unindexed?: SymbolSearchResponse['unindexed'];
  gitRef: string;
}

export function SymbolIndexStatusLine({ index, unindexed, gitRef }: SymbolIndexStatusLineProps) {
  if (index) return <IndexStateLine commit={index.commit} state={index} />;
  if (unindexed === 'not-java') {
    return (
      <StatusRow tone="info" icon={<Info size={14} />}>
        Java 파일이 아니라 색인을 쓰지 않습니다 · 이름으로 찾은 결과입니다
      </StatusRow>
    );
  }
  if (unindexed === 'not-commit') {
    return (
      <StatusRow tone="info" icon={<Info size={14} />}>
        커밋이 아닌 리뷰(<code className="font-mono">{gitRef}</code>)라 색인을 쓰지 않습니다 ·
        이름으로 찾은 결과입니다
      </StatusRow>
    );
  }
  return null;
}

function IndexStateLine({ commit, state }: { commit: string; state: SymbolIndexState }) {
  switch (state.status) {
    case 'queued':
      return (
        <StatusRow tone="wait" icon={<Clock size={14} />}>
          색인 기다리는 중{' '}
          <span className="text-github-text-secondary">
            · 앞 커밋 <code className="font-mono">{state.after.slice(0, 7)}</code>의 색인이 끝나면
            시작합니다
          </span>
        </StatusRow>
      );
    case 'building':
      return (
        <StatusRow
          tone="build"
          icon={<LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />}
        >
          색인을 만드는 중 · <Elapsed since={state.startedAt} />
        </StatusRow>
      );
    case 'unavailable':
      if (state.reason === 'no-java') return null;
      if (state.reason === 'no-build-file') {
        return (
          <CannotIndex>
            저장소 맨 위에 <code className="font-mono">build.gradle</code>,{' '}
            <code className="font-mono">settings.gradle</code>,{' '}
            <code className="font-mono">pom.xml</code>이 없습니다
          </CannotIndex>
        );
      }
      return <CannotIndex extra={<InstallGuide />}>scip-java가 없습니다</CannotIndex>;
    case 'failed':
      return (
        <CannotIndex
          extra={
            state.hasLog ? (
              <BuildLog commit={commit} detail={state.detail} />
            ) : (
              <FailureDetail detail={state.detail} />
            )
          }
        >
          {failureText(state)}
        </CannotIndex>
      );
    default:
      return null;
  }
}

function failureText(state: Extract<SymbolIndexState, { status: 'failed' }>): string {
  switch (state.reason) {
    case 'no-gradle':
      return 'Gradle을 찾지 못했습니다. 저장소에 gradlew가 없고 PATH에도 gradle이 없습니다';
    case 'timeout':
      return '빌드가 1시간 안에 끝나지 않아 멈췄습니다';
    case 'exit-code':
      return `빌드가 실패했습니다 (scip-java 종료 코드 ${state.exitCode ?? '없음'})`;
    case 'no-output':
      return 'scip-java가 끝났지만 색인 파일을 남기지 않았습니다';
    case 'error':
      return '색인을 만들다 오류가 났습니다';
  }
}

const TONES = {
  wait: { row: 'text-github-text-secondary', icon: '' },
  build: { row: 'text-github-warning', icon: '' },
  fail: { row: 'text-github-text-primary', icon: 'text-github-danger' },
  info: { row: 'text-github-text-secondary', icon: '' },
};

// Only the first line is a live region, so the log and the ticking time are not read out.
function StatusRow({
  tone,
  icon,
  extra,
  children,
}: {
  tone: keyof typeof TONES;
  icon: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex shrink-0 items-start gap-2 border-b border-github-border bg-github-bg-secondary px-4 py-2 text-xs leading-[18px] ${TONES[tone].row}`}
    >
      <span className={`mt-0.5 flex shrink-0 ${TONES[tone].icon}`} aria-hidden="true">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p role="status">{children}</p>
        {extra}
      </div>
    </div>
  );
}

function CannotIndex({ extra, children }: { extra?: ReactNode; children: ReactNode }) {
  return (
    <StatusRow tone="fail" icon={<CircleAlert size={14} />} extra={extra}>
      색인을 만들 수 없음 <span className="text-github-text-secondary">· {children}</span>
    </StatusRow>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span aria-live="off">
      {seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`}
    </span>
  );
}

function InstallGuide() {
  return (
    <>
      <div className="flex items-start gap-1.5 rounded-md border border-github-border bg-github-bg-primary py-1 pl-2 pr-1.5">
        <code className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[11px] text-github-text-primary [overflow-wrap:anywhere]">
          {SCIP_JAVA_INSTALL}
        </code>
        <CopyButton text={SCIP_JAVA_INSTALL} label="복사" boxed />
      </div>
      <span className="text-github-text-secondary">
        만든 파일을 PATH에 두거나 <code className="font-mono">DIFIT_SCIP_JAVA</code>에 경로를 넣고
        difit을 다시 실행하세요 ·{' '}
        <a
          href={INSTALL_GUIDE}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-[3px] text-sky-400 hover:text-sky-300 hover:underline"
        >
          README의 scip-java 설치
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      </span>
    </>
  );
}

function CopyButton({
  text,
  label,
  boxed = false,
}: {
  text: string;
  label: string;
  boxed?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    copyTextToClipboard(text).then(
      () => setCopied(true),
      (error: unknown) => console.error('Failed to copy:', error),
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={
        boxed
          ? 'inline-flex shrink-0 items-center gap-1 rounded border border-github-border bg-github-bg-tertiary px-1.5 py-0.5 text-[11px] text-github-text-secondary hover:text-github-text-primary'
          : 'inline-flex items-center gap-[3px] text-sky-400 hover:text-sky-300 hover:underline'
      }
    >
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      {copied ? '복사했습니다' : label}
    </button>
  );
}

function FailureDetail({ detail }: { detail: string }) {
  return <code className="break-all font-mono text-github-text-secondary">{detail}</code>;
}

function BuildLog({ commit, detail }: { commit: string; detail: string }) {
  const [log, setLog] = useState<SymbolIndexLogResponse | null | undefined>(undefined);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLog(undefined);
    void fetch(`/api/symbol-index/${commit}/log`, { signal: controller.signal })
      .then(async (response) =>
        response.ok ? ((await response.json()) as SymbolIndexLogResponse) : null,
      )
      .catch(() => null)
      .then((fetched) => {
        if (!controller.signal.aborted) setLog(fetched);
      });
    return () => controller.abort();
  }, [commit]);

  if (log === undefined) return null;
  if (log === null) return <FailureDetail detail={detail} />;
  const lines = log.text.replace(/\n+$/, '').split('\n');
  return (
    <details
      className="group"
      onToggle={(event) => {
        if (event.currentTarget.open && pre.current) {
          pre.current.scrollTop = pre.current.scrollHeight;
        }
      }}
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-github-text-secondary [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className="transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        빌드 기록 끝부분 ({lines.length}줄)
      </summary>
      <pre
        ref={pre}
        className="mt-1.5 max-h-[200px] overflow-auto rounded-md border border-github-border bg-github-bg-primary px-2.5 py-2 font-mono text-[11px] leading-4 text-github-text-primary"
      >
        {lines.join('\n')}
      </pre>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-github-text-muted">
        <span className="min-w-0">
          전체 기록 <code className="break-all font-mono">{log.path}</code> · 끝 64KB만 남깁니다
        </span>
        <CopyButton text={log.path} label="경로 복사" />
      </div>
    </details>
  );
}
