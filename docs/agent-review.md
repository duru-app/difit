# 에이전트가 리뷰에 답하는 법

[README](../README.md)의 "이 포크에서 달라진 것"의 리뷰 흐름에서 에이전트가 지적을 받고, fixup 커밋으로 답하고, 승인된 수정을 접는 절차다.

## 지적 카드의 상태

| 상태         | 뜻                                          | 리뷰어가 할 일            |
| ------------ | ------------------------------------------- | ------------------------- |
| 답변 대기    | 에이전트가 아직 답하지 않았다               | 기다린다                  |
| 답변 완료    | 에이전트가 고치지 않고 말로 답했다          | 답을 읽고 답글이나 해결   |
| 선택 대기    | 에이전트가 고를 거리를 붙여 물었다          | 카드를 눌러 고르거나 답글 |
| 수정 중      | 에이전트가 고치겠다고 답했다                | 기다린다                  |
| 승인 대기    | 수정이 도착해 줄 아래에 겹쳐 보인다         | `승인` 또는 `거절`        |
| 승인됨       | 승인했지만 아직 원래 커밋에 합쳐지지 않았다 | 잘못 눌렀으면 `승인 취소` |
| 접힘         | 승인한 수정이 원래 커밋에 합쳐졌다          | 없음                      |
| 다시 수정 중 | 거절해서 에이전트가 다시 고치고 있다        | 기다린다                  |
| 되돌림       | 리뷰어가 직접 고친 수정을 되돌렸다          | 없음                      |

리뷰어가 단 지적은 첫 글의 휴지통으로 답글까지 통째로 지울 수 있다. 원래 커밋에 이미 접힌 지적은 지울 수 없고 해결로만 닫는다. 지운 지적은 화면에 흔적 없이 사라지지만 저장소에는 지웠다는 기록과 함께 남는다. 그 지적에 fixup이 있으면 wait가 에이전트에게 `[지움]`으로 그 커밋을 빼라고 알리고, 에이전트가 처리하던 지적이면 손을 떼라고 한 번 알린다.

에이전트 차례인 지적을 `difit comment wait`나 세션 메시지로 에이전트에게 넘기면 카드의 상태 표시가 `응답 중`으로 바뀐다. 에이전트가 답글을 달거나 fixup을 올리면 그때의 상태 표시로 돌아간다. 시간 제한이 없으므로, 에이전트가 답 없이 멈췄으면 `응답 중`이 그대로 남는다.

## 답할 차례를 알림으로 받기

`difit comment wait`는 에이전트가 움직일 차례인 지적이 있으면 그 지적을 한 줄에 하나씩 JSON으로 찍고 끝난다. 없으면 생길 때까지 기다린다. 백그라운드로 띄워 두면 끝나는 순간이 곧 알림이다.

```sh
difit comment wait --port <port>
```

```json
{
  "threadId": "7wtlf3qyb0ie1m8c",
  "filePath": "math.js",
  "position": { "side": "new", "line": 6 },
  "message": "빼기로 고쳐 주세요.",
  "state": "rejected",
  "label": "다시 수정 중",
  "rejectedFixupShas": ["afdba2e…"],
  "rejectedFixupSha": "afdba2e…",
  "fixupTarget": "3f1c9e0…"
}
```

