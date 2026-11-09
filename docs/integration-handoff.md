# 연습 통합 인계 — 2026-11-09 KST

PR [#1](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/1), [#2](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/2), [#3](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/3)을 이날 순서대로 병합했다.
현재 연결은 공개 연습 자료 검증이다. 본 실험의 프로토콜 복원이나 점수가 아니다.

## 확인한 범위

| 코드와 구분 | 확인 결과 |
| --- | --- |
| 병합 전 clean PR #3 `0ac1666` | N05 모의 25/25, N07 모의 19/19, 실제 N06 서버 평가 21/21 |
| 같은 코드의 N06 재빌드 | 서버·클라이언트 SHA-256이 기존 N06 증거와 일치 |
| 같은 코드의 실제 REA 단독 | 입력 SHA-256 일치, `binary_overview`: 함수 인벤토리 79, 문자열 119, 세그먼트 33 |
| 같은 코드의 정상 세션 캡처 | 50패킷, SYN 5, FIN 10, 정상 요청·응답 5쌍 확인 |
| 제한 시간 수정 `cac9e9b` | clean Docker에서 N07 모의 21/21, 실제 N06 서버 평가 21/21 |

`cac9e9b`는 N07의 조각 전송 대기·전송에도 케이스의 남은 제한 시간을 적용한다.
기존 수신 제한과 함께 검사하며, 대기와 전송 예산 회귀 테스트 두 개를 추가했다.
캡처와 REA는 모델 호출 없이 실행했다. 개요의 숫자가 프로토콜 복원 성공을 뜻하지 않는다.
기존 근거: [N05](evidence/N05-2026-11-05.md), [N06](evidence/N06-2026-11-08.md), [N07](evidence/N07-2026-11-07.md).

## 지금 재실행할 명령

저장소 루트 PowerShell에서 실행한다. N05 Docker 이미지 설치는 [실행법](rea-smoke.md)을 따른다.
실행마다 새 태그를 쓰고, 바이너리·원본 JSON·CSV·로그는 Git에서 제외한 `runs/`에 둔다.

```powershell
New-Item -ItemType Directory -Force runs/n06 | Out-Null
$runTag = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose -f compose.n05.yaml run --rm n05 gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-server practice/n06/server.c
docker compose -f compose.n05.yaml run --rm n05 node scripts/rea-smoke.mjs --rea-only runs/n06/practice-server "runs/n06/rea-$runTag.json"
docker compose -f compose.n05.yaml run --rm n05 python3 scripts/n07-evaluate.py --cases practice/n06/cases.json --binary runs/n06/practice-server --out "runs/n06/eval-$runTag.json"
```

REA는 `success: true`, `doctor.healthy: true`, 입력 해시 일치가 기대 결과다.
평가는 `summary.total: 21`, `summary.pass: 21`, 종료 코드 0이 기대 결과다.
GLM 키 없이 이 범위를 진행할 수 있다. 실제 모델 연동에는 수업에서 확인한 설정이 필요하다.

## N05 실제 수업 모델 연결

현재 `n05_complete: false`다. 실제 수업 모델 설정과 정의종 본인 검토가 남아 있다.
모델 종류·ID·계정 URL은 N01에서 확인한다. 아래 자리표시자는 확인한 값으로 바꾼다.
키는 대화·문서·명령 인자·저장소에 붙이지 않고 같은 PowerShell 창에서 입력한다.

```powershell
$env:LLM_CHAT_COMPLETIONS_URL = '<수업에서 확인한 HTTPS Chat Completions URL>'
$env:LLM_MODEL = '<수업에서 확인한 모델 ID>'
$handoffKey = Read-Host 'Course model API key' -AsSecureString
$env:LLM_API_KEY = [System.Net.NetworkCredential]::new('', $handoffKey).Password
try {
    $runTag = Get-Date -Format 'yyyyMMdd-HHmmss'
    docker compose -f compose.n05.yaml run --rm n05 node scripts/rea-smoke.mjs runs/n06/practice-server "runs/n06/full-$runTag.json"
} finally {
    Remove-Item Env:LLM_API_KEY -ErrorAction SilentlyContinue
    Remove-Variable handoffKey -ErrorAction SilentlyContinue
}
```

같은 실행에서 `model.requested`/`model.returned`, `tool_call.id`/`evidence.tool_call_id`와 실제 tool 메시지를 대조한다.
`summary.claims`의 주장 하나를 원본 REA 파일·인용 바이트·SHA-256과 대조하고 의미도 직접 읽는다.
`verification.all_quotes_match: true`는 문자열 일치다. 본인 확인은 [AI 사용 기록](ai-usage.md)에 별도로 남긴다.
스크립트는 `n05_complete`를 자동으로 true로 바꾸지 않는다. 실제 실행·본인 확인 후 기록을 갱신한다.

## N08에서 읽을 N07 결과

N07 JSON과 옆 CSV가 웹 결과 표시의 입력이다. 실제 필드명은 다음과 같다.

| 위치 | 필드와 의미 |
| --- | --- |
| 최상위 | `task`, `classification`, `experiment_score`, `stage`, `success`, `started_at`, `finished_at` |
| `summary` | `total`, `pass`, `fail`, `error`, `pass_rate`, `all_pass` |
| `results[]` | `case_id`, `description`, `verdict`, `request_chunks_hex`, `half_close` |
| `results[]` 기대·실제 | `expected_hex`, `actual_hex`, `expected_text`, `actual_text`, `first_diff_offset` |
| `results[]` 실행 | `server_closed`, `elapsed_ms`, `error` (`null` 또는 `type`/`message`) |
| 재현 정보 | `code_commit`, `code_dirty`, `cases_file`, `target`, 바이너리 모드의 `input`/`server_command`/`server_stopped` |

`success: true`는 평가 절차가 끝났다는 뜻이다. 통과 여부는 `summary.all_pass`와 케이스별 `verdict`로 표시한다.
`verdict`는 `pass`/`fail`/`error`이며 timeout은 `error.type`에 기록한다.
현재 수신은 서버 EOF 기준이라 연결 유지·다중 메시지 프로토콜은 추가 구현이 필요하다.

서버는 `127.0.0.1`에만 바인드한다. Docker 포트 공개만으로 호스트 웹앱에 연결되지 않는다.
서버와 평가기를 같은 컨테이너에서 실행하거나, WSL/Linux에서 실제로 도달 가능한 서버를 사용한다.
`--target HOST:PORT`는 평가기를 실행하는 환경에서 접근 가능한 주소여야 한다.
N08은 사용한 서버·실행 위치·포트와 웹 요청→실제 응답 화면 또는 로그를 함께 공유한다.

## 이번 인계 이후 남은 일

| 담당·작업 | 다음 산출물과 확인 |
| --- | --- |
| 정의종 · N01 | LMS 제출 수신·상태 확인, 현재 수업 지정 모델·정확한 ID·URL·키 수령 여부 확인 |
| 정의종 · N05 | 위 실제 전체 연동, 호출 ID·원본 근거·모델 주장 의미의 본인 검토와 증거 갱신 |
| 정의종 · N09 (11/15까지) | 패킷만 / 패킷+바이너리 A/B 모드 구현·실행 기록. 현재 A/B 모드는 미구현 |
| 김태형 · N10 | 본 실험 프로그램·분석용 입력 준비, 본인 확인과 공유 가능한 실행 증거 |
| 권세현 · N11 | 본 실험 평가 케이스·판정 기준 준비, 평가기 실행 결과와 본인 확인 |
| 유현석 · N08 | N06 명세로 클라이언트·웹 실제 통신, N07 결과 표시, 실행 명령과 화면·로그 |

본 실험의 정답 소스·기준 명세·정답표·숨은 평가 입력은 태형·세현이 별도 보관한다.
초기 평가가 고정될 때까지 분석 담당 의종·현석, 분석 모델, 저장소와 분석 마운트에 제공하지 않는다.
공개 N06 소스·명세·케이스는 연습 연결에만 쓴다. 블라인드 분석 입력에 포함하지 않는다.
