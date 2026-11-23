-- STAYSCENE Styling Studio (외부 인테리어 업체 + 스테이신 내부)
-- 기존 OFFICE(내부 업무) 테이블과 분리: 외부 업체 계정이 내부 상담·정산 데이터에 접근하지 못하도록 계정·세션도 별도.

CREATE TABLE studio_workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'vendor' CHECK (kind IN ('vendor','internal')),
  -- 한도: monthlyRenders, monthlyAiEdits, maxProjects
  limits      jsonb NOT NULL DEFAULT '{"monthlyRenders":300,"monthlyAiEdits":0}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE studio_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  is_ops         boolean NOT NULL DEFAULT false, -- 스테이신 운영자(상담 접수·사용량 확인)
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

CREATE TABLE studio_members (
  workspace_id uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','editor')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE studio_sessions (
  id            text PRIMARY KEY, -- sha256(token)
  user_id       uuid NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

-- 초대 코드(초기 초대형 운영): 운영자가 발급, 업체가 가입하며 작업공간 생성
CREATE TABLE studio_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  email        text,
  workspace_name text,
  created_by   uuid REFERENCES studio_users(id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 비공개 파일 (원본은 변경 없이 보관)
CREATE TABLE studio_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES studio_workspaces(id) ON DELETE CASCADE, -- NULL = 공용 카탈로그
  kind          text NOT NULL,
  storage_key   text NOT NULL,
  mime          text NOT NULL,
  bytes         bigint NOT NULL,
  sha256        text NOT NULL,
  width         int,
  height        int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX studio_files_ws_idx ON studio_files(workspace_id);

CREATE TABLE studio_projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  client_name   text,
  is_sample     boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES studio_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX studio_projects_ws_idx ON studio_projects(workspace_id);

CREATE TABLE studio_rooms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- [{id,label,world:[x,y,z] m, measured:bool}]
  ref_points    jsonb NOT NULL DEFAULT '[]'::jsonb,
  scale_measured boolean NOT NULL DEFAULT false,
  scale_note    text,
  -- 바닥 경계(벽) 다각형 [[x,z],...] m — 벽 관통 경고용(선택)
  floor_bounds  jsonb,
  -- 월드 조명(방 공유): sunAzimuthDeg, sunElevationDeg, sunIntensity, colorTempK, softness, ambient, shadowStrength, contactShadow
  lighting      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rev           int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE studio_photos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          uuid NOT NULL REFERENCES studio_rooms(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  label            text NOT NULL,
  sort             int NOT NULL DEFAULT 0,
  original_file_id uuid NOT NULL REFERENCES studio_files(id),
  master_file_id   uuid NOT NULL REFERENCES studio_files(id), -- 방향·색공간 정규화된 무손실 PNG
  preview_file_id  uuid NOT NULL REFERENCES studio_files(id), -- 편집 화면용 축소본
  width            int NOT NULL,
  height           int NOT NULL,
  preview_width    int NOT NULL,
  preview_height   int NOT NULL,
  exif             jsonb NOT NULL DEFAULT '{}'::jsonb, -- 정리된 값만 (초점, 기기, 방향, GPS 유무)
  -- {points:[{refId,u,v,check}], focalMode:'auto'|'exif'|'manual', focal35?, result:{...}}
  calibration      jsonb NOT NULL DEFAULT '{"points":[],"focalMode":"auto"}'::jsonb,
  calib_status     text NOT NULL DEFAULT 'uncalibrated' CHECK (calib_status IN ('uncalibrated','estimated','measured','failed')),
  calib_rev        int NOT NULL DEFAULT 0,
  -- 시점별 노출·화이트밸런스·초점 흐림·노이즈
  view_adjust      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {occluders:[{id,points:[[u,v]...]}], protected:[...]} (마스터 픽셀 좌표)
  masks            jsonb NOT NULL DEFAULT '{"occluders":[],"protected":[]}'::jsonb,
  masks_rev        int NOT NULL DEFAULT 0,
  replaces_photo_id uuid REFERENCES studio_photos(id),
  replaced_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX studio_photos_room_idx ON studio_photos(room_id);

-- 가구 제품. workspace_id NULL = 스테이신 기본 카탈로그(모든 업체 읽기 가능)
CREATE TABLE studio_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  brand         text,
  model_code    text,
  category      text NOT NULL DEFAULT 'sofa',
  color         text,
  material      text,
  source_url    text, -- 기록용. 자동 수집하지 않음
  -- model3d: 검증된 3D 에셋 / photo: 상품 사진 / concept: 콘셉트(제품 미확정)
  kind          text NOT NULL CHECK (kind IN ('model3d','photo','concept')),
  size_options  jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{label,w,d,h}] cm
  notes         text,
  current_version_id uuid,
  created_by    uuid REFERENCES studio_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

-- 에셋 버전은 불변. 파일 교체 = 새 버전. 이전 시안은 이전 버전을 계속 참조.
CREATE TABLE studio_asset_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL REFERENCES studio_assets(id) ON DELETE CASCADE,
  version       int NOT NULL,
  glb_file_id   uuid REFERENCES studio_files(id),
  thumb_file_id uuid REFERENCES studio_files(id),
  -- [{fileId, cutoutFileId, azimuthDeg, elevationDeg, label}]
  ref_photos    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- units, frontAxis, pivot, measuredBBoxCm{w,d,h}, textureStatus, provenance, license
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- verified: 치수·방향·재질 확인된 3D / unverified: 미확인 3D / appearance: 사진 기반 외관
  verification  text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('verified','unverified','appearance')),
  created_by    uuid REFERENCES studio_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version)
);