- `fixupTarget`은 그 지적에 답할 fixup을 걸 커밋이다. 없으면 리뷰 대상 커밋에 건다.
- 커밋 하나 전체에 단 지적에는 `filePath`가 없고 `"position": { "scope": "commit" }`이다. 이때 `fixupTarget`이 그 커밋이다.
- 리뷰어가 고를 거리 가운데 하나를 골랐으면 `answer`가 붙는다. 아래 「고를 거리를 붙여 묻기」를 본다.
- `position`에 `extraRanges`가 있으면 그 줄들도 같은 지적이다. `line`은 지적을 단 보기에서 가장 아래에서 끝난 범위이고, `extraRanges`는 나머지 범위를 담는다. 카드는 지금 보는 보기에서 가장 아래에서 끝나는 범위 밑에 붙으므로, Unified 보기와 Split 보기에서 자리가 다를 수 있고 `line` 밑이 아닐 수도 있다. 텍스트 출력에는 `파일:L12,L40,L77-L80`처럼 모든 범위가 적힌다. 나머지 범위의 코드는 `codeSnapshot.extraContents`에 같은 순서로 담기므로, 뒤 커밋이 줄을 옮겼으면 범위마다 그 내용으로 자리를 찾는다. 모든 범위를 한 fixup에서 고치고, 답글과 고를 거리를 붙인 답글은 `extraRanges`까지 같은 `position`으로 단다. `line`만 적은 답글은 그 지적에 붙지 않는다. 범위가 지운 쪽과 남은 쪽에 걸치면 `position.side`와 다른 쪽 범위만 `{"side": "old", "start": 12, "end": 14}`처럼 쪽을 적어 `extraRanges`에 담는다. 한 줄이어도 `start`와 `end`를 모두 적고, 줄 번호는 그 쪽 트리의 줄이다. 저장된 `extraRanges`에는 `position.side` 쪽 범위가 먼저 오고 다른 쪽 범위가 뒤에 오며, 쪽마다 위에서부터 적힌다. 답글에는 받은 `position`을 그대로 옮겨 적는다. 이런 지적의 텍스트 출력 위치는 `파일:old:L12-L14,new:L12-L13`처럼 쪽마다 앞에 한 번 쪽을 적고 지운 쪽을 먼저 적으며, 뒤에 `(old)`는 붙지 않는다.
- 알리는 경우는 여섯이다. 리뷰어가 마지막으로 말한 `[답변 대기]`, fixup을 만든 뒤에 리뷰어가 답글을 단 `[승인 대기]`, 승인한 뒤에 리뷰어가 답글을 달았거나 fixup을 만든 뒤에 단 답글에 에이전트가 아직 답하지 않은 `[승인됨]`(뒤의 경우는 승인한 fixup이 아직 범위에 있을 때만), 새 fixup도 그 뒤의 답도 없는 `[다시 수정 중]`, 되돌린 fixup이 아직 남은 `[되돌림]`, 리뷰어가 지운 `[지움]`. `rejectedFixupShas`는 버려야 할 fixup을 모두 담고, `rejectedFixupSha`는 그 가운데 첫째다. 고정할 커밋이 없는 리뷰에서는 리뷰어가 마지막으로 말한 지적을 모두 알린다.
- `[승인 대기]`와 승인 전에 단 답글의 `[승인됨]`은 답글 시각을 fixup의 author date와 견준다. 리뷰어의 브라우저와 fixup을 만든 컴퓨터의 시계가 어긋나면 fixup 직후에 단 답글이 오지 않거나, fixup으로 이미 답한 지적이 다시 올 수 있다. 다시 온 지적에는 말로 답하면 더 오지 않는다.
- 띄우자마자 지금 차례인 지적을 모두 찍으므로, 두 번 띄우는 사이에 생긴 지적도 놓치지 않는다. 답한 뒤 다시 띄운다. 답하지 않은 지적은 다시 띄우자마자 또 나온다.
- 리뷰가 끝나면 아무것도 찍지 않고 0으로 끝난다. 연결이 끊기면 10초 동안 다시 붙고, 그래도 안 되면 오류를 찍고 1로 끝난다.

Claude Code 세션이 띄운 difit(`--background` 포함)은 세션의 메시지 소켓(`CLAUDE_CODE_MESSAGING_SOCKET`)을 물려받아, 리뷰어가 화면에서 저장해 새로 에이전트 차례가 된 지적을 그 세션에 메시지로 바로 넣는다. 첫 줄은 `difit review: your turn on <threadId> [<상태>]; read with difit comment get --port <port> --format json`이고, 이어지는 줄은 wait와 같은 JSON이다. 에이전트가 단 코멘트, 리뷰어가 직접 고친 fixup, 승인과 승인 취소는 보내지 않는다. 다만 에이전트가 아직 답하지 않은 지적은 승인이나 승인 취소로 상태가 바뀌거나 리뷰어가 마지막 답글을 고치면 새 상태나 고친 본문으로 다시 보낸다. 에이전트가 답한 뒤에 리뷰어가 앞선 답글을 고치면 다시 보내지 않는다. `comment get` 텍스트 출력은 고친 답글마다 그 위에 `고친 시각:`을 적는다. 소켓에 닿지 못하면 stderr에 한 줄 남기고 리뷰를 이어 간다. 이 메시지 형식은 Claude Code 문서에 없어 형식이 바뀌면 조용히 사라질 수 있으므로 wait도 함께 띄워 둔다. 직접 띄운 difit에는 소켓이 없으므로 wait만 쓴다. 이유는 [docs/adr/0005](adr/0005-tell-the-agent-when-it-is-its-turn.md)에 있다.

## 지적에 답하기

