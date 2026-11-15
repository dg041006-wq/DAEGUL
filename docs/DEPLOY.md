# 운영 배포 방법

> 현재 상태: **운영 배포 미완료.** 이 개발 환경에는 사용할 수 있는 호스팅 계정·결제 정보·API 토큰이 없어 실제 운영 주소를 만들 수 없었습니다.
> 배포에 필요한 파일(Dockerfile, render.yaml)과 운영 기능(마이그레이션 자동 적용, 상태 확인, 최초 대표 설정, 워커 내장)은 준비되어 있고, 깨끗한 사본으로 운영 설정을 재현해 동작을 확인했습니다(아래 '검증').

## 구성

- 컨테이너 1개: API + 화면 + 워커(작업 큐·즉시 보고·정기 보고·푸시) — `RUN_WORKER_IN_PROCESS=true`
- PostgreSQL 1개 (모든 업무 데이터, 예약 상태, 첨부 파일)
- HTTPS는 호스팅 플랫폼이 제공 (PWA 설치·푸시에 HTTPS 필수)
- 정기 보고가 제시간에 나가려면 **잠들지 않는 인스턴스**가 필요합니다(무료 플랜의 유휴 정지 X).

## 권장: Render (Blueprint, 약 10분)

1. https://render.com 가입 → 결제 수단 등록 (Starter 웹 서비스 + Basic PostgreSQL)
2. Dashboard → **New → Blueprint** → GitHub 저장소 `dg041006-wq/DAEGUL` 연결 → 브랜치 선택 → `render.yaml` 인식
3. 입력 요청되는 값:
   - `APP_BASE_URL`: 생성될 주소 (예: `https://stayscene-office.onrender.com`, 만든 뒤 수정 가능)
   - `ANTHROPIC_API_KEY`: Claude Console에서 발급한 키 (없으면 비워 두면 규칙 모드로 동작)
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: 구글시트 연동할 때만
4. Apply → 빌드·배포(마이그레이션 자동 적용). `SESSION_SECRET`, `SETUP_TOKEN`은 Render가 무작위 생성
5. 서비스 → Environment에서 `SETUP_TOKEN` 값을 확인 → 앱 주소 접속 → 로그인 화면이 '최초 대표 계정 설정'으로 열림 → 토큰·이메일·비밀번호 입력 → 대표 계정 생성(이후 설정 화면은 자동으로 닫힘)
6. 설정 → 시트 가져오기에서 업무 시트(.xlsx) 반영, 설정 → 구성원에서 직원 초대

## 다른 플랫폼

Docker 이미지를 실행할 수 있는 곳이면 됩니다(Fly.io, Railway, AWS App Runner/ECS, GCP Cloud Run(최소 인스턴스 1) 등).

| 환경변수 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | ✔ | PostgreSQL 14+ 연결 문자열 |
| `SESSION_SECRET` | ✔ | 32자 이상 무작위 |
| `APP_BASE_URL` | ✔ | 공개 HTTPS 주소 (초대 링크·푸시 발신자) |
| `NODE_ENV` | ✔ | `production` (쿠키 Secure) |
| `RUN_WORKER_IN_PROCESS` | 권장 | `true` (워커를 별도로 띄우면 `false` + `npm run start:worker`) |
| `SETUP_TOKEN` | 최초 1회 | 대표 계정 만들기용. 만든 뒤 삭제해도 됨 |
| `ANTHROPIC_API_KEY` | 선택 | 없으면 AI 규칙 모드 |
| `AI_MODEL` | 선택 | 기본 `claude-opus-5-5` |
| `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` | 선택 | 없으면 최초 실행 시 생성해 DB에 보관 (DB 복원 시 함께 복원되어 구독 유지) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 선택 | 구글시트 읽기 전용 연동 |
| `TEST_WEBHOOK_SECRET` | 선택 | 테스트 수신 웹훅 서명용 |

## 상태 확인·오류 기록

- `GET /api/health` → `{ ok, db, workerLastSweepAt, workerHealthy }` (DB 끊기면 503). 플랫폼 헬스체크에 연결
- 서버 로그: JSON 구조 로그(쿠키·Authorization 헤더 마스킹, 웹훅 본문 미기록)
- 앱 안: 설정 → 연동 상태(수신 실패·재시도 한도 초과 작업), 활동 이력, AI 비용(오류 종류별)

## 백업·복원·이전 버전 복구

- DB 백업: 관리형 PostgreSQL 자동 백업 + 주 1회 `pg_dump` 보관 (docs/OPERATIONS.md)
- 이전 버전으로 되돌리기: Render → Deploys → 이전 배포 'Rollback' (또는 이전 커밋 재배포). 마이그레이션은 추가형이라 직전 버전 코드가 새 스키마에서 동작합니다. 스키마를 되돌려야 하면 배포 직전 백업으로 복원.
- 새 버전 반영: 배포 후 열려 있는 앱에 '새 버전이 배포되었습니다 · 새로고침' 안내가 표시됩니다.

## 검증 (이 개발 환경에서 실행, 운영 주소 아님)

깨끗한 사본에서 `npm ci → npm run build → npm prune --omit=dev → node dist-server/server/index.js`(Dockerfile과 같은 순서), `NODE_ENV=production`, 새 DB:
- 시작 시 마이그레이션 적용, `/api/health` 200 + DB 연결, 1분 내 워커 점검 동작(`workerHealthy: true`)
- 최초 설정: 잘못된 토큰 401 → 올바른 토큰으로 대표 생성 → 설정 닫힘(`open:false`) → 로그인 세션 유지
- API 응답 `Cache-Control: no-store`, 서비스 워커·매니페스트·아이콘·SPA 경로 200
- Docker 이미지 자체 빌드는 이 환경에 Docker 데몬이 없어 **실행하지 못했습니다**.
