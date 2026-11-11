# 귀신의집 영상 원격 재생 시스템 — 최종 아키텍처 결정서

- **문서 버전**: 1.0 (최종 아키텍처 확정)
- **작성일**: 2026-11-11
- **대상 환경**: 갤럭시탭 S6 FE Lite (조종용 1대 + 체험자용 2대 기본 `A`/`B`, 설정으로 1대 모드 전환 지원)

---

## 1. 미결정 항목 최종 결정 (명세 15장 확정)

### 1.1 서버 및 DB 선택: Oracle Cloud Always Free VM + 내장 SQLite (`node:sqlite`)
- **서버 호스팅**: Oracle Cloud Always Free VM (서울/춘천 리전, Ubuntu LTS)
  - **Caddy**: DuckDNS 도메인 연결 + 자동 TLS/Let's Encrypt (`https` / `wss`) 리버스 프록시
  - **Node.js 22 LTS**: 단일 프로세스 서버 (`http` + `ws` + `busboy`), PM2 또는 systemd 상시 구동
- **프론트엔드 호스팅**: Netlify 무료 플랜 (`frontend/` 정적 파일 배포)
  - 로컬 개발 및 현장 테스트 편의를 위해 Node.js 서버 자체에서도 `SERVE_FRONTEND=true` 옵션으로 동일 오리진 서빙을 지원합니다.
- **데이터베이스**: **SQLite (`node:sqlite`, WAL 모드)** 채택 (Oracle Autonomous DB 미사용)
  - **결정 근거**:
    1. **비용 0원 & 유휴 중지 회피**: Oracle Autonomous DB 무료 티어는 7일간 비활성 시 자동 중지되며 mTLS 월렛 관리가 필요하지만, VM 디스크 내장 SQLite(`/data/app.db`)는 유휴 중지가 없고 외부 DB 장애/네트워크 지연(0ms)이 없습니다.
    2. **아키텍처 정합성**: 본 시스템은 단일 Node.js 프로세스 메모리를 실시간 상태의 단일 진실 소스(SSOT)로 사용합니다. 영상 파일(`/data/videos/*.mp4`)과 메타/재생 로그(`app.db`)가 동일 VM 디스크에 위치하여 정합성과 백업이 단순합니다.
    3. **무의존성 빌드**: Node 22 내장 `node:sqlite`를 사용하여 ARM64/AMD64 Oracle VM에서 C++ 네이티브 컴파일(`node-gyp`)이나 1GB RAM VM OOM 위험 없이 즉시 실행됩니다.

### 1.2 영상 보관 정책 및 최대 파일 크기 제한 없음
- **보관 개수**: 현재 활성(active) 영상 1개 + 최근 이전 영상 **3개** 아카이브 보관 (설정 화면에서 복원 가능, 3개 초과 과거 비활성 영상은 자동 삭제).
- **최대 파일 크기 제한 없음 (무제한)**:
  - **업로드 서버(`POST /upload`)**: `busboy` 파일 크기 상한을 두지 않고 디스크로 직접 스트리밍 저장하며, 스트림 통과 중 `SHA-256`을 계산해 서버 RAM 점유를 일정하게 유지합니다. 단, VM 디스크 고갈로 OS가 중단되지 않도록 `MIN_DISK_FREE_BYTES`(기본 512MB) 여유 공간 가드만 검사합니다.
  - **MP4 검증**: 업로드 첫 청크에서 ISO BMFF `ftyp` 시그니처를 검증하고, 순수 JS MP4 `mvhd` 박스 파서(또는 선택적 `ffprobe`)로 재생 길이를 추출·검증합니다.
  - **다운로드/캐싱(`GET /video/:id`)**: 서버는 `Accept-Ranges: bytes` (`206 Partial Content`) 스트리밍을 제공하고, 체험자 태블릿(`display.html`)은 갤럭시탭 S6 Lite(4GB RAM)에서 OOM을 막기 위해 `ReadableStream` 기반 청크 다운로드 + 순수 JS 증분 `SHA-256` 검증 + **IndexedDB 청크 Blob 저장**(예: 8MB 단위) 후 `new Blob(chunks)` → `URL.createObjectURL`로 재생합니다.

### 1.3 별도 이어폰 연결 대응 (오디오·동기화)
- **하드웨어 권장**: 갤럭시탭 S6 Lite의 **3.5mm 유선 이어폰 단자** 사용을 강력히 권장합니다. 블루투스 이어폰은 A2DP 코덱 지연(150~300ms) 및 무음 대기 시 자동 슬립으로 인해 `<100ms` 동기화 목표를 해칠 수 있습니다.
- **소프트웨어 대응**:
  - `display.html`의 최초 스태프 터치(`시작`) 시 전체화면·Wake Lock과 함께 `AudioContext.resume()`으로 브라우저 오디오 정책을 잠금 해제합니다.
  - 불가피하게 블루투스 등 지연이 있는 오디오 장비를 쓰는 경우에 대비해 DB/설정에 기기별 보정치 `audioOffsets: { A, B }` (ms)를 두어 `startAt` 스케줄 시 반영할 수 있게 설계했습니다.
  - 설정 화면에서 **테스트 재생 / 사운드 확인** 기능을 제공해 체험자 입장 전 이어폰 음량과 출력을 점검합니다.