CREATE TABLE studio_variants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES studio_rooms(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  copied_from_variant_id uuid REFERENCES studio_variants(id),
  head_version_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

-- 안 버전: 머리 버전(draft)은 수정 가능, 공유·승인·수동 저장 시 잠김 → 이후 수정은 새 버전
CREATE TABLE studio_variant_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id    uuid NOT NULL REFERENCES studio_variants(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  version       int NOT NULL,
  parent_version_id uuid REFERENCES studio_variant_versions(id),
  -- {placements:[...], lighting:{...}}
  state         jsonb NOT NULL,
  -- 이 버전이 시작된 상태(복제·이전 버전). 변경 요약의 기준
  base_state    jsonb,
  -- 이전 잠긴 버전 대비 실제 변경값 [{kind,text,placementId?}]
  summary       jsonb NOT NULL DEFAULT '[]'::jsonb,
  note          text,
  rev           int NOT NULL DEFAULT 1,
  locked_at     timestamptz,
  locked_reason text CHECK (locked_reason IN ('saved','shared','approved')),
  approved_at   timestamptz,
  created_by    uuid REFERENCES studio_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, version)
);

CREATE TABLE studio_render_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  variant_version_id uuid NOT NULL REFERENCES studio_variant_versions(id) ON DELETE CASCADE,
  photo_id         uuid NOT NULL REFERENCES studio_photos(id) ON DELETE CASCADE,
  input_hash       text NOT NULL, -- 같은 입력 식별(중복 렌더 방지)
  -- 입력 스냅샷: 에셋 버전, 보정 rev, 마스크 rev, 렌더러 버전
  inputs           jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','canceled')),
  attempts         int NOT NULL DEFAULT 0,
  error_code       text,
  error_detail     text,
  -- {masterFileId, deliveryFileId, previewFileId, alphaFileId, shadowFileId, qa:{...}}
  outputs          jsonb,
  -- 근거 상태: verified_model | unverified_model | appearance_estimate | needs_reference
  evidence         text,
  duration_ms      int,
  cost_usd         numeric(10,4) NOT NULL DEFAULT 0,
  requested_by     uuid REFERENCES studio_users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  locked_by        text,
  locked_until     timestamptz
);
CREATE UNIQUE INDEX studio_render_inflight_uq ON studio_render_jobs(input_hash, variant_version_id, photo_id) WHERE status IN ('queued','running');
CREATE INDEX studio_render_vv_idx ON studio_render_jobs(variant_version_id, photo_id);

CREATE TABLE studio_share_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  room_id       uuid NOT NULL REFERENCES studio_rooms(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  title         text NOT NULL,
  client_name   text,
  -- [{variantVersionId, label, renderJobIds:[...]}] — 선택한 결과만 공개
  items         jsonb NOT NULL,
  show_branding boolean NOT NULL DEFAULT true,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES studio_users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE studio_share_feedback (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id           uuid NOT NULL REFERENCES studio_share_links(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  variant_version_id uuid NOT NULL REFERENCES studio_variant_versions(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('comment','select','approve')),
  author_name        text NOT NULL,
  body               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- 스테이신 정밀 합성·촬영·스타일링 상담 요청. 업체가 공개 범위를 고른 자료만 운영자가 열람.
CREATE TABLE studio_consult_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('precision_composite','shooting','styling','other')),
  message       text,
  problem_note  text,
  -- {photoIds:[], variantVersionIds:[], renderJobIds:[]}
  included      jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_review','closed')),
  ops_note      text,
  created_by    uuid REFERENCES studio_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE studio_usage (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES studio_projects(id) ON DELETE SET NULL,
  kind          text NOT NULL, -- render | ai_edit
  job_id        uuid,
  units         int NOT NULL DEFAULT 1,
  cost_usd      numeric(10,4) NOT NULL DEFAULT 0,
  duration_ms   int,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX studio_usage_ws_idx ON studio_usage(workspace_id, created_at);

-- 외부 공급자(이미지 API 등)로 보낸 자료 기록
CREATE TABLE studio_provider_log (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  job_id        uuid,
  sent          jsonb NOT NULL, -- 파일 id·용도만 (본문·키·서명 URL 금지)
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 운영 지표(샘플→첫 프로젝트→첫 검수→첫 공유→고객 선택/의견) + 작업 시간
CREATE TABLE studio_events (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  project_id    uuid,
  user_id       uuid,
  name          text NOT NULL,
  props         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX studio_events_ws_idx ON studio_events(workspace_id, name);

-- 파일럿 작업 기록(사용 전/후, 사람 작업 시간)
CREATE TABLE studio_pilot_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES studio_workspaces(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  before_method text,
  before_minutes int,
  needed_exact_product boolean,
  delivered_to_client boolean,
  reused_for_revision boolean,
  would_use_again boolean,
  human_minutes int,
  notes         text,
  created_by    uuid REFERENCES studio_users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
