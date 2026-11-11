# 전면 코드 검토 보고서 및 로컬 호스팅 가이드 (3단계 기준)

- **작성일**: 2026-11-11
- **대상 버전**: Phase 1 ~ Phase 3 완료 상태 (`arena/3448eb50-26cannotgohome3-1`)

---

## 1. 로컬 호스팅 테스트 방법 및 동작 제한·대안 안내

### 방법 A. 현재 샌드박스(Arena Live Preview)에서 바로 확인하기
- 서버가 `0.0.0.0:3000`으로 실행 중일 때 Arena의 Live Preview 프록시(`https://{port}-{sandboxId}.e2b.app`)를 통해 **실제 HTTPS/WSS 환경과 동일하게** 동작을 확인할 수 있습니다.
  - 조종기기 화면: `/control.html` (또는 `/`)
  - 체험자 화면 A: `/display.html?id=A`
  - 체험자 화면 B: `/display.html?id=B`
  - 초기 PIN: `1234` (첫 접속 시 1회 입력, 설정 화면 진입은 `⚙` 3초 길게 누름 후 `1234`)
- **참고**: 같은 브라우저의 다른 탭 3개에 `/control.html`, `/display.html?id=A`, `/display.html?id=B`를 동시에 띄워도 스토리지 키(`ghost_control_token`, `ghost_display_token_A`, `ghost_display_token_B`)가 분리되어 있어 충돌 없이 테스트할 수 있습니다.
- **제한**: 아직 4단계(영상 파일 업로드·스트리밍·IndexedDB 캐싱) 구현 전이므로, 현재는 기기 연결(● A/● B 주황 점), 실시간 상태 동기화, 안내 메시지 전송(5초 페이드 인/아웃), `⚙` 3초+PIN 설정, PIN 변경/프리셋 편집까지 테스트 가능합니다.

### 방법 B. 본인 PC에서 로컬 호스팅해 실제 태블릿(갤럭시탭)으로 연결하기
1. Node.js 22 LTS 이상이 설치된 PC에서 실행:
   ```bash
   npm install
   npm start
   ```
2. PC와 태블릿 3대를 **같은 Wi-Fi(공유기/핫스팟)** 에 연결하고, PC의 사설 IP(예: `192.168.0.15`)와 방화벽 TCP `3000` 포트를 허용합니다.
3. 태블릿 브라우저에서 **동일 오리진(`http://192.168.0.15:3000`)으로 직접 접속**합니다:
   - 조종기기: `http://192.168.0.15:3000/control.html`
   - 체험자 A/B: `http://192.168.0.15:3000/display.html?id=A`, `.../display.html?id=B`

#### 로컬 HTTP(`http://192.168.x.x`) 호스팅이 안 되거나 제약이 걸릴 때의 대안 방식
사설 IP의 평문 `http://` 환경에서는 안드로이드 브라우저의 **Secure Context(보안 컨텍스트) 정책** 때문에 일부 제약이 발생합니다:

| 현상 / 제약 | 원인 (논리적 근거) | 해결 / 대안 호스팅 방식 |
|---|---|---|
| Netlify(`https://`)에서 로컬 PC(`http://192.168...`)로 연결 불가 | 브라우저는 HTTPS 페이지에서 평문 `http://` / `ws://` 호출(Mixed Content)을 차단합니다. | 로컬 테스트 시에는 Netlify를 거치지 말고 Node 서버가 직접 서빙하는 `http://<PC-IP>:3000/...` 주소로 직접 접속하세요(`SERVE_FRONTEND=true`). |
| 평문 `http://192.168...`에서 `Wake Lock`(화면 꺼짐 방지) 미작동 가능 | `navigator.wakeLock` API는 `https://` 또는 `localhost`에서만 활성화됩니다. | **대안 1(권장)**: 태블릿 개발자 옵션의 **"충전 중 화면 켜짐 유지"**를 켭니다(명세 7장 필수 항목).<br>**대안 2**: 로컬에서 HTTPS가 필요하면 `caddy` + 자체 서명/내부 CA, 또는 **Cloudflare Tunnel(`cloudflared tunnel --url http://localhost:3000`) / Tailscale Funnel**을 통해 임시 `https://` 주소로 즉시 터널링할 수 있습니다. |
| 4단계 이후 대용량 영상 해시 검증 | `crypto.subtle.digest` 역시 HTTPS 전용 API입니다. | 본 시스템은 4단계에서 평문 HTTP 로컬 환경에서도 100% 동작하고 4GB RAM OOM을 막는 **순수 JS 스트리밍 증분 SHA-256**을 사용하도록 설계했습니다. |

### 방법 C. 최종 운영 호스팅 (비용 0원 프로덕션)
- **백엔드**: Oracle Cloud Always Free VM + Caddy(`deploy/Caddyfile.example`) + DuckDNS(자동 HTTPS/WSS) + PM2/systemd
- **프론트엔드**: Netlify 무료 정적 배포 (`frontend/`), `frontend/config.js`의 `PROD_BACKEND_ORIGIN`에 DuckDNS 주소 지정 및 서버 `.env`의 `ALLOWED_ORIGINS`에 Netlify 도메인 지정.

---

## 2. 전면 코드 검토 보고서 및 오류 최소화 설계

