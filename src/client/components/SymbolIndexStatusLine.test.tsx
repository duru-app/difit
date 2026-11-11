import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SymbolSearchResponse } from '../../types/diff';
import type { SymbolIndexState } from '../../types/watch';

import { SCIP_JAVA_INSTALL, SymbolIndexStatusLine } from './SymbolIndexStatusLine';

const commit = 'a'.repeat(40);

function line(state: SymbolIndexState, unindexed?: SymbolSearchResponse['unindexed']) {
  return render(
    <SymbolIndexStatusLine index={{ commit, ...state }} unindexed={unindexed} gitRef="abc1234" />,
  );
}

const status = () => screen.getByRole('status');

describe('SymbolIndexStatusLine', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    global.fetch = vi.fn();
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names the commit whose build a waiting one follows', () => {
    line({ status: 'queued', after: '4b7d0aa'.padEnd(40, '0') });

    expect(status()).toHaveTextContent(
      '색인 기다리는 중 · 앞 커밋 4b7d0aa의 색인이 끝나면 시작합니다',
    );
  });

  it('counts the time a build has taken', () => {
    vi.useFakeTimers();
    line({ status: 'building', startedAt: Date.now() - 84_000 });

    expect(status()).toHaveTextContent(/^색인을 만드는 중 · 1분 24초$/);
    act(() => vi.advanceTimersByTime(1000));
    expect(status()).toHaveTextContent('1분 25초');
  });

  it('shows how to install scip-java, in a box whose command wraps', async () => {
    line({ status: 'unavailable', reason: 'no-scip-java' });

    expect(status()).toHaveTextContent('색인을 만들 수 없음 · scip-java가 없습니다');
    const command = screen.getByText(SCIP_JAVA_INSTALL);
    expect(command).toHaveClass('whitespace-pre-wrap', '[overflow-wrap:anywhere]');
    expect(screen.getByRole('link', { name: 'README의 scip-java 설치' })).toHaveAttribute(
      'href',
      'https://github.com/duru-app/difit#scip-java-설치',
    );

    fireEvent.click(screen.getByRole('button', { name: '복사' }));

    expect(writeText).toHaveBeenCalledWith(SCIP_JAVA_INSTALL);
    expect(await screen.findByRole('button', { name: '복사했습니다' })).toBeInTheDocument();
  });

  it.each([
    [
      { status: 'unavailable', reason: 'no-build-file' },
      '저장소 맨 위에 build.gradle, settings.gradle, pom.xml이 없습니다',
    ],
    [
      { status: 'failed', reason: 'no-gradle', exitCode: 1, detail: '', hasLog: false },
      'Gradle을 찾지 못했습니다. 저장소에 gradlew가 없고 PATH에도 gradle이 없습니다',
    ],
    [
      { status: 'failed', reason: 'timeout', detail: '', hasLog: false },
      '빌드가 1시간 안에 끝나지 않아 멈췄습니다',
    ],
    [
      { status: 'failed', reason: 'exit-code', exitCode: 3, detail: '', hasLog: false },
      '빌드가 실패했습니다 (scip-java 종료 코드 3)',
    ],
  ] satisfies [SymbolIndexState, string][])('says why the index cannot be built', (state, why) => {
    line(state);

    expect(status()).toHaveTextContent(`색인을 만들 수 없음 · ${why}`);
  });

  it('shows the end of the build log folded, scrolled to its last line once opened', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          path: `/home/me/.difit/scip-index/${commit}/build.log`,
          text: 'one\ntwo\n[difit] scip-java exited with code 1\n',
        }),
      ),
    );
    line({
      status: 'failed',
      reason: 'exit-code',
      exitCode: 1,
      detail: 'scip-java exited with code 1',
      hasLog: true,
    });

    const summary = await screen.findByText('빌드 기록 끝부분 (3줄)');
    expect(global.fetch).toHaveBeenCalledWith(`/api/symbol-index/${commit}/log`, {
      signal: expect.any(AbortSignal),
    });
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    const log = details.querySelector('pre')!;
    expect(log).toHaveTextContent('one two [difit] scip-java exited with code 1');
    expect(log).toHaveClass('max-h-[200px]', 'overflow-auto');
    Object.defineProperty(log, 'scrollHeight', { value: 480, configurable: true });

    details.open = true;
    fireEvent(details, new Event('toggle'));

    expect(log.scrollTop).toBe(480);
    fireEvent.click(screen.getByRole('button', { name: '경로 복사' }));
    expect(writeText).toHaveBeenCalledWith(`/home/me/.difit/scip-index/${commit}/build.log`);
  });

  it('shows what went wrong when a failed build left no log', () => {
    line({
      status: 'failed',
      reason: 'error',
      detail: 'index build failed: spawn git ENOENT',
      hasLog: false,
    });

    expect(status()).toHaveTextContent('색인을 만들 수 없음 · 색인을 만들다 오류가 났습니다');
    expect(screen.getByText('index build failed: spawn git ENOENT')).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['is gone by the time it is fetched', () => Response.json({ error: 'gone' }, { status: 404 })],
    [
      'cannot be fetched',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('shows what went wrong when the build log %s', async (_case, respond) => {
    vi.mocked(global.fetch).mockImplementation(async () => respond());
    line({
      status: 'failed',
      reason: 'exit-code',
      exitCode: 1,
      detail: 'scip-java exited with code 1',
      hasLog: true,
    });

    expect(await screen.findByText('scip-java exited with code 1')).toBeInTheDocument();
    expect(screen.queryByText(/빌드 기록 끝부분/)).not.toBeInTheDocument();
  });

  it.each<SymbolIndexState>([
    { status: 'none' },
    { status: 'ready' },
    { status: 'unavailable', reason: 'no-java' },
  ])('says nothing when the index is $status and nothing went wrong', (state) => {
    const { container } = line(state);

    expect(container).toBeEmptyDOMElement();
  });

  it('says why name search answered a click it did not use an index for', () => {
    const { rerender, container } = render(
      <SymbolIndexStatusLine unindexed="not-java" gitRef="abc1234" />,
    );
    expect(status()).toHaveTextContent(
      'Java 파일이 아니라 색인을 쓰지 않습니다 · 이름으로 찾은 결과입니다',
    );

    rerender(<SymbolIndexStatusLine unindexed="not-commit" gitRef="working" />);
    expect(status()).toHaveTextContent(
      '커밋이 아닌 리뷰(working)라 색인을 쓰지 않습니다 · 이름으로 찾은 결과입니다',
    );

    rerender(<SymbolIndexStatusLine gitRef="working" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fetches the log again for another commit', async () => {
    vi.mocked(global.fetch).mockImplementation(async () =>
      Response.json({ path: '/log', text: 'x\n' }),
    );
    const failed: SymbolIndexState = {
      status: 'failed',
      reason: 'exit-code',
      exitCode: 1,
      detail: '',
      hasLog: true,
    };
    const { rerender } = render(
      <SymbolIndexStatusLine index={{ commit, ...failed }} gitRef="abc1234" />,
    );
    await screen.findByText('빌드 기록 끝부분 (1줄)');

    rerender(
      <SymbolIndexStatusLine index={{ commit: 'b'.repeat(40), ...failed }} gitRef="abc1234" />,
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toBe(
      `/api/symbol-index/${'b'.repeat(40)}/log`,
    );
  });
});