1. 지적과 스레드 id를 읽는다. 텍스트 출력에는 id가 없으므로 JSON으로 읽는다.

   ```sh
   difit comment get --port <port> --format json
   ```

   JSON에는 이미 해결된 스레드도 들어 있다. `decisions`에서 그 스레드의 `resolved`·`unresolved` 기록 가운데 가장 나중 것이 `resolved`이면 건너뛴다. `comment resolve`로 해결한 스레드도 같은 식으로 목록에 남는다. `comment resolve`와 `remove`는 모든 글의 작성자가 `Agent`이고 리뷰어가 다시 연 적 없는 스레드만 닫는다. 리뷰어가 단 지적, GitHub에서 가져온 지적, 다른 작성자로 단 지적, 리뷰어가 답글을 달거나 다시 연 지적은 기록을 남기지 않고 종료 코드 1로 거부하며 출력의 `errors`에 어느 ID인지 적는다. 그런 지적은 리뷰어가 ✓를 누르거나 fixup을 승인할 때까지 열려 있으므로, 고치거나 답글로 답하고 닫지 않는다. 리뷰어가 ✓로 이미 닫은 지적은 기록을 더 남기지 않고 `resolved`로 알려 준다. 한 번에 여러 ID를 주면 닫을 수 있는 것은 닫고 나머지만 거부한다. 서버의 HTTP API에는 이 검사가 없고, 에이전트가 잘못 친 명령을 막는 장치일 뿐 보안 경계가 아니다.

   리뷰어가 커밋 하나나 커밋 범위를 보며 단 지적에는 필드가 둘 더 있다. `view`는 지적을 단 화면의 기준(`baseCommitish`)과 대상(`targetCommitish`)이고, `fixupTarget`은 fixup을 걸 커밋의 SHA다. 전체 화면에서 단 지적에는 `fixupTarget`만 있다. 텍스트 출력에도 그 지적의 위치 줄 바로 아래에 `고쳐 넣을 커밋: <짧은 SHA> <제목>`이 붙는다. `view`가 없는 지적은 전체 화면에서 단 지적이다.

   범위나 전체 화면에서 단 지적의 `fixupTarget`은 그 화면의 커밋 가운데 그 줄을 마지막으로 바꾼 커밋이다. 줄들이 여러 커밋에서 왔으면 가장 최근 커밋이다. 지운 쪽과 남은 쪽에 걸친 지적은 남은 쪽 줄만 본다. 지운 줄만 있거나 그 화면의 커밋이 바꾸지 않은 줄이면 그 화면의 마지막 커밋이다. 앞 회차의 fixup 커밋처럼 커밋 목록에 없는 커밋이 고친 줄은, 그 줄을 원래 만든 커밋으로 친다. 리뷰 범위에는 없고 fixup에서만 수정한 파일에 단 지적의 `fixupTarget`은 그 fixup이 합쳐질 커밋이다. 그 커밋이 리뷰 범위에 없으면 그 fixup이 답한 지적의 `fixupTarget`이고, 답한 지적에도 그 값이 없으면 리뷰 대상 커밋이다. `fixupTarget`이 없는 지적은 이 규칙이 생기기 전에 달았거나, 지적을 달 때 서버가 대상을 정하지 못한 지적이다.

   - 줄 번호는 `view` 트리의 줄이다. 새 쪽(`"side": "new"`) 줄은 `git show <view.targetCommitish>:<파일>`, 옛 쪽 줄은 `git show <view.baseCommitish>:<파일>`로 읽는다. `view`가 없으면 리뷰 대상 커밋의 줄이다. fixup에서만 수정한 파일에 단 지적은 `codeSnapshot.commit`이 그 fixup 커밋이다. 새 쪽 줄은 `git show <codeSnapshot.commit>:<파일>`, 옛 쪽 줄은 그 fixup의 부모 커밋인 `git show <codeSnapshot.commit>^:<파일>`로 읽는다.
   - 고치는 곳은 HEAD의 파일이다. 뒤 커밋이 그 줄을 옮기거나 바꿨을 수 있으니 줄 번호 대신 `codeSnapshot.content`(지적한 줄의 내용)로 자리를 찾는다. 뒤 커밋이 그 줄을 바꿨어도 fixup은 하나만 만든다([docs/adr/0002](adr/0002-one-fixup-per-target-commit.md)). 접을 때 생기는 충돌은 아래 「범위 중간 커밋에 접다가 충돌하면」대로 푼다.
   - 파일 전체에 단 지적은 위치가 `"position": { "side": "new", "scope": "file" }`이고 `line`이 없다. diff가 지운 파일이면 `"side": "old"`이다. 텍스트 출력의 위치 줄에는 `:L<줄>` 없이 파일 경로만 나오고, 지운 파일이면 뒤에 `(old)`가 붙는다. 특정 줄이 아니라 파일 전체에 대한 지적이므로 파일을 통째로 읽고 지적이 가리키는 곳을 고치되, fixup은 역시 하나만 만든다. 이 지적의 `fixupTarget`은 그 화면의 커밋 가운데 그 파일을 마지막으로 바꾼 커밋이고, 그런 커밋이 없으면 그 화면의 마지막 커밋이다. 커밋 목록에 없는 커밋이 바꾼 것은 세지 않는다. 답글은 같은 `position`으로 단다([docs/adr/0010](adr/0010-file-level-comments.md)).
   - 커밋 하나 전체에 단 지적은 `filePath`가 없고 위치가 `"position": { "scope": "commit" }`이며, `fixupTarget`이 그 커밋이다. 커밋 메시지, 커밋이 다루는 범위, 커밋을 나누거나 합치자는 이야기처럼 특정 파일이 아니라 그 커밋에 대한 지적이다. 텍스트 출력의 위치 줄은 `커밋 <짧은 SHA> <제목>`이고, `고쳐 넣을 커밋:` 줄은 따로 붙지 않는다. 코드나 메시지를 고쳐 답할 수 있으면 다른 지적처럼 그 커밋을 향한 `fixup!`이나 `amend!` 하나에 `Review-Thread` 트레일러를 붙인다. 커밋을 나누거나 순서를 바꾸자는 것처럼 fixup 하나로 답할 수 없는 요청이면 고치지 말고 답글로 어떻게 할지 묻는다. 답글은 `{"type": "reply", "position": {"scope": "commit"}, "fixupTarget": "<SHA>", "body": "..."}`처럼 `filePath` 없이 같은 `fixupTarget`으로 단다([docs/adr/0011](adr/0011-commit-level-comments.md)).

