# N02·N06 연습용 SUM 프로토콜 자료

담당 김태형. N02 연습용 TCP 프로그램(서버 `server.c`와 원본 클라이언트 `client.c`)과 N06 연습용 분석 자료(빌드법, 정상 요청·응답 PCAP, SHA-256, 요청→기대 응답 목록)를 담는다. 공개 연습 자료이며 본 실험 프로그램(N10)·정답과 별개다. 연습 결과는 본 실험 점수가 아니다.

## 파일

| 파일 | 설명 |
| --- | --- |
| `practice/n06/server.c` | 연습용 SUM 서버. 순차 처리, 루프백, 기본 포트 19006 |
| `practice/n06/client.c` | 원본 클라이언트. N08 연결 시 참고 구현 |
| `practice/n06/normal-sessions.pcap` | 정상 요청 5세션의 루프백 캡처. 50패킷, 4,310바이트, SHA-256 `e9b5650cd8aab5f0480a1b99740af67e7713f5083f5a58c0acaa5535207bd698` |
| `practice/n06/cases.json` | 요청→기대 응답 케이스 21개 (N07 평가기 형식) |
| `scripts/n06-capture.py` | 서버 기동, 정상 5세션 실행, tcpdump 캡처, 검증과 JSON 기록 |
| `compose.n06.yaml`, `infra/n06/Dockerfile` | N05 이미지에 tcpdump를 더한 N06 실행 환경 |

## 프로토콜 명세

요청 프레임 (모든 정수는 빅엔디언)

| 오프셋 | 크기 | 필드 | 값 |
| --- | --- | --- | --- |
| 0 | 2 | magic | `0x42 0x42` (`BB`) |
| 2 | 1 | version | `0x01` |
| 3 | 1 | type | `0x01` (SUM) |
| 4 | 2 | length | payload 바이트 수. 짝수, 0~64 |
| 6 | length | payload | 부호 없는 16비트 정수 열, 최대 32개 |

응답 프레임 (성공)

| 오프셋 | 크기 | 필드 | 값 |
| --- | --- | --- | --- |
| 0 | 2 | magic | `0x42 0x42` |
| 2 | 1 | version | `0x01` |
| 3 | 1 | type | `0x81` (SUM 응답) |
| 4 | 2 | length | `0x0004` |
| 6 | 4 | sum | 입력 정수 합, 32비트 빅엔디언 |

오류 프레임 (7바이트): `42 42 01 FF 00 01 <code>`

| 코드 | 뜻 | 조건 |
| --- | --- | --- |
| `0x01` | bad magic | 처음 두 바이트가 `42 42`가 아님 |
| `0x02` | bad version | version이 `0x01`이 아님 |
| `0x03` | bad type | type이 `0x01`이 아님 |
| `0x04` | bad length | length가 홀수이거나 64보다 큼 |

서버 동작

- 연결 하나당 요청 하나를 처리하고 응답 뒤 연결을 닫는다.
- 헤더 6바이트는 `recv`가 여러 번에 나뉘어 와도 모두 모을 때까지 읽는다. payload도 같은 방식으로 length만큼 모은다.
- 검사 순서는 magic → version → type → length다. 헤더 6바이트를 다 읽은 뒤 검사한다.
- length 검사에 실패하면 payload를 읽기 전에 오류 프레임을 보낸다.
- 헤더나 payload 도중 연결이 끊기면(EOF) 응답하지 않고 닫는다.
- 요청 처리가 끝나면(응답을 보낸 경우와 EOF로 응답 없이 끝난 경우 모두) 서버는 쓰기 방향을 닫고(`SHUT_WR`), 남은 수신 바이트를 최대 16번 읽는다. 읽기 한 번당 대기는 1초다. 이렇게 해야 읽지 않은 바이트 때문에 `close()`가 RST를 보내 응답이 사라지는 일을 피한다.
- 요청은 한 번에 하나씩 순서대로 처리한다. 루프백(`127.0.0.1`)에만 바인드한다.

## 요청 → 기대 응답 (대표)

전체 21개는 [`cases.json`](cases.json)에 있다. 아래 hex는 요청 프레임 전체와 기대 응답 전체다.