### 1.4 인증 및 단일 공용 PIN
- **스태프 공용 단일 PIN**: `settings` 테이블에 `scrypt`(개별 16바이트 솔트) 해시로 저장합니다.
- **무차별 대입 방지**: 연속 5회 실패 시 60초 잠금(`429 Too Many Requests`).
- **토큰 이원화 (보안 + 무중단 운영)**:
  - `admin` 토큰 (12시간 만료): `⚙ (3초 길게) + PIN` 인증으로 발급. 영상 업로드/활성화/삭제, 프리셋 편집, PIN 변경, 기기 구성 변경, 강제 재동기화에 필수.
  - `control` / `display` 기기 토큰 (30일 장기 세션): 최초 태블릿 세팅 시 공용 PIN 1회 입력으로 발급하여 `localStorage`에 보관합니다. 이후 새로고침이나 와이파이 재연결 시 재로그인 없이 자동 복구되며, 서버는 WebSocket 연결과 HTTP 다운로드 모두에서 role/deviceId와 토큰을 검증하여 `display` 기기의 제어 명령 위조를 차단합니다.
  - PIN 변경 시 DB의 `token_version`을 증가시켜 기존에 발급된 모든 토큰을 즉시 무효화합니다.

### 1.5 피조종기기 대수 (A/B 2대 기본 + 1대 호환)
- 명세 본문(1.1~14장)에 따라 기본 필수 피조종기기는 **`['A', 'B']` 2대**입니다.
- 명세 헤더의 `1대(체험자용)` 표기 및 현장 예비 상황을 반영해, 설정(`requiredDisplays`)에서 `['A', 'B']` 또는 `['A']` / `['B']` 1대 모드로 전환할 수 있습니다.

---

## 2. 전체 시스템 구조

```
┌───────────────────────────┐         HTTPS / WSS          ┌───────────────────────────────────────┐
│   Netlify (정적 호스팅)    │ ◄──────────────────────────► │ Oracle Cloud Always Free VM           │
│ - control.html + bg.webp  │                              │ ┌───────────┐        ┌─────────────┐  │
│ - display.html?id=A       │                              │ │   Caddy   │──────► │  Node.js 22 │  │
│ - display.html?id=B       │   (로컬/개발 시 Node 직접 서빙) │ │ DuckDNS   │  http  │  http + ws  │  │
└───────────────────────────┘                              │ │ Auto TLS  │  127.0 │  + busboy   │  │
                                                           │ └───────────┘  :3000 └──────┬──────┘  │
                                                           │                             │         │
                                                           │               ┌─────────────┴──────┐  │
                                                           │               ▼                    ▼  │
                                                           │      /data/app.db       /data/videos/ │
                                                           │      (SQLite WAL)        ({id}.mp4)   │
                                                           └───────────────────────────────────────┘
```

---

## 3. 상태 머신 (서버 메모리 단일 진실 소스)

| 상태 | 진입 조건 | 허용 명령 | 전이 |
|---|---|---|---|
| `NOT_READY` | 활성 영상 없음, 필수 기기(`A`/`B`) 미연결 또는 캐시 미완료, 업로드 중 | `activate` | 필수 기기 모두 연결 + 활성 영상 캐시 100% 완료 → `READY` |
| `READY` | 활성 영상 존재 + 필수 기기 연결 및 캐시 완료 | `play`, `activate`, `resync` | `play` → `startAt = now + 300ms` 전송 → `PLAYING` |
| `PLAYING` | 재생 중 | `stop` | 모든 연결된 재생 기기 `ended` 또는 `stop` 또는 안전 타임아웃(`duration + 10s`) → `COOLDOWN` |
| `COOLDOWN` | 재생 종료 직후 3초 재시작 잠금 | (제어 차단) | 3초 경과 → 준비 상태 재평가(`READY` 또는 `NOT_READY`) |

- **한쪽 기기 끊김 처리**: `PLAYING` 중 `A` 또는 `B` 한쪽 연결이 끊겨도 나머지 기기는 끝까지 재생하며, `control.html`의 해당 기기 점만 빨강(`red`)으로 전환됩니다.
- **복구**: `control.html`이 재생 중 새로고침되어도 접속 즉시 `status` 스냅샷(`state: 'PLAYING'`, `playback.startAt`, `pos`)을 받아 화면을 복구합니다.

