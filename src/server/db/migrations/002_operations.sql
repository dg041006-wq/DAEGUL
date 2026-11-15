-- v2: 작업/일정/정산, 활동 이력(사건), 대표 보고 피드, 푸시, 고객 발송 큐, 경영 제안, 첨부, 시트 가져오기

-- ── 데이터 출처 분리: live(실연동) / test(테스트 수신) / sample(샘플) / import(가져오기) / manual(수동 등록) / sheet(시트)
ALTER TABLE contacts      ADD COLUMN data_origin text NOT NULL DEFAULT 'live';
ALTER TABLE conversations ADD COLUMN data_origin text NOT NULL DEFAULT 'live';
ALTER TABLE opportunities ADD COLUMN data_origin text NOT NULL DEFAULT 'live';
UPDATE contacts SET data_origin = CASE WHEN is_sample THEN 'sample' WHEN import_id IS NOT NULL THEN 'import' ELSE data_origin END;
UPDATE conversations SET data_origin = CASE WHEN is_sample THEN 'sample' WHEN import_id IS NOT NULL THEN 'import' ELSE data_origin END;
UPDATE opportunities SET data_origin = 'sample' WHERE is_sample;
ALTER TABLE contacts ADD COLUMN email text, ADD COLUMN memo text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- 낙관적 동시성(오래된 화면으로 덮어쓰기 방지)
ALTER TABLE opportunities ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN version int NOT NULL DEFAULT 1, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN remind_at timestamptz, ADD COLUMN project_id uuid, ADD COLUMN contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE;

-- ── 작업(프로젝트): 촬영·스타일링·시공·브랜딩 일정 → 납품 → 수정 → 정산
CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  opportunity_id   uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  title            text NOT NULL,
  work_type        text,            -- 촬영 | 브랜딩 | 스타일링 | 시공 | 기타 (시트 '구분' 원문 보존)
  services         text[] NOT NULL DEFAULT '{}',
  package          text,            -- 패키지 | 베이직 | 스탠다드 | 프리미엄
  scheduled_date   date,            -- KST 날짜
  start_time       text,            -- 'HH:MM' (불확실하면 NULL + time_raw)
  time_raw         text,
  address          text,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('unscheduled','scheduled','in_progress','shot_done','delivering','delivered','revision','done','cancelled','on_hold')),
  listed_price     numeric(14,0),   -- 시트/견적상 단가 (확정 금액 아님)
  agreed_amount    numeric(14,0),   -- 담당자가 확정한 계약 금액
  delivery_due     date,
  delivered_at     timestamptz,
  revision_count   int NOT NULL DEFAULT 0,
  checklist        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id, phase:'pre'|'post', label, done, done_at}]
  notes            text,
  cash_receipt     text,            -- 현금영수증 등 증빙 메모
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  data_origin      text NOT NULL DEFAULT 'manual',
  source_ref       text,            -- 시트 행 등 출처
  flags            text[] NOT NULL DEFAULT '{}',   -- 확인 필요 표시
  version          int NOT NULL DEFAULT 1,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org_date_idx ON projects(org_id, scheduled_date);
CREATE INDEX projects_contact_idx ON projects(contact_id);
ALTER TABLE tasks ADD CONSTRAINT tasks_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- 팀 일정/부재/사업 일정 (고객 작업이 아닌 일정)
CREATE TABLE schedule_blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date          date NOT NULL,
  person_label  text,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  label         text NOT NULL,
  kind          text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','business')),
  data_origin   text NOT NULL DEFAULT 'manual',
  source_ref    text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_blocks_org_date_idx ON schedule_blocks(org_id, date);

-- 입금: '확인된 입금'(confirmed)과 고객 주장/시트 기재(claimed)를 구분. 집계는 confirmed만.
ALTER TABLE payments ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','claimed')),
  ADD COLUMN kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('deposit','balance','full','refund','other')),
  ADD COLUMN evidence text;
ALTER TABLE payments ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payments_target_chk CHECK (contract_id IS NOT NULL OR project_id IS NOT NULL);
ALTER TABLE costs ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE costs ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE, ADD COLUMN payee text;
ALTER TABLE costs ADD CONSTRAINT costs_target_chk CHECK (contract_id IS NOT NULL OR project_id IS NOT NULL);

