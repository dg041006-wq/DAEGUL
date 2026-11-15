# STAYSCENE OFFICE

스테이신 대표와 직원이 PC·휴대폰에서 함께 쓰는 내부 업무 앱(설치형 PWA)입니다.
문의 → 대응 → 계약 → 작업 일정 → 납품 → 정산까지 한 흐름으로 관리하고, AI 직원 3명(운영비서 · 영업·상담 담당 · 경영·전략 담당)이 필요한 순간 대표님께 먼저 보고합니다.

> **현재 상태:** 운영 배포 미완료(호스팅 계정 필요) · 카카오 상담톡 미연동 · 실제 AI 호출 미검증(API 키 필요).
> 정확한 구분과 검증 결과는 [`docs/STATUS.md`](docs/STATUS.md), 배포 절차는 [`docs/DEPLOY.md`](docs/DEPLOY.md).

## 주요 기능

- **대표실**: 오늘 우선순위, 답변 대기, 결정이 필요한 일, 마감 임박, 최근 보고, AI 직원 상태(처리 중·새 보고·실패)
- **AI 직원 보고방**: 신규 문의·계약 확정·입금 확인·일정 변경·취소·불만 신호·납기 위험·준비 누락 등을 담당 AI가 즉시 보고. 버튼으로 할 일 등록·다시 알림·답장 초안·담당 지정·처리 완료
- **정기 보고 (서버 실행, KST)**: 매일 19:00 일일 보고, 금요일 19:10 주간 보고. 놓친 회차 보충, 회차당 1건, 테스트 실행 분리
- **일정·작업**: 촬영·브랜딩·스타일링·시공 일정, 작업 전/후 체크리스트, 납품·수정, 첨부
- **정산**: 확인 입금 vs 확인 필요 입금(고객 주장·시트 기재), 시트 단가 vs 확정 금액, 미수금, 비용·공헌이익
- **고객 이력**, **통합 검색**, **경영 제안**(채택→할 일), **고객 발송 큐**(대표 보고와 분리)
- **업무 시트 가져오기**(.xlsx, 미리보기·확인 필요 표시·중복 방지) + 구글시트 읽기 전용 연동 구조 — [`docs/SHEET_MAPPING.md`](docs/SHEET_MAPPING.md)
- **웹 푸시**, PC↔휴대폰 실시간 동기화, 저장 상태·충돌 방지, 로그아웃 시 캐시·구독 삭제

## 구성

TypeScript · Fastify 5 · PostgreSQL 14+ · React 18(Vite) · PostgreSQL 기반 작업 큐 · Claude API(`claude-opus-5-5`) · Web Push(VAPID)

```
src/server/  db/migrations · ingest(수신) · integrations(공급사 어댑터) · lib(events, push, outbound, tasks, sheetImport, sheetsSync, realtime)
             analytics · ai(직원·분석·도구) · jobs(reports, ideas, automation, queue) · routes
src/web/     pages(대표실, 상담함, 일정·작업, 고객, 정산, AI 직원, 보고서, 경영 제안, 설정 …) · lib(api, realtime, pwa)
test/        자동 테스트 (51개)
docs/        STATUS · DEPLOY · SHEET_MAPPING · INTEGRATION · OPERATIONS · IMPORT_FORMAT
```

## 로컬 실행

Node.js 20+, PostgreSQL 14+ 필요.

```bash
cp .env.example .env
```

`.env`에 `DATABASE_URL`, `SESSION_SECRET`(32자 이상)을 채웁니다. 비밀값은 채팅·커밋에 넣지 마세요.

```bash
npm install
```

```bash
npm run db:migrate
```

대표 계정 만들기 (또는 `SETUP_TOKEN`을 설정하고 첫 화면에서 생성):

```bash
OWNER_EMAIL=you@example.com OWNER_NAME=대표 OWNER_PASSWORD='10자 이상 비밀번호' npm run admin:create-owner
```

```bash
npm run dev
```

로컬 확인용 샘플 데이터(`npm run db:seed-demo`)는 데모 계정을 만들므로 **운영 환경에서 실행하지 마세요.**

## 테스트

테스트 DB(`stayscene_test` 또는 `TEST_DATABASE_URL`)의 `public` 스키마를 초기화합니다.

```bash
npm test
```

```bash
npm run typecheck
```

## 배포

```bash
npm run build
```

```bash
npm start
```

`RUN_WORKER_IN_PROCESS=true`면 한 프로세스가 API·화면·워커·정기 보고를 모두 실행합니다. Docker/Render 설정과 절차는 [`docs/DEPLOY.md`](docs/DEPLOY.md), 백업·복원·보관 정책은 [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