2. 코드를 고친 뒤 fixup 커밋을 만들고 스레드 id를 트레일러로 붙인다. 대상은 지적의 `fixupTarget`이고, 없으면 리뷰 대상 SHA다.

   ```sh
   git commit -a --fixup=<지적의 fixupTarget, 없으면 리뷰 대상 SHA> --trailer "Review-Thread: <threadId>"
   ```

   git이 오래돼 `--trailer`를 모르면 트레일러 줄을 메시지로 직접 넣는다. `fixup!` 제목 아래에 빈 줄을 두고 붙으므로 화면이 똑같이 읽는다.

   ```sh
   git commit -a --fixup=<지적의 fixupTarget, 없으면 리뷰 대상 SHA> -m "Review-Thread: <threadId>"
   ```

   `--fixup`은 제목을 `fixup! <대상 커밋 제목>`으로 쓰고, 접을 때는 범위 안에서 그 제목을 가진 가장 오래된 커밋에 접힌다. 대상보다 앞에 같은 제목의 커밋이 있으면 수정이 그 커밋으로 들어가 버리므로, 먼저 확인한다.

   ```sh
   git log --format=%s <리뷰 범위의 시작 커밋>..<fixupTarget>^ | grep -Fx "$(git log -1 --format=%s <fixupTarget>)"
   ```

   무언가 찍히면 제목 대신 SHA로 대상을 적는다. 리뷰어가 화면에서 직접 고친 fixup과 같은 모양이다([docs/adr/0003](adr/0003-reviewer-edits-become-fixups.md)).

   ```sh
   git commit -a -m "fixup! <fixupTarget 전체 SHA>" --trailer "Review-Thread: <threadId>"
   ```

   - 지적 하나에는 고쳐 넣을 커밋마다 fixup 커밋을 하나만 둔다. 한 지적을 고치느라 여러 커밋을 손대야 하면 커밋마다 fixup을 하나씩 만들고 모두 같은 `Review-Thread` 트레일러를 단다. 지적한 줄 밖의 수정을 고쳐 넣을 커밋은 리뷰 범위에서 그 줄을 마지막으로 바꾼 커밋이다(`git blame <리뷰 대상 커밋> -- <파일>`). 범위보다 오래된 커밋이 나오면 리뷰 대상 커밋으로 한다. 화면은 그 fixup들을 지적 밑에 모두 보이고, 리뷰어는 묶음 전체를 한 번에 승인하거나 거절한다.
   - fixup을 만들기 직전에 `comment get`을 다시 읽어 그 지적이 아직 `[답변 대기]`, `[답변 완료]`, `[수정 중]`, `[다시 수정 중]` 가운데 하나인지 확인한다. 그사이 리뷰어가 화면에서 직접 고쳤다면 같은 곳을 두 번 고치게 된다.
   - 판정 전에 같은 지적을 또 고쳤다면 새 커밋을 만들지 말고, 같은 커밋에 고쳐 넣는 앞의 fixup 커밋에 합친다. 그 커밋이 맨 위면 `git commit -a --amend --no-edit`, 아니면 `git rebase -i`에서 그 커밋을 `edit`한다.
   - 지적 여러 개를 고쳤으면 지적마다 fixup 커밋을 따로 만든다.

3. 리뷰어가 거절하면 `comment get --format json`의 `decisions`에 `"kind": "rejected"`와 그 fixup의 SHA가 남는다. 거절된 fixup 커밋은 버리고(`git rebase -i`에서 `drop`) 새로 고쳐 다시 만든다. 버리기 전에 rebase로 그 fixup 바로 옆 줄이 바뀌면 거절 표시가 풀릴 수 있으니, 거절된 fixup부터 버린다.