-- ── 활동 이력(사건) — 즉시 보고·푸시의 근원. dedupe_key로 같은 사건 중복 방지
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  severity     text NOT NULL DEFAULT 'info' CHECK (severity IN ('critical','important','info')),
  role_key     text,
  title        text NOT NULL,          -- 원문 미포함 요약
  entity_type  text,
  entity_id    uuid,
  link         text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text NOT NULL,
  is_test      boolean NOT NULL DEFAULT false,
  reported     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, dedupe_key)
);
CREATE INDEX events_org_time_idx ON events(org_id, created_at DESC);

-- ── AI 직원 개편: 운영비서(ops) / 영업·상담(sales) / 경영·전략(strategy)
ALTER TABLE ai_roles DROP CONSTRAINT IF EXISTS ai_roles_role_key_check;
ALTER TABLE ai_threads DROP CONSTRAINT IF EXISTS ai_threads_role_key_check;
UPDATE ai_threads SET role_key='sales' WHERE role_key='cs';
UPDATE ai_threads SET role_key='ops' WHERE role_key='marketing';
UPDATE ai_roles SET role_key='sales' WHERE role_key='cs';
UPDATE ai_roles SET role_key='ops' WHERE role_key='marketing';
ALTER TABLE ai_roles ADD CONSTRAINT ai_roles_role_key_check CHECK (role_key IN ('ops','sales','strategy'));
ALTER TABLE ai_threads ADD CONSTRAINT ai_threads_role_key_check CHECK (role_key IN ('ops','sales','strategy','meeting'));
ALTER TABLE ai_threads ADD COLUMN kind text NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','feed'));
CREATE UNIQUE INDEX ai_threads_feed_idx ON ai_threads(org_id, owner_user_id, role_key) WHERE kind='feed';
ALTER TABLE ai_messages ADD COLUMN kind text NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','alert','report','action_result')),
  ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  ADD COLUMN read_at timestamptz;
ALTER TABLE ai_messages DROP CONSTRAINT IF EXISTS ai_messages_status_check;
ALTER TABLE ai_messages ADD CONSTRAINT ai_messages_status_check CHECK (status IN ('pending','running','done','failed'));
ALTER TABLE analysis_runs ADD COLUMN error_kind text;   -- auth | billing | permission | rate_limit | overloaded | network | refusal | invalid | other

-- ── 알림/푸시
ALTER TABLE notifications ADD COLUMN severity text NOT NULL DEFAULT 'info',
  ADD COLUMN push_status text NOT NULL DEFAULT 'not_required' CHECK (push_status IN ('not_required','pending','sent','failed','no_subscription')),
  ADD COLUMN push_error text, ADD COLUMN event_id uuid REFERENCES events(id) ON DELETE SET NULL;
CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_error      text,
  disabled_at     timestamptz
);
CREATE TABLE app_secrets (key text PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- ── 정기 보고: 기간 키로 중복 방지, 테스트 보고 분리
ALTER TABLE reports ADD COLUMN period_key text, ADD COLUMN is_test boolean NOT NULL DEFAULT false, ADD COLUMN cutoff_at timestamptz;
CREATE UNIQUE INDEX reports_period_idx ON reports(org_id, kind, period_key, is_test) WHERE period_key IS NOT NULL;

-- ── 고객 발송 큐 (대표 내부 보고와 분리)
CREATE TABLE outbound_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id     uuid REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contacts(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('provider','manual')),
  provider            text,
  recipient_label     text NOT NULL,
  body                text NOT NULL,
  status              text NOT NULL DEFAULT 'pending_approval'
                      CHECK (status IN ('pending_approval','queued','sending','sent','failed','unknown','sent_manually','cancelled','blocked_no_provider')),
  idempotency_key     text NOT NULL,
  provider_message_id text,
  attempts            int NOT NULL DEFAULT 0,
  last_error          text,
  created_by_type     text NOT NULL CHECK (created_by_type IN ('user','ai','auto_rule')),
  created_by          uuid REFERENCES users(id),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  rule_id             uuid,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);
CREATE TABLE auto_reply_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  trigger     text NOT NULL CHECK (trigger IN ('outside_hours_first_message')),
  template    text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 경영 제안: 같은 아이디어 반복 방지(idea_key), 결정 기록, 채택 → 할 일
CREATE TABLE ideas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idea_key         text NOT NULL,
  category         text NOT NULL,
  title            text NOT NULL,
  evidence         text NOT NULL,
  evidence_refs    jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_effect  text NOT NULL,
  effort           text NOT NULL,
  first_action     text NOT NULL,
  is_hypothesis    boolean NOT NULL DEFAULT true,
  importance       text NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal','high')),
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','adopted','held','rejected')),
  decision_reason  text,
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  task_id          uuid REFERENCES tasks(id) ON DELETE SET NULL,
  success_metric   text,
  actual_result    text,
  source           text NOT NULL DEFAULT 'rules' CHECK (source IN ('rules','model')),
  reported_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idea_key)
);

