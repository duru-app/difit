const DOT_DELAYS_MS = [0, 150, 300];

export function RespondingChip() {
  return (
    <span
      data-testid="responding-chip"
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-github-accent px-2 text-[10px] font-medium text-github-accent"
    >
      <span aria-hidden className="inline-flex items-center gap-0.5">
        {DOT_DELAYS_MS.map((delay) => (
          <span
            key={delay}
            data-testid="responding-dot"
            className="h-1 w-1 animate-responding-dot rounded-full bg-current motion-reduce:animate-none"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      응답 중
    </span>
  );
}