4. 리뷰어가 직접 고친 fixup을 `되돌리기`로 거절했을 때도 같은 방법으로 버린다. 리뷰어가 직접 고치면서 연 스레드는 텍스트 출력에 `[되돌림]`이 붙는데, 이때는 fixup만 곧바로 버리고 다시 고치지 않는다. 버리기 전까지는 wait가 그 지적을 계속 알린다. 원래 있던 지적에 리뷰어가 직접 고쳐 답했다가 되돌렸으면 `[다시 수정 중]`이 붙으니, 여느 거절처럼 버리고 새로 고친다.

   리뷰어는 지적 아래 fixup 카드 안에서도 줄을 고친다. 그러면 같은 `Review-Thread` 트레일러와 같은 대상 커밋으로 리뷰어의 fixup이 에이전트의 fixup 위에 하나 더 생기고, 두 fixup이 함께 승인되어 지적이 닫힌다. 에이전트가 할 일은 없다. 리뷰어가 이 수정을 `되돌리기`로 거절하면 지적은 `[승인 대기]`로 돌아가 리뷰어가 에이전트의 fixup을 다시 판정하고, wait는 이 지적을 알리지 않는다. 되돌린 fixup은 `decisions`의 `rejected`로만 남으니 마무리 때 다른 거절된 fixup과 함께 버린다.

5. 리뷰어가 커밋 목록에서 커밋 메시지를 고치면, difit은 파일을 바꾸지 않는 `amend! <대상 SHA>` 커밋을 HEAD 위에 만들고 승인으로 기록한다. 그 커밋 메시지의 첫 문단 아래가 새 메시지이고, 끝에 `Review-Thread` 트레일러가 붙는다. 스레드는 새로 열리고 `filePath`가 `/COMMIT_MSG`(1번 줄), `fixupTarget`이 메시지를 고친 커밋, author가 `reviewer-edit`이다. 접을 때까지 할 일은 없다.

## 어느 지적에 답하는지 지정하기

답글(`"type": "reply"`)은 기본으로 `filePath`와 `position`이 같은 지적을 찾아 붙는다. 같은 자리에 지적이 둘 이상이면 `comment get`이나 `comment wait`가 준 `threadId`를 답글에 `"threadId"`로 실어 어느 지적에 답하는지 정한다. 답글은 그 지적에만 붙고, 같은 글을 이미 올렸는지도 그 지적 안에서만 본다. 그래서 답을 단 지적이 해결된 뒤 다시 올려도 옆 지적으로 복사되지 않고, 같은 자리 두 지적에 같은 글로 답해도 둘 다 남는다.

`threadId`가 없는 지적이거나 답글을 받지 않는 지적(지운 지적)이면 답글은 저장하지 않고 `warnings`에 알린다. 답글의 `filePath`와 `position`이 그 지적과 다르면 `threadId`를 믿고 그 지적에 붙이되 `warnings`에 알린다. `threadId`는 답글에만 쓸 수 있다.

## 고를 거리를 붙여 묻기

리뷰어가 정해야 할 것이 있으면 답글에 고를 거리를 붙인다. 리뷰어는 지적 카드 안에서 카드 하나를 눌러 고른다. 답글(`"type": "reply"`)에만 붙일 수 있다.

```sh
difit comment add --port <port> '{
  "type": "reply",
  "filePath": "src/server/fixup-overlay.ts",
  "position": { "side": "new", "line": 40 },
  "body": "설정을 넣겠습니다. 설정 키 모양을 하나 골라 주세요.",
  "choices": [
    { "id": "A", "name": "최상위 불리언 fixupOverlay", "description": "가장 단순합니다." },
    {
      "id": "B",
      "name": "review.overlay.enabled 묶음",
      "description": "다른 리뷰 설정과 같은 자리에 놓입니다.",
      "preview": { "label": "~/.difit/config.json", "text": "{\n  \"review\": { \"overlay\": { \"enabled\": false } }\n}" },
      "recommended": true
    }
  ]
}'
```

- `id`, `name`, `description`은 반드시 넣는다. `id`는 그 답글 안에서 겹치지 않아야 한다. `preview`(`label`은 빼도 된다)와 `recommended`는 넣고 싶을 때만 넣는다. 미리 보기는 카드에 세 줄까지 보이고 나머지는 `더 보기`로 펼친다. `recommended`를 단 카드에는 `추천`이 붙는다.
- 고를 거리를 단 답글 뒤에 리뷰어가 아무 글도 달지 않았으면 지적이 `[선택 대기]`다. `[답변 완료]`처럼 리뷰어 차례이고, 그 뒤에 고를 거리 없는 답글을 더 달아도 그대로다. 다만 리뷰어가 아직 고르지도 답하지도 않았을 때 고치겠다는 표시(`"fixPending": true`)를 단 답글이 오면 고를 거리는 닫히고, 그 답글이 마지막인 동안 지적은 `[수정 중]`이다. 고를 수 있는 것은 가장 최근에 단 고를 거리뿐이다. 새 고를 거리를 단 답글을 달면 앞의 고를 거리는 닫힌다.
- 리뷰어가 고르면 `고름: B — <name>` 답글이 달리고, 그 답글에 `"answer": { "messageId": "<고를 거리를 단 답글 id>", "choice": "B" }`가 붙는다. 고른 것을 바꾸면 앞 답글은 그대로 두고 `바꿈: C — <name>` 답글이 새로 달린다. 어느 쪽이든 여느 리뷰어 답글처럼 에이전트 차례가 되어 wait와 세션 메시지가 그 답글을 `message`와 `answer`로 알린다. 마지막에 고른 것을 따른다.
- 리뷰어가 고르지 않고 답글 칸에 글로 답할 수도 있다. 그때는 `answer` 없는 여느 답글이 온다.
- 텍스트 출력은 고를 거리를 단 답글 아래에 `Choices:` 목록을, 고른 답글 아래에 `Picked B from Reply <n>`을 붙인다.

