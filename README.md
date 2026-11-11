# 귀신의집 영상 원격 재생 시스템 (`26cannotgohome3-1`)

갤럭시탭 S6 FE Lite 조종기기 1대로 체험자용 태블릿(A, B) 2대의 전체화면 영상 재생을 원격 동기 제어하는 시스템입니다.

## 아키텍처 요약
상세 결정 사항은 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), 배포·현장 가이드는 [`docs/DEPLOYMENT_GUIDE.md`](./docs/DEPLOYMENT_GUIDE.md)를 참고하세요.
- **프론트엔드**: 순수 HTML / CSS / JavaScript (`frontend/`, 로컬 번들 `Pretendard Regular` 폰트 포함), Netlify 정적 호스팅 (개발 시 Node 서버 직접 서빙 지원)
- **백엔드**: Node.js 22 (`http` + `ws` + `busboy`), Oracle Cloud Always Free VM + Caddy(DuckDNS 자동 HTTPS/WSS)
- **데이터베이스**: 내장 SQLite (`node:sqlite`, WAL 모드) — 0원, 유휴 중단 없음, 0ms 로컬 액세스, 재생·오류 로그 보관
- **영상 정책**: 최대 파일 크기 제한 없음 (디스크 스트리밍 업로드 + IndexedDB 8MB 청크 캐싱), 이전 영상 최근 3개 보관
- **오디오**: 3.5mm 유선 이어폰 및 블루투스 헤드셋/에어팟 대응 (블루투스 A2DP 무음 슬립 방지 유지 + 기기별 `audioOffsets` ±ms 보정 + 설정 화면 테스트 재생)
- **오류/로그**: 일반 화면에는 `"오류가 발생했어요! 잠시만요."` 안내 팝업만 노출하고, 상세 오류·재생 이력은 관리자 설정의 **`로그 기록`** 탭에서만 조회·관리
- **보안**: 3중 PIN 분리 (`admincgo2631` 관리자/조종 로그인 · `cgo2631` 체험자 로그인 · `adminsetmg` 설정탭 진입, `scrypt` 해시, 5회 실패 시 60초 잠금) + 스코프 기반 WebSocket/HTTP 토큰
- **서버 주소 관리**: 일반/인증 화면에 서버 주소를 노출하지 않으며, 구석 톱니바퀴 아이콘 또는 관리자 설정의 **`서버 관리`** 탭에서만 확인·수정 가능

## 디렉토리 구조
```
├── docs/
│   ├── ARCHITECTURE.md       # 최종 아키텍처 결정서 및 단계별 계획
│   └── AUDIT_AND_HOSTING.md  # 코드 검토 보고서 및 로컬/운영 호스팅 가이드
├── deploy/                   # Oracle VM Caddy / PM2 / systemd 예시 설정
├── frontend/                 # 순수 HTML/JS 프론트엔드 (control.html, display.html)
│   ├── assets/bg.webp        # 폐가 일러스트 배경 (WebP 변환)
│   ├── assets/gear.webp      # 서버 관리 모달용 톱니바퀴 아이콘 (투명 WebP)
│   ├── assets/play-*.webp    # 재생/정지 패드 아이콘 (투명 WebP)
│   └── shared/
│       ├── ws-client.js      # WebSocket 재접속 + RTT 시계 동기화 클라이언트
│       └── video-cache.js    # 순수 JS 스트리밍 SHA-256 + IndexedDB 청크 캐시
├── server/
│   ├── src/
│   │   ├── config.js         # 환경 설정 로더
│   │   ├── db.js             # SQLite 초기화 및 리포지토리
│   │   ├── auth.js           # PIN 해시, 잠금 가드, HMAC 토큰
│   │   ├── mp4.js            # 무제한 스트리밍용 MP4 헤더/길이(moov/mvhd) 검사기
│   │   ├── state.js          # 서버 메모리 상태 머신 (NOT_READY/READY/PLAYING/COOLDOWN)
│   │   ├── ws.js             # WebSocket 게이트웨이 및 역할 검증
│   │   ├── http.js           # HTTP API 라우터, 무제한 업로드, Range 스트리밍 및 정적 서빙
│   │   ├── display-preview.js # 체험자 화면(display.html) 전용 프리뷰/프록시 서버
│   │   └── index.js          # 앱 부트스트랩 및 종료 처리
│   └── test/                 # Node 내장 테스트 러너 기반 단위·통합 테스트
├── .env.example
├── netlify.toml
└── package.json
```

## 빠른 실행
```bash
npm install
npm test
npm start
# (선택) 체험자 화면 전용 분리 서버 실행 (기본 포트 3001 -> 백엔드 3000 프록시)
npm run start:display-preview
```
