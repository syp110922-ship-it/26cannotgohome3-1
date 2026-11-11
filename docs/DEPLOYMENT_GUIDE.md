# Phase 5 운영 배포 및 현장 부스 세팅 가이드

이 문서는 **`26cannotgohome3-1` (Phase 1 ~ Phase 5 완료본)** 을 실제 귀신의집 현장에 0원 인프라(Oracle Cloud Always Free VM + DuckDNS + Caddy + Netlify) 또는 로컬 PC 서버로 배포·테스트하기 위한 최종 체크리스트입니다.

---

## 1. 운영 환경 구조 요약

- **백엔드 (항시 가동 · 디스크 영속)**: Oracle Cloud Always Free Ubuntu VM (`Node.js >= 22.13`)
  - SQLite WAL (`data/app.db`): 3종 PIN 해시, 메시지 프리셋, 필수 기기 구성, 오디오 보정값, 재생 이력(`play_log`), 관리자 로그(`event_log`), 영상 메타데이터 저장
  - 로컬 디스크 (`data/videos/*.mp4`): 무제한 용량 스트리밍 업로드 저장 + 활성 1개 / 이전 3개 보관(`ARCHIVE_RETENTION=3`)
- **리버스 프록시 / 자동 HTTPS·WSS**: Caddy (`deploy/Caddyfile.example`) + DuckDNS
- **프론트엔드**: Netlify (`netlify.toml`, `frontend/` 정적 호스팅) 또는 개발/로컬 테스트 시 Node 서버 직접 서빙(`SERVE_FRONTEND=true`)

---

## 2. Oracle Cloud VM 백엔드 설치 (Ubuntu 22.04 / 24.04)

1. **Node.js 22 LTS & Caddy 설치**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs caddy ffmpeg
   ```
   *(참고: 본 서버는 순수 JS MP4 검사기 `server/src/mp4.js`를 내장하므로 `ffprobe` 없이도 동작하며, `ffmpeg` 설치 시 비표준/fragmented MP4에 대한 폴백 검사도 자동 활성화됩니다.)*

2. **프로젝트 배치 및 환경 변수 설정**
   ```bash
   sudo mkdir -p /opt/haunted-house-sync
   sudo chown "$USER":"$USER" /opt/haunted-house-sync
   git clone <REPO_URL> /opt/haunted-house-sync
   cd /opt/haunted-house-sync
   npm install --omit=dev
   cp .env.example .env
   ```
   `.env` 주요 확인 항목:
   ```dotenv
   HOST=127.0.0.1
   PORT=3000
   SERVE_FRONTEND=false
   TRUST_PROXY=true
   ALLOWED_ORIGINS=https://your-site.netlify.app
   INITIAL_ADMIN_PIN=admincgo2631
   INITIAL_DISPLAY_PIN=cgo2631
   INITIAL_SETTINGS_PIN=adminsetmg
   ARCHIVE_RETENTION=3
   MIN_DISK_FREE_BYTES=536870912
   ```
   *(운영 시작 전 반드시 **조종기기 설정 → PIN 변경** 또는 `.env` 초기값으로 PIN을 변경하세요.)*

3. **Caddy (DuckDNS 자동 HTTPS/WSS) & systemd 등록**
   - `deploy/Caddyfile.example`의 `your-subdomain.duckdns.org`를 실제 DuckDNS 도메인으로 수정해 `/etc/caddy/Caddyfile`에 적용 (`flush_interval -1` 필수 — WebSocket 및 대용량 스트리밍 버퍼링 방지).
   - `sudo systemctl reload caddy`
   - `sudo cp deploy/ghost-sync.service /etc/systemd/system/ && sudo systemctl enable --now ghost-sync`
   - Oracle Cloud VCN 보안 목록(Ingress) 및 OS 방화벽(`ufw`)에서 **TCP 80, 443** 허용.

---

## 3. Netlify 프론트엔드 배포

1. `frontend/config.js` 상단의 `PROD_BACKEND_ORIGIN`에 백엔드 주소를 지정합니다:
   ```js
   const PROD_BACKEND_ORIGIN = 'https://your-subdomain.duckdns.org';
   ```
   *(또는 각 기기 초기 화면 / 설정 → 구석 톱니바퀴 **`서버 관리`** 모달에서 서버 주소를 직접 입력·저장할 수 있습니다.)*
2. Netlify에서 레포지토리를 연결하면 `netlify.toml` 설정(`publish = "frontend"`, 보안 헤더, `/assets/*` 캐시)에 따라 자동 배포됩니다.

---

## 4. 현장 태블릿 3대 & 블루투스/에어팟 세팅 체크리스트

### 4.1 3종 PIN 역할 분리
- **관리자/조종 로그인 PIN** (`INITIAL_ADMIN_PIN`, 기본 `admincgo2631`): 조종기기 연결 로그인, 체험자 기기 `5초 모서리 진단` 재인증·강제 제어
- **체험자 기기 로그인 PIN** (`INITIAL_DISPLAY_PIN`, 기본 `cgo2631`): 체험자 화면 A/B 최초 1회 로그인 전용 (조종·설정 권한 없음)
- **설정탭 진입 PIN** (`INITIAL_SETTINGS_PIN`, 기본 `adminsetmg`): 조종기기 `⚙` 3초 길게 누름 후 설정 화면 진입 전용 (설정을 닫기 전까지 PIN 변경 등 연속 작업 가능)

### 4.2 블루투스 헤드셋 / 에어팟 동시 출력 팁
- 본 시스템은 체험자 화면이 검은 대기 상태에 있는 동안에도 **25초 간격의 무음 WebAudio 유지 펄스**로 블루투스 A2DP 절전 진입(재생 초반 0.5초 오디오 잘림)을 방지합니다.
- 유선 이어폰과 블루투스 헤드셋/에어팟을 섞어 쓰거나 좌우 기기 무선 지연 차이가 느껴질 경우:
  1. 조종기기 **`⚙` (3초) → 기기 상태** 탭에서 **`유선 기본 (0ms)` / `A만 블루투스 (-180ms)` / `B만 블루투스 (-180ms)`** 프리셋 또는 `±50ms` 미세 조정 후 **`구성 저장`** 을 누릅니다.
  2. **`영상 관리 → A/B 기기 테스트 재생`** 으로 양쪽 이어폰을 착용한 채 즉시 립싱크·음량을 점검하고 **`테스트 정지`** 로 마무리합니다.

### 4.3 현장 에러 대응 & 로그 확인
- 일반 화면이나 스태프 조작 중 예기치 않은 문제가 발생하면 원시 오류 코드 대신 차분한 **"오류가 발생했어요! 잠시만요."** 팝업만 표시됩니다.
- 정확한 원인(네트워크 단절, MP4 헤더 오류, 디스크 부족, 체험자 기기 디코딩/해시 오류, 재생 이력)은 **관리자 설정(`adminsetmg`) → `로그 기록`** 탭에서만 모아보고 필터링(`전체 로그` / `오류만` / `재생 이력`) 및 정리할 수 있습니다.