## 승인된 수정 접기와 기록 올리기

브랜치를 마무리할 때 한 번에 접는다. `--autosquash`는 범위 안의 fixup을 모두 접으므로, 남은 fixup이 전부 승인되고 거절된 fixup을 모두 버린 뒤에 돌린다. 리뷰어가 지운 지적의 fixup도 먼저 버린다. 지운 지적은 텍스트 출력에 나오지 않으므로, JSON `decisions`에서 `"kind": "deleted"`인 지적을 찾아 그 지적을 `Review-Thread` 트레일러로 단 fixup을 버린다.

승인 여부는 `difit comment get --port <port>` 텍스트 출력에서 지적마다 붙는 `[승인됨]`으로 확인한다. JSON의 `decisions`는 판정을 지우지 않고 쌓기만 한다. fixup이 여럿인 지적을 승인하면 fixup마다 `approved`가 같은 시각으로 하나씩 쌓인다. 리뷰어가 승인을 취소하면 `"kind": "unapproved"`가 더해지므로, 같은 지적의 `approved`와 `unapproved` 가운데 시각이 늦은 쪽이 지금의 판정이다. 다만 승인한 fixup에 그보다 늦은 `rejected`가 있으면 거절이 우선한다. 리뷰어가 직접 고친 수정을 `되돌리기`로 거절하면 이렇게 남는다.

git이 2.32보다 오래되었으면(`git --version`) 아래 접기 명령에 `--keep-empty`를 붙이고, 접은 뒤의 `Review-Thread` 줄 지우기 명령은 돌리지 않는다. `--keep-empty`를 빼면 리뷰어가 고친 커밋 메시지가 사라지고, 줄 지우기 명령도 `--keep-empty` 없이 rebase하므로 남겨 둔 `amend!` 커밋을 다시 버린다. 그 대신 할 일은 아래 git 2.32 문단에 있다.

```sh
git rev-parse HEAD   # 찍힌 SHA를 <접기 전 SHA>로 적어 둔다
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <리뷰 범위의 시작 커밋>
```

접기 전 SHA는 셸 변수에 담지 말고 적어 둔다. 명령을 한 번씩 따로 돌리는 에이전트에게는 앞 명령의 셸 변수가 남지 않는다. 접기는 커밋을 다시 나눌 뿐 마지막 파일 내용은 바꾸지 않으므로, 접은 뒤 `git diff --exit-code <접기 전 SHA> HEAD`가 아무것도 찍지 않아야 한다.

`amend!` 커밋은 첫 문단 아래를 트레일러까지 그대로 대상 커밋의 메시지로 쓴다. 그래서 접은 뒤의 메시지에 `Review-Thread` 줄이 남는다. 이 줄이 남은 커밋은 나중 리뷰에서 fixup으로 읽혀 커밋 목록에서 빠지므로, git 2.32 이상에서는 접은 직후 기록을 올리기 전에 지운다. 아래 명령은 그 줄이 있는 커밋만 고쳐 쓴다([docs/adr/0009](adr/0009-reviewer-rewords-become-amend-commits.md)).

```sh
git rebase <리뷰 범위의 시작 커밋> --exec 'git log -1 --format=%B | grep -q "^Review-Thread: " || exit 0; git log -1 --format=%B | sed "/^Review-Thread: /d" | git commit -q --amend --allow-empty --no-verify --cleanup=whitespace -F -'
```

`amend!`를 접으려면 git 2.32 이상이 필요하다. 그보다 오래된 git은 `amend!`를 알아보지 못하고, 파일을 바꾸지 않는 커밋이라 위 접기 명령에서 아무 말 없이 버린다. 파일 내용은 그대로라 `git diff` 확인도 통과하므로, 리뷰어가 고친 메시지가 사라져도 드러나지 않는다. 그래서 이 git에서는 접기 명령에 `--keep-empty`를 붙여 `amend!` 커밋을 남긴다. 그다음 `git rebase -i <리뷰 범위의 시작 커밋>`에서 `amend!` 커밋을 `drop`하고, 대상 커밋을 `reword`해 `git log -1 --format=%B <amend! SHA> | sed '1,/^$/d; /^Review-Thread: /d'`가 찍는 메시지로 바꾼다. 이렇게 바꾼 메시지에는 `Review-Thread` 줄이 없으므로 위의 줄 지우기 명령은 돌리지 않는다. `--keep-empty` 없이 이미 접었다면 `amend!` 커밋은 `git log --format='%H %s' <리뷰 범위의 시작 커밋>..<접기 전 SHA> | grep ' amend! '`로 찾는다. 대상 커밋은 접으면서 SHA가 바뀌었으니 제목으로 찾아 같은 방법으로 `reword`한다.