지금까지 작성된 서버(`server/src/*`)와 프론트엔드(`frontend/*`) 전수 점검을 통해 확인한 잠재 오류와 논리적 개선 사항은 다음과 같습니다.

### 2.1 상태 머신 및 실시간 동기화 정합성
1. **하트비트 갱신이 끊김 상태를 임의 부활시키던 경로 차단 (`server/src/state.js`)**
   - *원인*: `touchHeartbeat()`가 `d.connected === false`일 때 `d.connected = true`로 바꾸고 `recomputeState()`만 호출한 뒤 `emitStatus()`를 누락할 수 있는 여지가 있었습니다.
   - *개선*: 실제 소켓 연결 이벤트(`connectDisplay`)만이 `connected = true`를 설정하도록 제한하고, `touchHeartbeat()`는 이미 연결된 기기(`d.connected === true`)의 `lastSeen`/`rttMs`/`offsetMs`만 갱신하도록 고정했습니다.
2. **재생 진행 위치(`playback.pos`) 진동 현상 방지 (`server/src/state.js`)**
   - *원인*: A 기기가 `pos: 5.0`을 보고한 직후 네트워크 지터로 0.2초 뒤진 B 기기가 `pos: 4.8`을 보고하면 `playback.pos`가 매초 `5.0 → 4.8 → 6.0`으로 역행하며 조종기기 타임라인 보정이 흔들릴 수 있었습니다.
   - *개선*: 연결되어 재생 중인 기기(`playback.startedDisplays`)들의 보고된 `pos` 평균값을 `playback.pos`로 산출해 시간 역행과 보정 튐 현상을 최소화했습니다.
3. **3초 재시작 잠금(`COOLDOWN`) 중 강제 재동기화 차단 일관성 (`server/src/state.js`)**
   - *원인*: `activateVideo()`는 `PLAYING`과 `COOLDOWN` 모두 차단하지만 `triggerResync()`는 `PLAYING`만 차단하고 있었습니다.
   - *개선*: `triggerResync()` 역시 `PLAYING || COOLDOWN` 중 호출을 차단해 상태 전이 경합을 없앴습니다.

### 2.2 네트워크 재연결 및 로컬 LAN 호환성
4. **모바일 Wi-Fi 복구 시 3초 대기 제거 (`frontend/shared/ws-client.js`)**
   - *원인*: 와이파이가 잠시 끊겼다가 다시 붙어도 지수 백오프 타이머(최대 3초)가 끝날 때까지 재연결이 지연되었습니다.
   - *개선*: 브라우저 `online` 이벤트를 감지해 연결이 끊긴 상태면 백오프를 0으로 초기화하고 즉시 재접속을 시도하며, `disconnect()` 시 리스너를 해제해 누수를 방지했습니다.
5. **로컬 LAN IP(`192.168.x.x`) 수동 서버 변경 지원 + HTTPS 다운그레이드 차단 (`frontend/config.js`)**
   - *원인*: 기존 `validateOrigin()`은 `http:` 프로토콜에 대해 `localhost`/`127.0.0.1`만 허용해 로컬 LAN 테스트 시 수동 서버 설정이 막히는 문제가 있었습니다.
   - *개선*: 현재 페이지가 `https:`일 때는 여전히 `https:`(또는 로컬 루프백)만 허용해 중간자 다운그레이드를 원천 차단하되, 현재 페이지가 `http:`(로컬 LAN 테스트)일 때에 한해 사설 IPv4(`192.168.*`, `10.*`, `172.16~31.*`)를 허용했습니다.

### 2.3 사용자 오조작 방지 및 URL 편의성
6. **PIN 오류 시 남은 시도 횟수 안내 (`frontend/control.js`, `frontend/display.js`)**
   - 5회 연속 실패 시 60초 잠금에 들어가기 전, 스태프가 남은 시도 횟수를 즉시 인지해 오타로 인한 부스 잠금을 예방할 수 있도록 오류 문구에 잔여 횟수를 표시했습니다.
7. **클린 URL 별칭 지원 (`server/src/http.js`)**
   - 태블릿 브라우저 주소창에 `.html`을 빼고 `/control` 또는 `/display?id=A`로 입력해도 404 없이 정상 서빙되도록 라우트를 보완했습니다.

### 2.4 이미 검증·반영된 핵심 보안·안정성 방어선 (1~3단계 누적)
- **인증·세션**: `scrypt` 솔트 해시 + SQLite 영속 5회 실패 60초 잠금 + IP당 분당 20회 레이트 리미트 + `TRUST_PROXY` 조건부 `X-Forwarded-For` 신뢰 + PIN 변경 시 `token_version` 증가 및 기존 WS 즉시 차단(`4003`).
- **토큰/WS**: `?server=` 쿼리 하이재킹 방지, `display` 역할의 제어 명령(`play`/`stop`/`msg`/`activate`) 서버 차단, `401` 무한 재접속 방지, WS 프로토콜 `ping/pong` 반열림 소켓 청소, 재접속 시 이전 캐시 상태 리셋.
- **프론트/XSS/업로드**: `innerHTML` 미사용(`textContent` 전용), HTML `Content-Security-Policy` (`script-src 'self'`), 소형 JSON 요청 30초 타임아웃 vs 무제한 대용량 업로드를 위한 `server.requestTimeout = 0`.
