<h1 align="center">
  <img src="public/logo.png" alt="difit" width="260">
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/difit"><img src="https://img.shields.io/npm/v/difit.svg" alt="npm version"></a>
  <a href="https://github.com/yoshiko-pg/difit/actions/workflows/pr.yml"><img src="https://github.com/yoshiko-pg/difit/actions/workflows/pr.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  English | <a href="./README.ja.md">日本語</a> | <a href="./README.zh.md">简体中文</a> | <a href="./README.ko.md">한국어</a>
</p>

![difit screenshot](docs/images/screenshot.png)

**difit** is a CLI tool that lets you view and review local git diffs with a GitHub-style viewer. In addition to clean visuals, comments can be copied as prompts for AI. The local code review tool for the AI era!

## ⚡ Quick Start

Try it first

```bash
npx difit  # View the latest commit diff in WebUI
```

Install and use

```bash
npm install -g difit
difit  # View the latest commit diff in WebUI
```

Enable use from AI agents

```bash
npx skills add yoshiko-pg/difit # Add the Skills to your agent
```

Installed skills include:

- `difit`: ask the user for a review in the difit viewer when the user explicitly opts in to difit
- `difit-review`: review a specific diff or PR and show the findings inside the difit viewer, when the user explicitly asks for difit

## 🚀 Usage

### Basic Usage

```bash
difit <target>                    # View single commit diff
difit <target> [compare-with]     # Compare two commits/branches
```

### Single commit review

```bash
difit          # HEAD (latest) commit
difit 6f4a9b7  # Specific commit
difit feature  # Latest commit on feature branch
```

### Compare two commits

```bash
difit @ main         # Compare with main branch (@ is alias for HEAD)
difit feature main   # Compare branches
difit . origin/main  # Compare working directory with remote main
```

### Special Arguments

difit supports special keywords for common diff scenarios:

```bash
difit .        # All uncommitted changes (staging area + unstaged)
difit staged   # Staging area changes
difit working  # Unstaged changes only
```

### GitHub PR

```bash
difit --pr https://github.com/owner/repo/pull/123
```

`--pr` mode fetches patches by running `gh pr diff --patch` under the hood.
It also imports unresolved inline review threads from the PR so they appear as startup comments in difit.

Authentication is handled by GitHub CLI:

1. **Login once** (recommended): `gh auth login`
2. **Token-based auth** (CI/non-interactive): set `GH_TOKEN` or `GITHUB_TOKEN`

#### GitHub Enterprise Server

For Enterprise Server PRs, authenticate GitHub CLI against your Enterprise host:

1. `gh auth login --hostname YOUR-ENTERPRISE-SERVER`
2. Or set `GH_HOST=YOUR-ENTERPRISE-SERVER` with `GH_TOKEN`/`GITHUB_TOKEN`

### Initial Comments

You can inject initial review comments when launching difit:

```bash
difit --comment '{"type":"thread","filePath":"src/example.ts","position":{"side":"new","line":10},"body":"The background for this change is..."}'
```

`--comment` is repeatable and accepts either a single JSON object or a JSON array. Supported types:

- `thread`: create a new thread at the specified diff position
- `reply`: add a reply to the latest existing thread at the same diff position

If the same comment already exists, difit skips importing it.

### Stdin

By using a pipe to pass unified diffs via stdin, you can view diffs from any tool with difit.

```bash
# View diffs from other tools
diff -u file1.txt file2.txt | difit

# Review saved patches
cat changes.patch | difit

# Compare against merge base
git diff --merge-base main feature | difit

# Review an entire existing file as newly added
git diff -- /dev/null path/to/file | difit

# Explicit stdin mode
git diff --cached | difit -
```

Stdin mode is selected with intent-first rules:

- `-` explicitly enables stdin mode
- If positional arguments (`<target>` / `[compare-with]`) or `--pr` are provided, difit treats the command as Git/PR mode and does not auto-read stdin
- Auto stdin detection applies only when no explicit mode is selected and stdin is a pipe/file/socket

## ⚙️ CLI Options

