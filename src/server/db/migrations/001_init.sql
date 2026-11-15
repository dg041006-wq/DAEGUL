-- STAYSCENE OFFICE 초기 스키마
-- 모든 시각은 timestamptz(UTC 저장). 표시 시간대는 organizations.timezone(기본 Asia/Seoul).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────── 조직 / 사용자 / 권한 ─────────────
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Seoul',
  -- 영업시간, 알림 기준, 보고 일정, AI 월 한도, 보관 기간 등 (관리자 설정)
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

CREATE TABLE memberships (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner','staff')),
  -- 직원 추가 권한: view_all_conversations, view_finance, view_analytics
  perms       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('owner','staff')),
  perms        jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            text PRIMARY KEY,               -- sha256(token)
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ───────────── 연동 / 원본 이벤트 수신함 ─────────────
CREATE TABLE integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider         text NOT NULL,          -- demo | channeltalk | dealer:<name> | import
  -- not_connected: 미연동, sample: 샘플 데이터, testing: 테스트 채널 검증 중, verified: 실연동 검증 완료, error
  status           text NOT NULL DEFAULT 'not_connected'
                   CHECK (status IN ('not_connected','sample','testing','verified','error')),
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 비밀값 금지
  coverage_start   timestamptz,            -- 이 시점 이후 데이터만 수신 보장
  last_event_at    timestamptz,
  last_sync_at     timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE TABLE webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  external_event_id  text NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','processed','failed','ignored')),
  attempts           int NOT NULL DEFAULT 0,
  processed_at       timestamptz,
  error              text,
  UNIQUE (org_id, provider, external_event_id)
);
CREATE INDEX webhook_events_status_idx ON webhook_events(status, received_at);

-- 사용자가 직접 제공한 과거 기록 가져오기 (출처·기간 표시용)
CREATE TABLE data_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_label   text NOT NULL,
  period_start   timestamptz,
  period_end     timestamptz,
  message_count  int NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────── 대화 저장소 ─────────────
CREATE TABLE contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  external_user_id  text NOT NULL,
  display_name      text,             -- 공급사가 제공할 때만. 항상 있다고 가정하지 않음
  phone             text,             -- 동의·보관 조건 확인 전에는 저장하지 않는 것을 기본으로
  is_sample         boolean NOT NULL DEFAULT false,
  import_id         uuid REFERENCES data_imports(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, external_user_id)
);

CREATE TABLE conversations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider                   text NOT NULL,
  external_conversation_id   text NOT NULL,
  contact_id                 uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel                    text,             -- 예: kakao (공급사 제공 유입 구분)
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  assignee_user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  is_sample                  boolean NOT NULL DEFAULT false,
  import_id                  uuid REFERENCES data_imports(id) ON DELETE SET NULL,
  opened_at                  timestamptz NOT NULL,
  closed_at                  timestamptz,
  last_message_at            timestamptz,
  last_customer_message_at   timestamptz,
  last_staff_message_at      timestamptz,
  -- AI 분석 상태: none | queued | running | done | waiting_no_api | waiting_budget | failed
  ai_status                  text NOT NULL DEFAULT 'none',
  ai_summary                 text,
  ai_summary_through         timestamptz,      -- 증분 요약 커서 (이 시각까지의 메시지 반영)
  ai_missing_questions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_analyzed_at             timestamptz,
  ai_run_id                  uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, external_conversation_id)
);
CREATE INDEX conversations_org_last_idx ON conversations(org_id, last_message_at DESC);
CREATE INDEX conversations_assignee_idx ON conversations(org_id, assignee_user_id);

CREATE TABLE messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id       uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider              text NOT NULL,
  external_message_id   text NOT NULL,
  -- customer: 고객, staff: 실제 직원, bot: 자동 안내/봇, system: 시스템 이벤트
  sender_type           text NOT NULL CHECK (sender_type IN ('customer','staff','bot','system')),
  sender_external_id    text,
  staff_user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  sender_name           text,
  body                  text,
  attachments           jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at               timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  is_sample             boolean NOT NULL DEFAULT false,
  UNIQUE (org_id, provider, external_message_id)
);
CREATE INDEX messages_conv_time_idx ON messages(conversation_id, sent_at, id);

CREATE TABLE internal_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 작성 중 표시 / 중복 작성 방지
CREATE TABLE compose_locks (
  conversation_id  uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL
);

