import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHotkeys, useHotkeysContext } from 'react-hotkeys-hook';

import { useViewport } from '../hooks/useViewport';

import { MermaidDiagram } from './MermaidDiagram';

function EnlargedDiagram({
  chart,
  fitWindow,
  onClose,
}: {
  chart: string;
  fitWindow: boolean;
  onClose: () => void;
}) {
  const { enableScope, disableScope } = useHotkeysContext();

  useHotkeys('escape', () => onClose(), { enableOnFormTags: true }, [onClose]);

  useEffect(() => {
    disableScope('navigation');
    return () => enableScope('navigation');
  }, [enableScope, disableScope]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="도식"
      className="fixed inset-0 z-50 flex flex-col"
      onClick={(event) => event.stopPropagation()}
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
        <div className={`bg-github-bg-primary ${fitWindow ? 'w-full' : 'w-max'}`}>
          <MermaidDiagram chart={chart} naturalSize={!fitWindow} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function CommentMermaidDiagram({ chart }: { chart: string }) {
  const { isMobile } = useViewport();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="my-2">
      <MermaidDiagram chart={chart} onEnlarge={() => setIsOpen(true)} />
      {isOpen && (
        <EnlargedDiagram chart={chart} fitWindow={!isMobile} onClose={() => setIsOpen(false)} />
      )}
    </div>
  );
}