리뷰 범위의 시작 커밋은 diff의 비교 기준이다. 커밋 하나만 주고 연 리뷰라면 그 커밋의 부모(`<SHA>^`)이다. 커밋 여러 개를 한꺼번에 본 리뷰에서는 커밋 하나를 보며 단 지적의 fixup과 리뷰어가 직접 고친 fixup이 범위 중간의 커밋을 향할 수 있으므로, 리뷰 대상 커밋이 아니라 범위의 시작점부터 돌려야 모두 접힌다.

fixup이 대상 커밋이 넣은 내용을 전부 지우면 그 커밋이 비게 되어 rebase가 `Could not apply ... fixup!`에서 멈춘다. 빈 커밋으로 남기려면 `git commit --amend --allow-empty --no-edit`, 커밋째 없애려면 `git reset --soft HEAD^`를 한 뒤 `git rebase --continue`로 잇는다.

리뷰어가 직접 고친 fixup은 SHA로 대상을 가리킨다(`fixup! <SHA>`). 접기 전에 대상 커밋이 rebase로 새 SHA를 받으면 짝을 찾지 못해 접히지 않고 남으므로, 기준 브랜치를 따라잡는 rebase나 대상 커밋의 메시지 수정은 접은 뒤에 한다. rebase는 짝을 못 찾아도 성공으로 끝나므로, 접은 뒤에 아래 명령이 아무것도 출력하지 않는지 확인한다.

```sh
git log --format='%h %s' <리뷰 범위의 시작 커밋>..HEAD | grep -E '^[0-9a-f]+ (fixup|squash|amend)! '
```

남은 fixup이 있으면 짝 커밋을 골라 `git rebase -i`에서 fixup을 그 커밋 바로 아래로 옮기고 `fixup`으로 바꾼다. 지적에 `fixupTarget`이 있으면 그 커밋이 짝이다. 없으면 이렇게 찾는다. fixup 본문 첫 줄에는 fixup을 만들 때의 대상 커밋 제목이 적혀 있다. 그 사이 제목이 바뀌었거나 같은 제목의 커밋이 여럿이면, `git show <fixup SHA>`로 무엇을 고쳤는지 보고 `git blame <fixup SHA>^ -- <파일>`로 그 자리의 줄을 넣은 커밋을 확인한다. 리뷰 범위보다 앞의 커밋이 나오면 짝은 리뷰 대상 커밋이다.

접으면 fixup 커밋이 사라지므로, 어떤 수정이 어느 커밋으로 들어갔는지를 실행 중인 서버에 기록한다. 지적마다 옛 fixup SHA와 접힌 뒤의 새 커밋 SHA를 짝지어 올린다.

접은 뒤의 새 커밋은 순서로 찾는다. 범위에 머지 커밋이 없으면 접기는 fixup만 없애고 다른 커밋의 순서는 그대로 두므로, 아래 두 목록에서 같은 줄에 있는 SHA가 같은 커밋이다. 예를 들어 `fixupTarget`이 앞 목록의 두 번째 줄이면, 뒤 목록의 두 번째 줄이 접힌 뒤의 SHA다.

```sh
git rev-list --reverse <리뷰 범위의 시작 커밋>..<리뷰 대상 SHA>  # 접기 전
git rev-list --reverse <리뷰 범위의 시작 커밋>..HEAD             # 접은 뒤
```

```sh
curl -X POST "http://localhost:<port>/api/decisions" \
  -H 'Content-Type: application/json' \
  -d '[{"threadId":"<threadId>","kind":"folded","fixupSha":"<옛 fixup SHA>","targetSha":"<접힌 뒤 커밋 SHA>","at":"2026-09-23T10:00:00Z"}]'
```

응답이 `{"success":true,"changed":true,...}`면 받은 것이다. 같은 기록을 다시 보내도 중복으로 쌓이지 않는다. 본문이 배열이 아니거나 필드가 빠진 기록이 하나라도 있으면 아무것도 기록하지 않고 400으로 답한다.

### 범위 중간 커밋에 접다가 충돌하면

fixup이 범위 중간의 커밋을 향하고 그 뒤 커밋이 같은 줄을 바꿨으면, fixup은 HEAD의 줄을 고친 것이라 rebase가 두 번 멈춘다. 도구가 대신 풀지 않으므로 아래처럼 손으로 푼다. 지적한 커밋을 바꾸지 않는다. 리뷰어가 그 커밋을 골라 지적했고, 승인도 그 커밋에 접는다는 뜻이기 때문이다.

