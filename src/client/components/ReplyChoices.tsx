import { Check, Info } from 'lucide-react';
import React, { useState } from 'react';

import {
  type ChoiceAnswer,
  type DiffCommentMessage,
  type ReplyChoice,
  REVIEWER_EDIT_AUTHOR,
} from '../../types/diff';
import { isAgentMessage, promisedFixBeforeAnswer } from '../../utils/reviewDecisions';

const PREVIEW_LINES = 3;

interface ReplyChoicesProps {
  message: DiffCommentMessage & { choices: ReplyChoice[] };
  // The messages after `message` in the thread.
  later: DiffCommentMessage[];
  onPick: (body: string, answer: ChoiceAnswer) => Promise<void>;
}

function choiceReplyBody(choice: ReplyChoice, isChange: boolean): string {
  return `${isChange ? '바꿈' : '고름'}: ${choice.id} — ${choice.name}`;
}

const LINK_CLASS = 'text-blue-400 hover:underline';

export function ReplyChoices({ message, later, onPick }: ReplyChoicesProps) {
  const [isChanging, setIsChanging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [seenReplies, setSeenReplies] = useState(later.length);
  if (seenReplies !== later.length) {
    setSeenReplies(later.length);
    setIsChanging(false);
  }
  const { choices } = message;

  const picked = later
    .map((reply) => reply.answer)
    .filter(
      (answer): answer is ChoiceAnswer =>
        answer?.messageId === message.id && choices.some((choice) => choice.id === answer.choice),
    )
    .at(-1)?.choice;
  const answers = later.filter((reply) => !isAgentMessage(reply) && reply.answer === undefined);
  const answeredInWords = answers.length > 0;
  const answeredBy = answers.at(-1)?.author === REVIEWER_EDIT_AUTHOR ? '코드를 고쳐' : '글로';
  const newerChoices = later.some((reply) => isAgentMessage(reply) && reply.choices?.length);
  const superseded = newerChoices || promisedFixBeforeAnswer(later);
  const isOpen = !superseded && ((picked === undefined && !answeredInWords) || isChanging);

  const pick = async (choice: ReplyChoice) => {
    if (!isOpen || isSending) return;
    if (choice.id === picked) {
      setIsChanging(false);
      return;
    }
    setIsSending(true);
    try {
      await onPick(choiceReplyBody(choice, picked !== undefined), {
        messageId: message.id,
        choice: choice.id,
      });
      setIsChanging(false);
    } finally {
      setIsSending(false);
    }
  };

  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>, choice: ReplyChoice) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) {
      return;
    }
    void pick(choice);
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, choice: ReplyChoice) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    void pick(choice);
  };

  const toggleExpanded = (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const keepPick = (
    <button type="button" className={LINK_CLASS} onClick={() => setIsChanging(false)}>
      그대로 두기
    </button>
  );
  const header = superseded ? (
    <span>
      {newerChoices ? '아래 새 고를 거리로 넘어갔습니다' : '에이전트가 고치겠다고 답했습니다'}
      {picked !== undefined && <> · {picked} 고름</>}
    </span>
  ) : isOpen ? (
    <>
      <Info size={12} aria-hidden className="shrink-0" />
      {isChanging && picked !== undefined ? (
        <span>
          바꿀 것을 고르세요 · 지금은 {picked} · {keepPick}
        </span>
      ) : (
        <span>
          하나를 고르세요 · 고를 거리 밖의 답은 아래 답글로
          {isChanging && <> · {keepPick}</>}
        </span>
      )}
    </>
  ) : picked === undefined ? (
    <span>
      {answeredBy} 답했습니다 ·{' '}
      <button type="button" className={LINK_CLASS} onClick={() => setIsChanging(true)}>
        그래도 고르기
      </button>
    </span>
  ) : (
    <span>
      <span className="inline-flex items-center gap-1 text-green-500">
        <Check size={12} aria-hidden />
        {picked} 고름
      </span>{' '}
      ·{' '}
      <button type="button" className={LINK_CLASS} onClick={() => setIsChanging(true)}>
        다른 걸로 바꾸기
      </button>
    </span>
  );

  return (
    <div
      data-testid="reply-choices"
      className="mt-2 flex flex-col gap-2 rounded-md border border-github-border bg-github-bg-secondary p-2.5"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-github-text-secondary">
        {header}
      </div>
      <div role="radiogroup" aria-label="고를 거리" className="grid grid-cols-1 gap-2">
        {choices.map((choice) => {
          const isPicked = !isOpen && choice.id === picked;
          const lines = choice.preview?.text.split('\n') ?? [];
          const isCut = lines.length > PREVIEW_LINES && !expanded.has(choice.id);
          return (
            <div
              key={choice.id}
              role="radio"
              aria-checked={choice.id === picked}
              aria-disabled={!isOpen || isSending}
              tabIndex={isOpen ? 0 : -1}
              data-choice={choice.id}
              onClick={(event) => handleCardClick(event, choice)}
              onKeyDown={(event) => handleCardKeyDown(event, choice)}
              className={`flex min-w-0 flex-col gap-1.5 rounded-md border bg-github-bg-tertiary p-2.5 text-xs text-github-text-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isPicked
                  ? 'border-github-accent ring-1 ring-inset ring-github-accent'
                  : 'border-github-border'
              } ${!isOpen && !isPicked ? 'opacity-45' : ''} ${
                isOpen ? 'cursor-pointer hover:border-github-text-secondary' : ''
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] text-github-text-primary">
                  <b>{choice.id}</b> · {choice.name}
                </span>
                {choice.recommended && (
                  <span className="inline-flex h-[18px] items-center rounded-full border border-github-accent px-1.5 text-[10px] text-green-500">
                    추천
                  </span>
                )}
                {isPicked && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] text-green-500">
                    <Check size={11} aria-hidden />
                    고름
                  </span>
                )}
              </div>
              {choice.description && <div>{choice.description}</div>}
              {choice.preview && (
                <>
                  {choice.preview.label && (
                    <div className="font-mono text-[11px] text-github-text-muted">
                      {choice.preview.label}
                    </div>
                  )}
                  <pre className="m-0 overflow-x-auto rounded-md border border-github-border bg-github-bg-primary px-2 py-1.5 font-mono text-[11px] leading-4 text-github-text-primary">
                    {isCut ? `${lines.slice(0, PREVIEW_LINES).join('\n')}\n…` : choice.preview.text}
                  </pre>
                  {lines.length > PREVIEW_LINES && (
                    <button
                      type="button"
                      className={`self-start text-[11px] ${LINK_CLASS}`}
                      onClick={(event) => toggleExpanded(event, choice.id)}
                    >
                      {isCut ? `더 보기 (${lines.length}줄)` : '접기'}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