| Flag                  | Default         | Description                                                                                             |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `<target>`            | HEAD            | Commit hash, tag, HEAD~n, branch, or special arguments                                                  |
| `[compare-with]`      | -               | Optional second commit to compare with (shows diff between the two)                                     |
| `--merge-base`        | false           | Resolve the base revision with `git merge-base` before diffing (Git revision mode only)                 |
| `--pr <url>`          | -               | GitHub PR URL to review (e.g., https://github.com/owner/repo/pull/123)                                  |
| `--comment <json>`    | -               | Inject initial comments (repeatable; accepts a JSON object or array)                                    |
| `--port`              | 4966            | Preferred port; falls back to +1 if occupied                                                            |
| `--host`              | 127.0.0.1       | Host address to bind server to (use 0.0.0.0 for external access)                                        |
| `--no-open`           | false           | Don't automatically open browser                                                                        |
| `--clean`             | false           | Clear all existing comments and viewed files on startup                                                 |
| `--include-untracked` | false           | Automatically include untracked files in diff (only with `.` or `working`)                              |
| `--keep-alive`        | false           | Keep server running after browser disconnects (stop manually with Ctrl+C)                               |
| `--background`        | false           | Keep the server running in the background and output JSON connection info                               |
| `--context <lines>`   | git default (3) | Limit surrounding context lines per change (`0` shows changes only; not available with `--pr` or stdin) |

## 💬 Comment System

difit includes a review comment system that makes it easy to provide feedback to AI coding agents:

1. **Add Comments**: Click the comment button on any diff line or drag to select a range
2. **Edit Comments**: Edit existing comments with the edit button
3. **Generate Prompts**: Comments include a "Copy Prompt" button that formats the context for AI coding agents
4. **Copy All**: Use "Copy All Prompt" to copy all comments in a structured format
5. **Persistent Storage**: Comments are saved in browser localStorage per commit

### Comment Prompt Format

```sh
src/components/Button.tsx:L42   # This line is automatically added
Make this variable name more descriptive
```

For range selections:

```sh
src/components/Button.tsx:L42-L48   # This line is automatically added
This section is unnecessary
```

## 🍴 이 포크에서 달라진 것

이 포크는 에이전트가 짠 브랜치를 사람이 리뷰하고 에이전트가 그 지적을 고쳐 오는 일을 difit 한 화면에서 끝까지 하려고 원래 difit에 기능을 더했다. 원래 difit은 지적을 복사해 에이전트에게 붙여 넣는 데서 끝나지만, 이 포크에서는 에이전트가 고친 것이 지적이 달린 줄 아래에 바로 나타난다.

### 설치

main에 병합할 때마다 GitHub 릴리스가 새로 올라온다. 최신 빌드는 아래 한 줄로 깐다.

```bash
npm i -g https://github.com/Inte-H/difit/releases/latest/download/difit.tgz
```

특정 빌드를 깔려면 `https://github.com/Inte-H/difit/releases/download/v<버전>/difit-<버전>.tgz`를 쓴다. 버전은 `5.0.12-inteh.3`처럼 원래 difit 버전 뒤에 포크 표시가 붙는다.

### 자동 업데이트

릴리스로 깐 difit은 리뷰를 열 때 하루에 한 번 새 릴리스가 있는지 확인한다. 확인과 설치는 따로 떨어진 프로세스가 하므로 difit이 뜨는 시간은 그대로다. 새 릴리스는 `~/.difit/versions/<버전>`에 버전마다 따로 깔리고, 설치가 끝까지 성공한 폴더만 쓰인다. 새 버전은 다음에 difit을 켤 때부터 쓰이고, 이미 떠 있는 difit은 원래 폴더의 파일로 계속 화면을 보여 준다. npm으로 깐 `difit` 명령은 `~/.difit/versions`에서 가장 새 버전을 찾아 실행을 넘기기만 하고, 그 자신은 바뀌지 않는다. 오래된 버전 폴더는 가장 새 두 버전과 지금 떠 있는 difit이 쓰는 버전만 남기고 지운다.

- `difit update`: 하루를 기다리지 않고 지금 확인해 설치한다
- `DIFIT_DISABLE_AUTOUPDATE=1`: 자동 확인을 끈다. 이미 받아 둔 버전은 계속 쓰이고 `difit update`도 그대로 된다
- 특정 빌드에 머물기: `~/.difit/versions`에 npm으로 깐 빌드보다 새 버전이 있으면 `difit`은 그 새 버전으로 뜬다. 특정 빌드를 계속 쓰려면 그 빌드를 `npm i -g`로 깐 뒤 `~/.difit/versions`에서 그보다 새 버전 폴더를 지우고 `DIFIT_DISABLE_AUTOUPDATE=1`을 둔다
- 직접 빌드한 버전(`5.0.12-inteh.local.<커밋>`)이나 원래 difit 버전은 확인도 하지 않고 받아 둔 버전으로 넘기지도 않는다

이 기능이 없던 difit(직접 빌드한 것 포함)에서 옮겨 오려면, 떠 있는 difit을 모두 끈 뒤 위의 `npm i -g` 한 줄을 한 번 실행한다. 이 기능이 들어간 릴리스부터는 그 뒤로 다시 깔 일이 없다. npm으로 다시 까는 것은 떠 있는 difit의 파일을 그 자리에서 바꾸므로, 열려 있는 리뷰 화면이 깨질 수 있다.

### 리뷰 흐름

1. **리뷰 열기**: `difit feature main`처럼 브랜치 이름으로 연다. 리뷰는 연 순간의 커밋에 머문다
2. **지적 남기기**: 사람이 줄마다 지적을 남긴다
3. **수정 받기**: 에이전트가 지적 하나에 fixup 커밋 하나로 고쳐 올리면, 그 수정이 지적 아래에 겹쳐 보인다
4. **승인하기**: 사람이 수정을 `승인`하거나 `거절`한다. 거절하면 에이전트가 다시 고친다
5. **합치기**: 브랜치를 마무리할 때 승인한 수정을 원래 커밋에 합친다. fixup 커밋은 기록에 남지 않는다

에이전트가 지적을 받아 고치고 합치는 절차는 [docs/agent-review.md](docs/agent-review.md)에 있다.

### 새 기능

- **수정 겹쳐 보기**: 에이전트가 올린 fixup을 지적이 달린 줄 아래에 카드로 보여 주고, 카드에서 `승인`, `거절`, `승인 취소`를 누른다. 카드에는 지적이 달린 파일의 변경만 보이고, fixup이 함께 고친 다른 파일은 카드 아래 `이 fixup에서 수정한 다른 파일:`에 이름으로 적혀 누르면 그 변경으로 간다. 리뷰 범위에 있는 파일은 fixup이 바꾼 줄 바로 아래에 노란 상자로 보이고, 원래 커밋이 건드리지 않아 접혀 있던 줄이면 그 앞뒤 3줄을 펼쳐 넣는다. 상자의 머리줄에서 어느 지적을 고치며 바꾼 것인지 보고 그 지적 카드로 갈 수 있고, 파일 목록의 그 파일 옆에는 `fixup 수정`이 붙는다. 리뷰 범위에 없는 파일은 파일 목록 아래 `fixup <짧은 해시>에서만 수정한 파일 (N)` 묶음과 본문 맨 아래에 따로 보이고, 생성 파일은 접혀 있다. 이 파일에도 지적을 달 수 있고, 그 지적은 fixup이 합쳐질 원래 커밋에 묶인다. 다른 파일의 변경은 `전체` 화면에서만 보여서, 커밋 하나나 몇 개만 고른 화면의 카드에서 파일 이름을 누르면 `전체` 화면으로 바꿔 그 변경을 보인다. `승인`과 `거절`은 지적 카드에서만 누른다. 위쪽 도구 막대의 `수정을 겹쳐 보기`로 켜고 끈다. `working`, `staged`, `.`, `--pr`, 표준 입력으로 연 리뷰에는 겹쳐 볼 것이 없어 원래 difit처럼 보인다
- **새 커밋 알림**: 리뷰 중인 브랜치에 fixup이 아닌 커밋이 새로 올라오면 도구 막대에 `다시 열기`가 뜬다
- **화면에서 직접 고치기**: 줄의 연필 버튼, 코드를 끌어 고르면 뜨는 막대의 `직접 고치기`(여러 줄), hunk 오른쪽 위의 `hunk 고치기`, 지적 카드의 `직접 고치기`로 코드를 고치고 `저장`하면 승인된 fixup 커밋이 바로 만들어진다. 잘못 고쳤으면 `되돌리기`를 누른다. 스스로 고친 수정이라 `승인 취소`는 뜨지 않는다. 지적 아래 fixup 카드 안에서도 줄의 연필 버튼과 `hunk 고치기`로 에이전트가 고친 줄을 그 자리에서 고친다. 저장하면 리뷰어의 fixup이 에이전트의 fixup 위에 하나 더 쌓이고, 두 수정이 함께 승인되어 지적이 바로 닫힌다. 이때 `되돌리기`는 리뷰어가 마지막에 고친 것만 되돌리고, 에이전트의 수정은 다시 `승인 대기`로 돌아간다([이유](docs/adr/0002-one-fixup-per-target-commit.md)). 커밋에 머문 리뷰를 localhost에서 열었을 때만 켜지고, 커밋 훅은 돌지 않는다([이유](docs/adr/0003-reviewer-edits-become-fixups.md))
- **커밋 메시지 직접 고치기**: 커밋 목록의 커밋 줄에 마우스를 올리면 뜨는 연필 버튼으로 그 커밋의 메시지 전체를 고치고 `저장`하면, 메시지만 바꾸는 승인된 `amend!` 커밋이 바로 만들어지고 그 줄에 바뀔 메시지가 보인다. 폰의 커밋 목록 서랍에서는 연필 버튼이 늘 보인다. 켜지는 조건은 직접 고치기와 같다([이유](docs/adr/0009-reviewer-rewords-become-amend-commits.md))
- **바뀌지 않은 코드 찾아보기**: 코드에서 이름을 누르고 `<이름> 찾기`를 누르면(Ctrl이나 Cmd를 누른 채 누르면 바로) 그 이름이 선언된 줄과 쓰인 줄, 그 파일 전체가 창으로 열린다. 창 안에서 다시 누르면 한 단계 더 들어가고 `←`로 돌아온다. 보통은 이름으로 찾으므로 이름이 같은 다른 선언도 나온다. Java는 [scip-java](https://github.com/sourcegraph/scip-java)가 깔려 있으면 커밋을 리뷰할 때 그 커밋의 색인을 만들어, 누른 이름이 실제로 가리키는 선언과 그것이 쓰인 곳만 보여 준다. 선언이 JDK나 다른 라이브러리에만 있으면 그 라이브러리의 소스를 읽기 전용으로 열어 선언 줄로 옮긴다. 이때 소스는 이 컴퓨터에 이미 있는 것만 쓰고 네트워크로 받지 않는다. JDK는 `JAVA_HOME`, PATH의 `java`, `/usr/lib/jvm` 순서로 찾은 JDK의 `src.zip`을 읽고, 다른 라이브러리는 Gradle 캐시(`~/.gradle/caches/modules-2`)나 Maven 저장소(`~/.m2/repository`)의 `-sources.jar`를 읽는다. Ubuntu의 JDK는 `openjdk-<버전>-source` 패키지를 깔아야 `src.zip`이 생긴다. Gradle 빌드는 소스 jar를 받지 않으므로 IDE가 받아 둔 라이브러리의 소스만 열린다. 라이브러리 소스 안의 이름은 다시 눌러 찾을 수 없다. diff 왼쪽에서 누른 이름은 리뷰의 기준 커밋 색인으로 찾고, 그 색인은 왼쪽을 처음 누를 때 만들기 시작한다. 자기 색인이 없는 커밋은 첫 부모를 따라 50개까지 거슬러 올라가 색인이 있는 가장 가까운 조상의 색인으로 찾고, 그런 조상이 있는 fixup 커밋은 따로 색인을 만들지 않는다. 이때 두 커밋 사이에 바뀐 줄에 있는 결과는 이름으로 찾은 것이어서 `이름 검색` 표시가 붙고, 누른 줄이 바뀌었으면 이름으로만 찾는다. 색인을 쓰지 못하는 동안에는 이름으로 찾은 결과와 함께 창 위쪽에 [색인 상태](#색인-상태)가 뜨고, 색인이 다 만들어지면 결과가 저절로 바뀐다. 설치는 [scip-java 설치](#scip-java-설치)에 있다. 색인은 커밋마다 `~/.difit/scip-index`(`DIFIT_CONFIG_DIR`을 두면 그 아래 `scip-index`)에 쌓이고, 모두 합쳐 상한을 넘으면 가장 오래 쓰지 않은 커밋의 색인부터 지운다. 상한은 `~/.difit/config.json`에 `"scipIndexCacheLimitMiB": 2048`처럼 MiB 단위로 적고, 적지 않으면 1 GiB다. Java 파일이 5천 개쯤인 Gradle 프로젝트에서 커밋 하나의 색인이 15 MB쯤이어서 1 GiB면 커밋 70개쯤이 들어간다. 리뷰가 커밋을 열 때와 색인을 다 만들었을 때마다 넘친 색인을 지우고, 상한을 바꾸면 그다음부터 바뀐 값을 쓴다. 지금 보고 있는 리뷰의 기준·대상 커밋과 그 대신 쓰는 조상 커밋, 만드는 중인 커밋의 색인은 상한을 넘어도 남긴다. 지운 커밋을 다시 열면 색인을 다시 만들고, 그 프로젝트에서는 3분쯤 걸린다. 색인을 만드는 동안 쓰는 작업 폴더는 상한에 세지 않는다. `--pr`과 표준 입력으로 연 리뷰에서는 쓸 수 없다
- **주석이나 공백만 바뀐 곳 접기**: 코드는 그대로인 hunk를 숨은 줄 바와 같은 모양의 `주석 N줄 바뀜` 한 줄로 접고, 펼친 뒤에는 그 위에 작은 `▾ 주석 N줄 바뀜 · 접기` 글자가 남아 그 자리에서 다시 접는다. 파일이나 fixup 전체가 그렇다면 `주석`이나 `공백` 배지를 붙인다. 도구 막대의 `주석 변경 접기`로 켜고 끈다. TS/TSX/JS, Python, Go, Rust, Java, CSS, Bash만 판정하고, `@ts-ignore`처럼 도구가 읽는 주석은 코드로 본다([판정 방법](docs/adr/0006-fold-changes-that-leave-code-alone.md))
- **에이전트 차례 알림**: `difit comment wait`는 에이전트가 고칠 지적이 생기면 끝나므로, 에이전트가 백그라운드로 띄워 두고 알림으로 쓴다. Claude Code 세션이 띄운 difit은 그 세션에 메시지로도 알린다
- **메시지 하나 복사**: 스레드의 메시지마다 그 메시지 하나를 복사하는 버튼이 있다
- **고른 코드에 지적 달기**: 코드 글자를 끌어 고르면(폰에서는 길게 눌러 고르면) `고른 부분에 지적 달기` 막대가 뜬다. 누르면 그 줄들에 지적 입력창이 열리고, 고른 글자가 인용으로 붙는다. 줄 번호를 끌면 그 줄 범위 전체에 지적을 단다
- **지금 보는 파일 표시**: diff를 스크롤하면 화면 위쪽에 걸린 파일에 파일 목록과 폰 파일 칩에서 세로 막대가 붙는다. 키보드 커서가 있는 파일의 배경색과는 따로 붙고, 커서는 스크롤해도 제자리에 있다. 보던 곳에서 이어 가려면 `.`를 누른다
- **커밋 하나씩, 또는 범위로 보기**: 리뷰 범위에 커밋이 둘 이상이면 파일 목록 아래에 커밋 목록이 뜬다. 커밋 목록은 처음에 사이드바 높이의 40%까지만 차지하고, 목록 머리 위 경계를 끌어 높이를 바꾸면 새로 고침 뒤에도 그 높이를 쓴다. 커밋이 다 보이면 그보다 높이 끌어 올려지지 않는다. 커밋을 누르면 그 커밋 하나의 diff를, `전체`를 누르거나 보고 있는 커밋을 다시 누르면 범위 전체를 보고, 브라우저 뒤로 가기로 앞 화면에 돌아간다. 커밋 하나를 누른 뒤 다른 커밋을 Shift+클릭하거나, 한 커밋에서 다른 커밋까지 드래그하면 그 사이 커밋들을 합친 diff를 본다. 폰에서는 머리글의 커밋 단추로 커밋 목록 서랍을 연다. 커밋을 짧게 누르면 그 커밋 하나를 보고, 길게 누른 뒤 손을 떼지 않고 다른 커밋까지 끌거나 손을 뗀 뒤 다른 커밋을 누르면 그 사이를 본다. 고르는 중에는 목록 위의 `취소`를 눌러 그만둔다. `<`·`>` 키로 이전·다음 커밋으로 옮겨 가고, `전체`를 보는 중이면 마지막·첫 커밋으로 간다. 어느 화면을 보든 지적은 리뷰 하나에 쌓이고 `difit comment get`·`wait`도 리뷰 전체를 읽는다. 커밋 화면에서 단 지적은 그 커밋에 묶여, 카드에 그 커밋의 짧은 해시가 보이고 에이전트가 그 커밋으로 fixup을 걸어 마무리 때 그 커밋에 접힌다. 커밋 줄 오른쪽에는 그 커밋으로 고쳐 넣을 지적 가운데 아직 고치지 않은 지적(수정 중·다시 수정 중)의 수가 파일 목록처럼 말풍선과 숫자로 뜬다. 커밋 화면에는 그 커밋으로 고쳐 넣을 지적만 보이고, 다른 화면에서 자리를 못 찾은 지적에는 `이 지적을 단 화면으로` 단추가 뜬다. 범위 화면에서도 지적을 달 수 있고, 고쳐 넣을 커밋이 그 범위에 드는 지적만 보인다. 범위나 `전체` 화면에서 단 지적은 그 화면의 커밋 가운데 그 줄을 마지막으로 바꾼 커밋에 묶인다. 지운 줄이나 그 화면의 커밋이 바꾸지 않은 줄이면 그 화면의 마지막 커밋에 묶인다. 직접 고치기는 커밋·범위 화면에서도 되고, 고친 줄은 그 화면의 커밋 가운데 하나에 fixup으로 들어간다([이유](docs/adr/0008-bind-comments-to-the-commit-they-were-made-on.md))
- **파일 전체에 지적 달기**: 파일 머리의 `파일 지적` 단추로 줄을 고르지 않고 그 파일 전체에 지적을 단다. 단 지적은 파일 머리 바로 아래, 코드 위에 모이고, 카드와 코멘트 패널, 에이전트에게 넘기는 글에는 줄 번호 없이 파일 경로만 나온다. 답글, 해결, 승인과 거절은 줄 지적과 같다. 커밋이나 범위 화면에서 단 파일 지적은 그 화면의 커밋 가운데 그 파일을 마지막으로 바꾼 커밋에 묶인다([저장 모양과 이유](docs/adr/0010-file-level-comments.md))
- **코멘트 패널**: 머리글의 `코멘트` 단추나 `Shift+L`로 diff 오른쪽에 지적 목록 패널을 연다. 지적마다 파일:줄, 첫 글의 앞 두 줄, `열림`(에이전트가 고칠 차례)·`답함`(에이전트가 답해 리뷰어가 볼 차례)·`해결` 표시가 한 줄로 나오고, 처음에는 `남은 것`(열림과 답함)만, `전체`를 누르면 해결된 지적도 보인다. 지적을 누르거나 `Enter`를 누르면 그 줄로 가고 패널은 열려 있으며, 고른 지적은 패널의 줄, diff의 카드, 파일 목록의 파일에 파란 테두리로 표시된다. 본 것으로 접힌 파일이나 감춘 해결된 지적도 고르면 펼쳐서 보인다. 패널 왼쪽 경계를 드래그해 폭을 바꾸고, 열림 상태와 폭은 파일 목록처럼 기억한다. 폰에서는 머리글의 말풍선 단추로 오른쪽 서랍을 열고, 지적을 누르면 서랍이 닫힌다
- **파일 목록 키보드**: `Shift+B` 하나로 왼쪽 파일 목록과 diff를 오간다. 코멘트 패널의 `Shift+L`과 같은 규칙으로, 파일 목록이 닫혀 있으면 열고 `j`/`k`가 파일 목록을 움직이며, 열려 있는데 diff를 보고 있으면 파일 목록으로 돌아가고, 파일 목록에 있으면 닫는다. 파일 목록에 들어가면 diff 커서가 있는 파일에서 시작하고, 커서가 없으면 화면 맨 위에 보이는 파일에서 시작한다. 파일 목록에서 `j`/`k`는 파일과 폴더 사이를 움직이고, 파일에서 `Enter`를 누르면 diff가 그 파일로 가고 키는 파일 목록에 남으며, 폴더에서 `Enter`를 누르면 접히거나 펼쳐진다. `Esc`나 diff 클릭은 `j`/`k`를 diff로 돌려보내고 파일 목록은 열어 둔다. 머리글 단추로 열면 `j`/`k`는 diff에 남는다. 지금 `j`/`k`가 움직이는 파일 목록에는 파란 테두리가 붙는다. 폰에서는 `Shift+B`가 파일 서랍을 열고 `Esc`가 닫는다
- **커밋 그래프**: 커밋 목록의 줄 왼쪽에 커밋마다 세로선 위의 점을 찍는다. 범위에 병합 커밋이 있으면 그 병합으로 들어온 브랜치의 커밋을 병합 커밋 바로 위에 옆 갈래로 그리고, 브랜치마다 다른 색을 쓴다(세 가지 색을 병합 순서대로 돌려 쓴다). 브랜치 커밋의 점은 브랜치 선 위에 놓이고, 선은 갈라지는 곳과 병합 커밋에서만 둥글게 휜다. 갈라지는 곳은 보통 브랜치 바로 위 커밋 줄이지만, 그 커밋이 병합 커밋이면 브랜치의 첫 줄이다. 범위의 첫 커밋이 병합 커밋이면 그 브랜치는 목록 위에서 곧게 내려온다. 고른 커밋은 목록 줄의 강조로 보인다. 브랜치 커밋은 고를 수 없고, 병합 커밋의 diff에 이미 들어 있어 병합 커밋을 고르면 그 줄들도 함께 강조된다. 브랜치가 길면 최근 20개만 그리고 나머지는 개수로 적는다

### scip-java 설치

scip-java는 difit과 따로 깐다. [coursier](https://get-coursier.io/docs/cli-installation)로 아래 명령을 돌려 `scip-java` 파일을 만들고, 그 파일을 PATH에 두거나 `DIFIT_SCIP_JAVA`에 그 경로를 넣은 뒤 difit을 다시 실행한다. Gradle 프로젝트라면 커밋에 Gradle wrapper(`gradlew`)가 있거나 PATH에 `gradle`이 있어야 한다.

```bash
coursier bootstrap --standalone -o scip-java com.sourcegraph:scip-java_2.13:0.12.3 --main com.sourcegraph.scip_java.ScipJava
```

### 색인 상태

찾아보기 창이 이름으로 찾은 결과를 보여 줄 때, 창 위쪽의 한 줄이 그 커밋의 색인이 어떤 상태인지 알린다. 자기 색인이 없어 가장 가까운 조상 커밋의 색인을 기다리는 커밋이면 그 조상 커밋의 색인 상태를 알린다.

- **색인 기다리는 중**(회색 시계): 다른 커밋의 색인을 만드는 중이라 이 커밋은 차례를 기다린다. 바로 앞 차례인 커밋의 짧은 해시가 함께 나온다. 색인은 한 번에 하나씩 만들고, 찾아보기 창에서 결과를 기다리는 커밋은 아무도 기다리지 않는 커밋보다 먼저 만든다
- **색인을 만드는 중**(노란 회전): 색인을 만들기 시작한 뒤 걸린 시간이 함께 나온다. 다 만들어지면 결과가 저절로 바뀐다
- **색인을 만들 수 없음**(빨간 느낌표): 이유가 함께 나온다. scip-java가 없으면 설치 명령과 복사 버튼이, 빌드가 실패했으면 접힌 빌드 기록 끝부분과 기록 파일 경로가 나온다. 이유는 scip-java 없음, 저장소 맨 위에 `build.gradle`·`settings.gradle`·`pom.xml`이 없음, Gradle을 찾지 못함(`gradlew`도 PATH의 `gradle`도 없음), 1시간 안에 끝나지 않음, 그 밖의 빌드 실패(scip-java 종료 코드)다. 한 번 실패한 커밋은 difit을 다시 실행할 때까지 다시 만들지 않는다
- **색인을 쓰지 않는 이유**(회색 안내): Java 파일이 아닌 곳에서 눌렀거나 `working`·`staged`·`.`처럼 커밋이 아닌 리뷰에서 눌러 색인을 쓰지 않았다는 안내다. 커밋(커밋이 아닌 리뷰는 HEAD)에 Java 파일과 맨 위의 빌드 파일이 함께 있어 색인을 만들 수 있는 저장소에서만 나온다

실패한 빌드의 기록은 커밋마다 `~/.difit/scip-index/<커밋>/build.log`(`DIFIT_CONFIG_DIR`을 두면 그 아래 `scip-index`)에 끝 64KB만 남는다.

### 원래 difit과 다르게 동작하는 것

- Resolve를 눌러도 지적을 지우지 않고 `해결됨`으로 접어 둔다. 눌린 ✓를 다시 누르거나 답글을 달면 다시 열린다. 도구 막대의 `해결된 지적 보기`를 끄면 diff에서 감춘다([이유](docs/adr/0007-resolve-keeps-the-thread.md))
- 해결된 지적은 `Copy All`, 에이전트에게 넘기는 목록, 파일 목록의 댓글 수에서 빠진다
- fixup을 승인한 지적도 Resolve를 따로 누르지 않아도 `해결됨`으로 접힌다. ✓를 눌러 다시 열어도 승인은 남고, 승인을 취소하면 Resolve로 따로 해결해 둔 지적이 아닌 한 다시 펼쳐진다. 승인한 지적에 단 답글은 그대로 에이전트에게 넘어간다
- 댓글 입력창에서 Enter를 누르면 보내고 Shift+Enter로 줄을 바꾼다. 한글을 조합하는 중에 누른 Enter로는 보내지 않는다
- 댓글 입력창에 `Add suggestion` 버튼이 없다
- 지적 카드의 복사 버튼은 `경로:L42` 같은 위치 줄 없이 지적 글만 복사한다. 에이전트는 `difit comment get`으로 위치와 코드를 따로 받기 때문이다. 제안 블록을 풀어 복사하는 것과 `Copy All`이 위치 줄을 붙이는 것은 원래 difit과 같다
- 마우스가 있는 기기에서는 지적 버튼이 줄 번호 위에, 에디터에서 열기와 직접 고치기 버튼이 줄 오른쪽 끝에 있어 코드 첫머리를 가리지 않는다. 터치 기기에서는 줄 번호 위의 버튼 하나를 누르면 세 가지가 메뉴로 나온다
- 주석이나 공백만 바뀐 hunk는 처음부터 접혀 있다
- All Comments 창 대신 코멘트 패널을 쓰고, 노란 단추 메뉴의 `View All Comments`도 패널을 연다. `Shift+L` 하나로 패널과 diff를 오간다. 패널이 닫혀 있으면 열고 `j`/`k`·`Enter`·`d`가 패널 목록을 움직이며, 열려 있는데 diff를 보고 있으면 패널로 돌아가고, 패널에 있으면 닫는다. `Esc`나 diff 클릭은 `j`/`k`를 diff로 돌려보내고 패널은 열어 둔다(폰에서는 `Esc`가 서랍을 닫는다). 머리글 단추로 열면 `j`/`k`는 diff에 남는다. 지금 `j`/`k`가 움직이는 패널에는 파란 테두리가 붙는다
- `difit`이나 `difit feature main`처럼 이름으로 연 리뷰도 연 순간의 커밋에 머물러, 브랜치에 커밋이 올라와도 diff가 바뀌지 않는다

## 🤖 Calling from Agents

You can install the following Skills to work with difit from AI agents.

```sh
npx skills add yoshiko-pg/difit
```

Installed skills include:

- `difit`: ask the user for a review in the difit viewer when the user explicitly opts in to difit
- `difit-review`: review a specific diff or PR and show the findings inside the difit viewer, when the user explicitly asks for difit

After code edits or automated review, the agent can start the difit server with the appropriate skill.

## 🎨 Syntax Highlighting Languages

- **JavaScript/TypeScript**: `.js`, `.jsx`, `.ts`, `.tsx`, `.svelte`
- **Web Technologies**: HTML, CSS, JSON, XML, Markdown
- **Shell Scripts**: `.sh`, `.bash`, `.zsh`, `.fish`
- **Backend Languages**: PHP, SQL, Ruby, Java, Groovy, Scala, Perl, Elixir, Haskell, Clojure
- **Systems Languages**: C, C++, C#, Rust, Go
- **Mobile Languages**: Swift, Kotlin, Dart
- **Infrastructure as Code**: Terraform (HCL), Nix
- **Others**: Python, Protobuf, YAML, Solidity, Vim script, GDScript

## 🔍 Auto-collapsed Files

difit automatically identifies and collapses certain files to keep your view clean:

- **Deleted files**: Removed files are auto-collapsed since they don't require close review
- **Generated files**: Auto-generated code is collapsed by default. This includes:
  - Lock files (`package-lock.json`, `go.sum`, `Cargo.lock`, `Gemfile.lock`, etc.)
  - Minified files (`*.min.js`, `*.min.css`)
  - Source maps (`*.map`)
  - Generated code:
    - Orval (`*.msw.ts`, `*.zod.ts`, `*.api.ts`)
    - Dart (`*.g.dart`, `*.freezed.dart`)
    - C# (`*.g.cs`, `*.designer.cs`)
    - Protobuf (`*.pb.go`, `*.pb.cc`, `*.pb.h`)
  - Frameworks:
    - Ruby on Rails (`db/schema.rb`)
    - Laravel (`_ide_helper.php`)
    - Gradle (`gradle.lockfile`)
    - Python (`uv.lock`, `pdm.lock`)
  - Generic generated files (`*.generated.cs`, `*.generated.ts`, `*.generated.js`)
  - Content-based detection:
    - Files containing `@generated` marker
    - Files containing `DO NOT EDIT` header
    - Language-specific generated headers (Go, Python, etc.)

## 🛠️ Development

```bash
# Install dependencies
pnpm install

# Start development server (with hot reload)
# This runs both Vite dev server and CLI with NODE_ENV=development
pnpm run dev

# Build and start production server
pnpm run start <target>

# Build for production
pnpm run build

# Run tests
pnpm test

# Run typecheck, lint, and format
pnpm run check
pnpm run format
```

### Development Workflow

- **`pnpm run dev`**: Starts both Vite dev server (with hot reload) and CLI server simultaneously
- **`pnpm run start <target>`**: Builds everything and starts production server (for testing final build)
- **Development mode**: Uses Vite's dev server for hot reload and fast development
- **Production mode**: Serves built static files (used by npx and production builds)

## 🏗️ Architecture

- **CLI**: Commander.js for argument parsing with comprehensive validation
- **Backend**: Express server with simple-git for diff processing
- **GitHub Integration**: GitHub CLI (`gh pr diff --patch`) for PR patch retrieval
- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS v4 with GitHub-like dark theme
- **Syntax Highlighting**: Prism.js with dynamic language loading
- **Testing**: Vitest for unit tests with co-located test files
- **Quality**: oxlint, oxfmt, lefthook pre-commit hooks

## 📋 Requirements

- Node.js ≥ 21.0.0
- Git repository with commits to review
- GitHub CLI (`gh`) for `--pr` mode

## 📄 License

MIT