-- ───────────── 영업 기회 ─────────────
CREATE TABLE opportunities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title             text,
  -- 서비스 유형(복수): 숙소 촬영, 준공/공간 촬영, 브랜드 촬영, 인테리어 스타일링, 목공/부분 시공, 브랜딩/리스팅, 복합 문의, 기타/확인 필요
  services          text[] NOT NULL DEFAULT '{}',
  -- 유효 문의 vs 별도 집계
  category          text NOT NULL DEFAULT 'valid' CHECK (category IN ('valid','test','spam','existing_cs')),
  stage             text NOT NULL DEFAULT 'new'
                    CHECK (stage IN ('new','requirements','quoted','negotiating','won','on_hold','lost','waiting_contact')),
  -- 추출 정보 (값이 없으면 NULL = 미확인)
  space_type        text,
  region            text,
  size_text         text,
  room_count        int,
  desired_work      text,
  desired_schedule  text,
  stated_budget     text,
  quote_requested   boolean,
  source_channel    text,          -- 유입경로 (확인된 근거가 있을 때만)
  source_evidence   text,
  next_action       text,
  next_action_due   timestamptz,
  owner_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 필드별 근거: {"region": {"message_id": "...", "by": "ai|user", "at": "..."}}
  field_evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_into_id    uuid REFERENCES opportunities(id),
  duplicate_of_candidate uuid REFERENCES opportunities(id),
  is_sample         boolean NOT NULL DEFAULT false,
  opened_at         timestamptz NOT NULL,   -- 최초 고객 문의 시각
  last_contact_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunities_org_opened_idx ON opportunities(org_id, opened_at);
CREATE INDEX opportunities_contact_idx ON opportunities(contact_id);

CREATE TABLE opportunity_conversations (
  opportunity_id   uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  link_reason      text NOT NULL,  -- created | auto_same_contact_active | manual | merge
  linked_at        timestamptz NOT NULL DEFAULT now(),
  linked_by        uuid REFERENCES users(id),
  PRIMARY KEY (conversation_id)    -- 한 상담은 하나의 기회에만 속한다
);
CREATE INDEX opp_conv_opp_idx ON opportunity_conversations(opportunity_id);

-- 합치기 / 분리 이력
CREATE TABLE opportunity_merges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action         text NOT NULL CHECK (action IN ('merge','split','link','unlink')),
  source_ids     uuid[] NOT NULL,
  target_id      uuid,
  conversation_ids uuid[] NOT NULL DEFAULT '{}',
  reason         text,
  actor_user_id  uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stage_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id        uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  from_stage            text,
  to_stage              text NOT NULL,
  actor_type            text NOT NULL CHECK (actor_type IN ('user','ai','system')),
  actor_user_id         uuid REFERENCES users(id),
  reason                text,
  evidence_message_ids  uuid[] NOT NULL DEFAULT '{}',
  reverts_event_id      uuid REFERENCES stage_events(id),
  occurred_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_events_opp_idx ON stage_events(opportunity_id, occurred_at);

-- 이탈 사유 평가: 확인 / 추정 / 사유 불명을 분리
CREATE TABLE loss_assessments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id        uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  reason_code           text NOT NULL CHECK (reason_code IN
                        ('price','schedule','scope','competitor','cancelled','trust','service','other','unknown')),
  certainty             text NOT NULL CHECK (certainty IN ('confirmed','estimated','unknown')),
  evidence              text,
  evidence_message_ids  uuid[] NOT NULL DEFAULT '{}',
  confirmed_by_type     text NOT NULL CHECK (confirmed_by_type IN ('customer','user','ai')),
  confirmed_by_user_id  uuid REFERENCES users(id),
  alternative_explanations text,
  analysis_run_id       uuid,
  analyzed_at           timestamptz NOT NULL DEFAULT now(),
  superseded_at         timestamptz
);
CREATE INDEX loss_assess_opp_idx ON loss_assessments(opportunity_id);

-- ───────────── 견적 / 계약 / 입금 / 원가 ─────────────
CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  amount          numeric(14,0),
  currency        text NOT NULL DEFAULT 'KRW',
  sent_at         timestamptz NOT NULL,
  note            text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  amount          numeric(14,0),
  currency        text NOT NULL DEFAULT 'KRW',
  signed_at       timestamptz NOT NULL,
  channel         text NOT NULL DEFAULT 'kakao' CHECK (channel IN ('kakao','phone','email','in_person','other')),
  evidence        text NOT NULL,     -- 계약 근거 (담당자 입력 필수)
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id  uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  amount       numeric(14,0) NOT NULL,
  paid_at      timestamptz NOT NULL,
  note         text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE costs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id  uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  -- direct_*: 직접비, internal_labor: 내부 인건비 배분, fixed: 고정비 배분
  category     text NOT NULL CHECK (category IN ('direct_material','direct_outsourcing','direct_other','internal_labor','fixed')),
  amount       numeric(14,0) NOT NULL,
  incurred_at  timestamptz NOT NULL,
  note         text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────── 할 일 / 알림 ─────────────
CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             text NOT NULL,
  description       text,
  assignee_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at            timestamptz,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','system')),
  source_reason     text,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE CASCADE,
  opportunity_id    uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  dedupe_key        text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE UNIQUE INDEX tasks_dedupe_idx ON tasks(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,   -- 민감한 상담 원문을 넣지 않는다
  link        text,
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ───────────── 지식(승인된 정책) ─────────────
CREATE TABLE knowledge_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('price_list','service_scope','revision_policy','tone_guide')),
  version      int NOT NULL,
  title        text NOT NULL,
  content      text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','archived')),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, version)
);

-- ───────────── AI 직원 / 분석 기록 ─────────────
CREATE TABLE ai_roles (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_key      text NOT NULL CHECK (role_key IN ('marketing','cs','strategy')),
  display_name  text NOT NULL,
  title         text NOT NULL,
  suit_color    text NOT NULL,
  appearance    jsonb NOT NULL DEFAULT '{}'::jsonb,
  instructions  text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, role_key)
);

CREATE TABLE analysis_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                   text NOT NULL,  -- conversation_analysis | chat | meeting | report | reply_draft
  role_key               text,
  status                 text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','failed','skipped_no_api','skipped_budget')),
  engine                 text NOT NULL DEFAULT 'model' CHECK (engine IN ('model','rules')),
  model                  text,
  prompt_version         text,
  knowledge_version_ids  uuid[] NOT NULL DEFAULT '{}',
  scope                  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 기간, 대상 건수, 요청자 권한 범위
  requested_by           uuid REFERENCES users(id),
  input_tokens           int NOT NULL DEFAULT 0,
  output_tokens          int NOT NULL DEFAULT 0,
  cost_usd               numeric(12,6) NOT NULL DEFAULT 0,
  error                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  started_at             timestamptz,
  finished_at            timestamptz
);
CREATE INDEX analysis_runs_org_month_idx ON analysis_runs(org_id, created_at);

CREATE TABLE analysis_evidence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id  uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  message_id       uuid REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE CASCADE,
  opportunity_id   uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  note             text
);
CREATE INDEX analysis_evidence_run_idx ON analysis_evidence(analysis_run_id);

CREATE TABLE ai_threads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_key       text NOT NULL CHECK (role_key IN ('marketing','cs','strategy','meeting')),
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_messages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id              uuid NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  author                 text NOT NULL CHECK (author IN ('user','assistant')),
  user_id                uuid REFERENCES users(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'done' CHECK (status IN ('pending','running','done','failed')),
  content                text NOT NULL DEFAULT '',
  -- 고객에게 보낼 수 있는 초안은 내부 대화와 분리 저장
  customer_draft         text,
  next_actions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta                   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 기간, 대상 건수, 동기화 시점, 엔진
  analysis_run_id        uuid REFERENCES analysis_runs(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_thread_idx ON ai_messages(thread_id, created_at);

CREATE TABLE reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_key         text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('daily','weekly','adhoc')),
  title            text NOT NULL,
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  target_count     int NOT NULL DEFAULT 0,
  data_synced_at   timestamptz,
  body             text NOT NULL,
  metrics          jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_actions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 열람 필요 권한 (예: view_finance)
  required_perms   text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed')),
  analysis_run_id  uuid REFERENCES analysis_runs(id),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 초안 / 승인 / 실행 기록
CREATE TABLE approvals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('reply_draft','stage_change','content')),
  conversation_id    uuid REFERENCES conversations(id) ON DELETE CASCADE,
  opportunity_id     uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','approved','rejected','executed','failed','discarded')),
  requested_by_type  text NOT NULL CHECK (requested_by_type IN ('user','ai','system')),
  requested_by       uuid REFERENCES users(id),
  decided_by         uuid REFERENCES users(id),
  decided_at         timestamptz,
  executed_at        timestamptz,
  external_send_id   text,     -- 공급사 발송 ID (발송 기능 활성화 후)
  error              text,
  analysis_run_id    uuid REFERENCES analysis_runs(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type     text NOT NULL DEFAULT 'user',
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs(org_id, created_at DESC);

-- ───────────── 백그라운드 작업 큐 ─────────────
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5,
  dedupe_key    text,
  last_error    text,
  locked_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs(status, run_at);
CREATE UNIQUE INDEX jobs_dedupe_active_idx ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