| 케이스 | 요청 (hex) | 기대 응답 (hex) | 비고 |
| --- | --- | --- | --- |
| `sum-three-values` | `424201010006000100020003` | `42420181000400000006` | 1+2+3 한 번에 전송 |
| `sum-split-header-payload` | 같은 요청을 5조각으로 나눔 | `42420181000400000006` | TCP 분할 처리 |
| `sum-byte-by-byte` | `424201010004000a0014`, 1바이트씩 전송 | `4242018100040000001e` | 10+20 = 30 |
| `sum-max-values` | `424201010004ffffffff` | `4242018100040001fffe` | 65535+65535 |
| `sum-empty-payload` | `424201010000` | `42420181000400000000` | 빈 payload의 합은 0 |
| `sum-32-values` | length `0x0040`, 32개 `ffff` | `424201810004001fffe0` | 최대 payload, 합 2097120 |
| `sum-trailing-bytes-ignored` | `4242010100020005` + `ffff` | `42420181000400000005` | 한 요청 뒤 바이트는 응답하지 않고 버림 |
| `error-bad-magic` | `414201010000` | `424201ff000101` | |
| `error-precedence-magic-over-version` | `414202020003` | `424201ff000101` | magic이 version보다 먼저 |
| `error-unknown-type` | `424201020000` | `424201ff000103` | |
| `error-odd-length` | `424201010003` | `424201ff000104` | payload를 보내지 않아도 응답 |
| `error-length-ffff` | `42420101ffff` | `424201ff000104` | 65535 길이는 payload를 읽지 않고 거부 |
| `error-odd-length-payload-sent` | `424201010003` + `000100` | `424201ff000104` | 거부 뒤 payload는 버리고 정상 종료 |
| `eof-mid-header` | `4242` 후 쓰기 종료 | (없음) | 응답 없이 종료 |
| `eof-mid-payload` | `4242010100040001` 후 쓰기 종료 | (없음) | 응답 없이 종료 |

## 빌드

원본 소스에서 바이너리를 만든다. 빌드 결과물과 실행 로그는 Git에서 제외되는 `runs/`에 둔다.

PowerShell (Docker Desktop, 저장소 루트, N05 이미지 빌드 후):

```powershell
New-Item -ItemType Directory -Force runs/n06 | Out-Null
docker compose -f compose.n05.yaml run --rm n05 gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-server practice/n06/server.c
docker compose -f compose.n05.yaml run --rm n05 gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-client practice/n06/client.c
docker compose -f compose.n05.yaml run --rm n05 sh -c 'sha256sum runs/n06/practice-server runs/n06/practice-client'
```

WSL / Linux (저장소 루트, GCC 필요):

```sh
mkdir -p runs/n06
gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-server practice/n06/server.c
gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-client practice/n06/client.c
sha256sum runs/n06/practice-server runs/n06/practice-client
```

경고 없이 빌드된다(`-Wall -Wextra`). 컴파일러가 다르면 바이너리 해시도 달라지므로 실행마다 나온 값을 기록한다.

이번 기록의 환경: Ubuntu 24.04 컨테이너, GCC 13.3.0, Mac arm64 호스트에서 `DOCKER_DEFAULT_PLATFORM=linux/amd64`로 에뮬레이션해 빌드. 실행 결과는 다음과 같다.

| 파일 | SHA-256 | 바이트 |
| --- | --- | --- |
| `runs/n06/practice-server` | `d6cd6d971030e34601c2953fd71eceef7ac4fab0c8f0dde285a51a04ab040067` | 16,928 |
| `runs/n06/practice-client` | `0ad87f81537ee489e4bb0cc80eb6878e3353f6b4d6f6fab073e4581cd23588cf` | 16,792 |

다른 호스트(x86-64 Windows/WSL 등)에서 같은 해시가 나오는지는 아직 확인하지 않았다.

## 실행

서버 (포트 생략 시 19006, 1~65535만 허용):

```sh
runs/n06/practice-server 19006
```

서버는 `N06 practice TCP service listening on 127.0.0.1:19006`을 표준 오류에 출력하고 계속 대기한다. 끝내려면 Ctrl+C.

다른 터미널에서 클라이언트:

```sh
runs/n06/practice-client 19006 1 2 3
```

기대 출력: `sum=6` (종료 코드 0).

- 인자는 `<port> <n1> [n2 ... n32]`다. 숫자는 0~65535 정수, 1~32개.
- 서버가 오류 프레임을 보내면 표준 오류에 `error=<code>`를 10진수로 출력하고 종료 코드 1.
- 사용법 오류(인자 개수, 범위 밖 값, 잘못된 포트)는 사용법을 출력하고 종료 코드 2.

## PCAP 다시 만들기

캡처는 N05 이미지가 있어야 한다. 바이너리를 빌드한 뒤 저장소 루트에서 실행한다.

```sh
docker compose -f compose.n05.yaml build n05
docker compose -f compose.n06.yaml build n06
tag=$(date +%Y%m%d-%H%M%S)
docker compose -f compose.n06.yaml run --rm n06 python3 scripts/n06-capture.py runs/n06/practice-server runs/n06/practice-client runs/n06/capture-$tag.json
```

스크립트가 하는 일:

1. 빈 루프백 포트를 골라 서버를 띄우고 연결 가능할 때까지 기다린다.
2. tcpdump를 `lo`에서 `tcp port <포트>`로 시작한다(`-U --immediate-mode`).
3. 정상 5세션을 클라이언트로 실행하고 각 합을 기대값과 비교한다.
4. FIN이 2×세션 수 이상 잡히고 패킷 수가 더 늘지 않을 때까지 기다린 뒤 tcpdump를 멈춘다.
5. SYN 5개, FIN 10개를 확인하고 PCAP과 JSON(해시·명령·세션 결과)을 `runs/n06/`에 남긴다.

PCAP에는 정상 세션만 있다. 오류 응답 케이스는 PCAP에 없다.

정상 세션 5개 (요청 → 응답, 모두 hex):

| 입력 | 요청 frame | 응답 frame |
| --- | --- | --- |
| 1 2 3 | `424201010006000100020003` | `42420181000400000006` |
| 10 20 | `424201010004000a0014` | `4242018100040000001e` |
| 65535 65535 | `424201010004ffffffff` | `4242018100040001fffe` |
| 1000 | `42420101000203e8` | `424201810004000003e8` |
| 7 7 7 7 7 | `42420101000a00070007000700070007` | `42420181000400000023` |

## 팀원 연결

- N05 (REA 단독 분석): `docker compose -f compose.n05.yaml run --rm n05 node scripts/rea-smoke.mjs --rea-only runs/n06/practice-server runs/n06/rea-$tag.json`
- N07 (기대/실제 평가): `docker compose -f compose.n05.yaml run --rm n05 python3 scripts/n07-evaluate.py --cases practice/n06/cases.json --binary runs/n06/practice-server --out runs/n06/eval-$tag.json`. 기대 결과는 21/21 pass, 종료 코드 0.
- N08 (클라이언트와 웹): `client.c`를 참고 구현으로 쓰고, 위 요청→응답 표를 화면 검증 기준으로 쓴다.

## 분석 연습 시 주의

블라인드 분석 연습(패킷만 / 패킷+바이너리)에서는 모델에 PCAP만 주고, 두 번째 조건에서만 바이너리를 준다. 이 README, 소스, `cases.json`은 모델에 주지 않는다. 오류 코드(`0x01`~`0x04`)는 PCAP에 나타나지 않고 바이너리에만 있으므로, 두 조건은 복원할 수 있는 내용이 다르다.

## 한계

- 순차 처리 단일 요청 서비스다. 동시 접속, 부하, 유휴 시간 제한(idle timeout)은 측정하지 않았다.
- 루프백에서만 실행했다. PCAP의 타임스탬프와 포트는 그 실행의 값이다.
- Mac arm64 호스트에서 amd64 에뮬레이션으로 빌드·실행했다. 다른 호스트에서의 바이너리 해시 일치는 확인하지 않았다.
- 실행 증거와 AI 검증 범위는 [docs/evidence/N06-2026-11-08.md](../../docs/evidence/N06-2026-11-08.md)에 있다. AI 검증은 본인 확인이 아니다.
