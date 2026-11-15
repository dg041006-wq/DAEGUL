# STAYSCENE OFFICE

스테이신 대표와 초대받은 직원이 PC·휴대폰에서 함께 쓰는 내부 업무 앱입니다.
카카오 상담 대화를 공식 경로로 연동해 문의 수·유형·전환·이탈 사유를 분석하고, 정장 차림 AI 직원 3명(마케팅 팀장 · CS 팀장 · 경영전략실장)에게 업무를 요청하는 구조입니다.

> **현재 상태: 개발 1단계 + 2단계 일부 / 카카오 미연동 / 운영 준비 미완료.**
> 카카오(상담톡) 공식 연동은 아직 검증되지 않았습니다. 화면의 상담·수치는 샘플 데이터이며 앱에 '샘플 데이터 / 카카오 미연동'으로 표시됩니다.
> 실제 연동된 부분과 데모 부분의 구분, 검증 결과, 미완료 항목은 [`docs/STATUS.md`](docs/STATUS.md)를 보세요.

## 구성

| 영역 | 기술 |
|---|---|
| 프런트엔드 | React 18 + TypeScript + Vite, 반응형(390px~1440px), PWA(설치·앱 셸 캐시) |
| 서버 API | Node.js 20+ / Fastify 5 / TypeScript |
| DB | PostgreSQL 14+ (SQL 마이그레이션) |
| 작업 큐 | PostgreSQL 기반(`jobs` 테이블, `SKIP LOCKED`) — 별도 워커 프로세스 |
| AI | 서버에서 Claude API(`@anthropic-ai/sdk`), 기본 모델 `claude-opus-5-5` |
| 인증 | 초대 기반 계정(공개 가입 없음), scrypt 비밀번호, httpOnly 세션 쿠키 |

```
src/
  shared/domain.ts           분류 체계(서비스 유형·단계·이탈 사유 등) 공용 상수
  server/
    db/migrations/*.sql      DB 스키마
    integrations/            상담 공급사 어댑터 (demo 구현, channeltalk 자리표시)
    ingest/ingest.ts         원본 이벤트 수신함 → 정규화 → 대화 저장소, 기회 연결
    analytics/metrics.ts     지표 계산(DB 쿼리)
    ai/                      AI 직원(권한 제한 도구), 상담 분석, 답장 초안, 마스킹
    jobs/                    작업 큐, 자동화(답변 지연·견적 후속·정기 보고·보관 정리)
    routes/                  API (모든 읽기/쓰기에서 서버 권한 검사)
    seed/demo.ts             샘플 데이터
  web/                       화면 (대표실, 상담함, 고객/영업, 분석실, AI 직원, 보고서, 할 일, 알림함, 설정)
test/                        필수 검증 시나리오 자동 테스트
docs/                        연동 검증 계획, 가져오기 형식, 운영, 현황 보고
```

## 로컬 실행

필요: Node.js 20 이상, PostgreSQL 14 이상.

```bash
cp .env.example .env
```

`.env`에서 `DATABASE_URL`, `SESSION_SECRET`(32자 이상 임의 문자열), `DEMO_WEBHOOK_SECRET`을 채웁니다. 비밀값은 `.env`나 배포 플랫폼 비밀 설정에만 넣고, 채팅·이슈·커밋에 붙여넣지 마세요.

```bash
npm install
```

```bash
npm run db:migrate
```

샘플 데이터와 로컬 확인용 데모 계정(대표/직원) 생성 — 비밀번호는 실행 결과에 출력됩니다(또는 `DEMO_OWNER_PASSWORD`, `DEMO_STAFF_PASSWORD`로 지정):

```bash
npm run db:seed-demo
```

API·워커·프런트엔드 개발 서버 동시 실행 (http://localhost:5173):

```bash
npm run dev
```

### 실제 대표 계정 만들기 (데모 계정 대신)

```bash
OWNER_EMAIL=you@example.com OWNER_NAME=대표 OWNER_PASSWORD='10자 이상 비밀번호' npm run admin:create-owner
```

이후 직원은 설정 → 구성원·권한에서 초대 링크로 추가합니다.

## 테스트

테스트 전용 DB(`stayscene_test`, 또는 `TEST_DATABASE_URL`)가 필요합니다. 테스트는 해당 DB의 `public` 스키마를 초기화합니다.

```bash
npm test
```

```bash
npm run typecheck
```

## 빌드·배포

```bash
npm run build
```

운영에서는 두 프로세스를 띄웁니다. 둘 다 시작 시 마이그레이션을 적용합니다.

```bash
npm start
```

```bash
npm run start:worker
```

- `npm start`는 API와 빌드된 화면(`dist-web`)을 같은 포트(`PORT`, 기본 3000)에서 제공합니다. 새로 빌드한 뒤에는 API 프로세스를 재시작하세요.
- HTTPS 종단(리버스 프록시/플랫폼) 뒤에 두고 `NODE_ENV=production`을 설정하면 세션 쿠키에 `Secure`가 붙습니다.
- 필수 환경변수: `DATABASE_URL`, `SESSION_SECRET`, `APP_BASE_URL`. AI 사용 시 `ANTHROPIC_API_KEY`(서버 전용).
- 백업·복원, 계정 회수, 보관 정책: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)

## AI 설정

- `ANTHROPIC_API_KEY`가 없으면 AI 기능은 '모델 API 미연동'으로 표시되고, AI 직원은 DB 집계 기반 **규칙 응답**(명확히 표시)만 합니다. 상담 수신·기본 업무는 영향 없음.
- 기본 모델 `claude-opus-5-5`, 적응형 사고, 거절 시 서버측 폴백(`AI_SERVER_FALLBACK=false`로 끔).
- Claude API 사용료는 Claude 구독과 별도로 청구됩니다. 월 한도(설정 → AI 비용)에 도달하면 분석만 대기합니다.