---

## 4. 시계 동기화 및 메시지 프로토콜

### 4.1 시계 동기화 (`ping` / `pong`)
- 접속 직후 5회 버스트(120ms 간격) + 30초마다 5회 버스트 + 5초마다 하트비트 `ping`.
- 클라이언트 계산식:
  - `rtt = clientReceiveTime - cTime`
  - `offset = sTime - (cTime + rtt / 2)`
  - 최근 20개 샘플 중 RTT가 가장 작은 **상위 5개의 중앙값(median)** 을 `offsetMs`로 사용.
- `display`는 `startAt` 수신 시 `delayMs = (startAt - serverNow())`만큼 대기 후 정밀 재생 시작.

### 4.2 WebSocket 엔드포인트
`wss://{domain}/ws?role=control|display&id=A|B&token={jwt}`

- **조종 → 서버**: `play`, `stop`, `msg {text}`, `activate {videoId}` (admin 토큰 필요), `ping {cTime}`
- **피조종 → 서버**: `state {id, cached, dl, rttMs, offsetMs, error}`, `pos {pos, videoId}`, `ended {videoId}`, `ping {cTime, rttMs, offsetMs}`
- **서버 → 조종**: `status` 스냅샷 (`state`, `uploading`, `requiredDisplays`, `video`, `playback`, `cooldownUntil`, `displays.{A,B}`)
- **서버 → 피조종**: `video {videoId, url, size, sha256, duration}`, `play {videoId, startAt}`, `stop`, `msg {text, ms:5000}`, `resync`

### 4.3 HTTP API
| 메서드/경로 | 권한 | 설명 |
|---|---|---|
| `GET /health` | 공개 | 서버 상태, 업타임, 디스크 여유 공간 |
| `POST /auth` | PIN | 공용 PIN 검증 및 토큰 발급 (`admin`/`control`/`display`) |
| `GET /auth/verify` | 토큰 | 현재 토큰 유효성 및 만료 시각 확인 |
| `GET /status` | `control`/`admin` | 현재 `status` 스냅샷 + 재생 통계 |
| `GET /presets` | `control`/`admin` | 메시지 프리셋 목록 |
| `GET /settings`, `PUT /settings` | `admin` | 프리셋, 필수 기기(`A,B`/`A`), 오디오 오프셋 조회/수정 |
| `PUT /settings/pin` | `admin` | 공용 PIN 변경 (기존 토큰 전체 무효화) |
| `POST /resync` | `admin` | A/B 강제 재다운로드 명령 |
| `GET /videos` | `admin` | 보관 중인 영상 목록 (Phase 4 연동) |
| `POST /upload` | `admin` | 무제한 스트리밍 업로드 (Phase 4) |
| `GET /video/:id` | `display`/`control`/`admin` | `Range` 지원 영상 스트리밍 (Phase 4) |
| `POST /videos/:id/activate` | `admin` | 영상 활성화/복원 (Phase 4) |
| `DELETE /video/:id` | `admin` | 비활성 영상 삭제 (Phase 4) |

---

## 5. SQLite 스키마 (`server/src/db.js`)

```sql
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  duration REAL NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

CREATE TABLE play_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT CHECK (ended_by IN ('end', 'stop', 'timeout') OR ended_by IS NULL)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

---

## 6. 단계별 개발 계획

1. **Phase 1 (완료)**: 최종 아키텍처 확정, 프로젝트/배포 뼈대, SQLite DB·PIN/토큰 인증·상태 머신·WebSocket 게이트웨이·시계 동기화, `control`/`display` 기본 뼈대 및 배경 `bg.webp` 변환, 단위/통합 테스트.
2. **Phase 2**: `display.html` 본편 구현 (예약 시각 `startAt` 동기 재생, 검은 화면 복귀, `pos`/`ended` 보고, 5초 메시지 오버레이, 모서리 5초 길게 누름 숨겨진 관리자 진입).
3. **Phase 3**: `control.html` 본편 구현 (0.6초 길게 누름 재생 원형 게이지+진동, 1초 길게 누름 정지, 읽기 전용 타임라인 보정, `⚙ 3초+PIN` 설정 화면·기기 상세 패널).
4. **Phase 4**: 대용량 무제한 스트리밍 업로드(`busboy` + MP4 `mvhd` 파서)·이전 3개 자동 아카이브·`Range` 다운로드·`display` IndexedDB 청크 Blob 캐싱·증분 SHA-256 검증·테스트 재생.
5. **Phase 5**: 메시지 프리셋 시트·편집 UI·오디오 오프셋 설정 UI·E2E 검증 및 Oracle VM/Caddy/DuckDNS/Netlify 배포 점검.
