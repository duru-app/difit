import { X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useHotkeys } from 'react-hotkeys-hook';

import { useViewport } from '../hooks/useViewport';

import { MermaidDiagram } from './MermaidDiagram';

function EnlargedDiagram({ chart, onClose }: { chart: string; onClose: () => void }) {
  useHotkeys('escape', () => onClose(), { enableOnFormTags: true }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="도식"
      className="fixed inset-0 z-50 flex flex-col"
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative flex justify-end p-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="rounded bg-github-bg-primary p-2 text-github-text-secondary hover:text-github-text-primary"
        >
          <X size={20} />
        </button>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-auto px-2 pb-2"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div className="w-max bg-github-bg-primary">
          <MermaidDiagram chart={chart} naturalSize />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function CommentMermaidDiagram({ chart }: { chart: string }) {
  const { isMobile } = useViewport();
  const [isOpen, setIsOpen] = useState(false);

  if (!isMobile) {
    return (
      <div className="my-2">
        <MermaidDiagram chart={chart} />
      </div>
    );
  }

  return (
    <div className="my-2">
      <button
        type="button"
        aria-label="도식 크게 보기"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen(true);
        }}
        className="block w-full text-left"
      >
        <MermaidDiagram chart={chart} />
      </button>
      {isOpen && <EnlargedDiagram chart={chart} onClose={() => setIsOpen(false)} />}
    </div>
  );
}