-- ── 첨부 (DB 저장, 10MB 제한은 API에서)
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id   uuid REFERENCES contacts(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size_bytes   int NOT NULL,
  data         bytea NOT NULL,
  uploaded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (contact_id IS NOT NULL OR project_id IS NOT NULL OR conversation_id IS NOT NULL)
);

-- ── 시트 가져오기 (미리보기 → 확정)
CREATE TABLE sheet_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_kind   text NOT NULL CHECK (source_kind IN ('xlsx_upload','google_sheets')),
  source_label  text NOT NULL,
  file_sha256   text,
  status        text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','committed','discarded')),
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz
);
CREATE TABLE sheet_import_rows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       uuid NOT NULL REFERENCES sheet_imports(id) ON DELETE CASCADE,
  sheet_name      text NOT NULL,
  row_number      int NOT NULL,
  classification  text NOT NULL CHECK (classification IN ('booking','personal','business','note','empty_day','header')),
  raw             jsonb NOT NULL,
  parsed          jsonb NOT NULL,
  flags           text[] NOT NULL DEFAULT '{}',
  decision        text NOT NULL DEFAULT 'import' CHECK (decision IN ('import','skip','review')),
  dedupe_key      text,
  duplicate_of    text,
  created_refs    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX sheet_import_rows_import_idx ON sheet_import_rows(import_id, row_number);
-- 같은 원본 행을 다시 가져와도 중복 생성하지 않도록
CREATE TABLE sheet_row_links (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dedupe_key  text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  block_id    uuid REFERENCES schedule_blocks(id) ON DELETE CASCADE,
  import_id   uuid REFERENCES sheet_imports(id) ON DELETE SET NULL,
  PRIMARY KEY (org_id, dedupe_key)
);
CREATE TABLE sheet_sync_config (
  org_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  spreadsheet_id  text,
  sheet_name      text,
  enabled         boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected','configured','verified','error')),
  last_sync_at    timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 개편된 역할 기본값 (대표가 이미 수정한 값은 유지: 기존 기본 직함일 때만 갱신)
UPDATE ai_roles SET display_name='한서진', title='운영비서', suit_color='#22304f',
  appearance='{"hair":"wave","accent":"pearl"}'::jsonb,
  instructions='일정, 할 일, 납기, 누락 업무, 미수금 확인 대상을 챙기고 대표 보고를 총괄한다. 문의 응대·견적 내용과 매출 분석은 다른 담당에게 넘기고, 운영 일정과 마감 관점에서만 짧게 보고한다.'
  WHERE role_key='ops' AND title IN ('마케팅 팀장');
UPDATE ai_roles SET display_name='윤하린', title='영업·상담 담당', suit_color='#8d8f96',
  appearance='{"hair":"bob","accent":"silver"}'::jsonb,
  instructions='문의 정리, 고객별 이력, 견적·답장 초안, 후속 연락과 계약 진행을 관리한다. 승인된 가격표·정책만 근거로 하며 새로운 가격·할인·계약 조건을 약속하지 않는다. 일정·미수금 총괄과 경영 분석은 다른 담당 영역이다.'
  WHERE role_key='sales' AND title IN ('CS 팀장');
UPDATE ai_roles SET display_name='강서연', title='경영·전략 담당', suit_color='#3a3a3c',
  appearance='{"hair":"updo","accent":"gold"}'::jsonb,
  instructions='매출과 수익성, 전환율, 병목, 신규 상품과 영업 기회, 개선 아이디어를 분석한다. 근거가 부족하면 가설로 표시하고 예상 효과와 실제 성과를 구분한다. 개별 상담 응대와 일정 관리는 다른 담당 영역이다.'
  WHERE role_key='strategy' AND title IN ('경영전략실장');

-- 정기 보고 기본값: 매일 19:00, 금요일 19:10 (KST). 기존 조직 설정에도 적용(대표가 바꾸지 않았던 기존 기본값만)
UPDATE organizations SET settings = jsonb_set(settings, '{reports}',
  '{"dailyEnabled":true,"dailyTime":"19:00","weeklyEnabled":true,"weeklyDay":5,"weeklyTime":"19:10"}'::jsonb)
  WHERE settings->'reports' IS NULL OR settings->'reports' = '{"dailyEnabled":false,"dailyTime":"09:00","weeklyEnabled":false,"weeklyDay":1,"weeklyTime":"09:00"}'::jsonb;