1. 먼저 fixup에서 `Could not apply <fixup SHA>... fixup! <대상 커밋 제목>`으로 멈춘다. 충돌 표시의 `HEAD` 쪽이 대상 커밋의 줄이고, 다른 쪽이 HEAD 기준으로 고친 줄이다. 대상 커밋의 줄에 지적한 수정만 더한다. 뒤 커밋이 바꾼 내용은 넣지 않는다.
2. `git add <파일>` 뒤 `GIT_EDITOR=true git rebase --continue`로 잇는다. 이때 git이 합친 커밋 메시지를 고치라고 편집기를 여는데, `GIT_EDITOR=true`는 대상 커밋의 메시지를 그대로 쓰고 fixup의 제목과 트레일러를 버린다.
3. 이어서 뒤 커밋에서 `Could not apply <SHA>... <그 커밋 제목>`으로 멈춘다. 이번에는 `HEAD` 쪽이 1에서 고친 줄이고, 다른 쪽이 그 커밋이 원래 만들었던 줄이다. 고친 줄 위에 그 커밋이 하던 변경을 다시 얹는다. 같은 방법으로 `git add`와 `GIT_EDITOR=true git rebase --continue`를 한다. 같은 줄을 바꾼 뒤 커밋이 더 있으면 그 커밋에서도 멈출 수 있으니 같은 방법으로 푼다.
4. rebase가 끝나면 `git diff --exit-code <접기 전 SHA> HEAD`를 돌린다. 무언가 찍히면 푼 결과가 접기 전과 다르다는 뜻이다. `git reset --hard <접기 전 SHA>`로 되돌리고(아직 rebase 중이면 `git rebase --abort`), 그 지적에 `comment add`로 답글을 달아 어떻게 할지 리뷰어에게 묻는다.

## 접은 뒤의 커밋으로 지적 옮기기

접으면 리뷰 대상 커밋의 SHA가 바뀐다. 새 SHA로 리뷰를 다시 열면 지적은 옛 SHA의 리뷰에 남아 있으므로, 옛 서버에서 꺼내 새 서버에 넣는다. `comment get`은 지적마다 메시지를 배열로 주고 `comment add`는 첫 메시지를 `thread`, 나머지를 `reply`로 받으므로 모양을 바꿔 넣는다. 지적 id와 `codeSnapshot`(줄 내용과 지적을 단 커밋)을 그대로 실어야 fixup 트레일러와 결정 기록이 같은 지적을 가리키고, 화면이 지적의 자리를 다시 찾을 수 있다. 커밋 하나를 보며 단 지적의 `view`와 `fixupTarget`도 함께 싣는다. 답글도 id와 `choices`, `answer`를 그대로 실어야 고른 답글이 어느 답글의 고를 거리를 골랐는지 이어진다.

```sh
difit comment get --port <옛 port> --format json > old.json

difit comment add --port <새 port> "$(jq '[.threads[] | . as $t
  | ($t.messages[0] | {type: "thread", id: $t.id, filePath: $t.filePath, position: $t.position,
                       body, author, createdAt, codeSnapshot: $t.codeSnapshot,
                       view: $t.view, fixupTarget: $t.fixupTarget}),
    ($t.messages[1:][] | {type: "reply", id, filePath: $t.filePath, position: $t.position,
                          fixupTarget: $t.fixupTarget, body, author, createdAt, choices, answer})
  | with_entries(select(.value != null))]' old.json)"

jq '.decisions' old.json | curl -X POST "http://localhost:<새 port>/api/decisions" \
  -H 'Content-Type: application/json' -d @-
```

옮겨 온 `view`와 `fixupTarget`은 접기 전의 SHA를 그대로 가리킨다. 그래서 새 리뷰에서 이런 지적은 커밋 하나를 보는 화면에는 보이지 않고 전체 화면에만 보이며, 카드에는 짧은 SHA만 보이고 마우스를 올려도 제목이 나오지 않으며, 텍스트 출력의 `고쳐 넣을 커밋:` 줄에도 제목 없이 짧은 SHA만 나온다. 아직 답하지 않은 지적이면, 위의 순서 대응으로 찾은 새 SHA에 fixup을 건다.

새 커밋의 화면은 옮겨 온 지적을 이렇게 놓는다.

- 저장한 줄 내용과 똑같은 줄이 보이는 줄 가운데 한 곳뿐이면, 줄 번호가 밀렸어도 그 줄로 옮긴다.
- 그 내용이 사라졌거나 `}`처럼 여러 곳에 있으면 `낡음`으로 두고 수정을 겹쳐 그리지 않는다. 비슷한 자리에 끼워 맞추지 않는다.
- 낡은 지적에는 `이 지적을 달던 시점으로` 단추가 뜨고, 누르면 지적을 단 커밋으로 리뷰를 다시 연다.

이 단추에는 한계가 있다. 옛 리뷰의 지적은 브라우저 저장소에 남아 있으므로, 옛 리뷰를 본 브라우저에서 같은 저장소 폴더를 같은 주소(포트)로 열었을 때만 지적이 함께 보인다. 돌아가도 fixup은 이미 접혀 없으므로 어떻게 고쳤는지는 보이지 않는다.
