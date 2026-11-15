// 프런트엔드와 서버가 공유하는 도메인 상수 (스테이신 분류 체계)

export const SERVICE_TYPES = [
  "숙소 촬영",
  "준공/공간 촬영",
  "브랜드 촬영",
  "인테리어 스타일링",
  "목공/부분 시공",
  "브랜딩/리스팅",
  "복합 문의",
  "기타/확인 필요",
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const STAGES = [
  "new",
  "requirements",
  "quoted",
  "negotiating",
  "won",
  "on_hold",
  "lost",
  "waiting_contact",
] as const;
export type Stage = (typeof STAGES)[number];

export const MAIN_FUNNEL: Stage[] = ["new", "requirements", "quoted", "negotiating", "won"];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "신규 문의",
  requirements: "요구사항 확인",
  quoted: "견적 전달",
  negotiating: "협의",
  won: "계약 확정",
  on_hold: "보류",
  lost: "종료/이탈",
  waiting_contact: "연락 대기",
};

export const CATEGORIES = ["valid", "test", "spam", "existing_cs"] as const;
export const CATEGORY_LABELS: Record<(typeof CATEGORIES)[number], string> = {
  valid: "유효 문의",
  test: "테스트",
  spam: "스팸",
  existing_cs: "기존 작업 CS",
};

export const LOSS_REASONS = [
  "price",
  "schedule",
  "scope",
  "competitor",
  "cancelled",
  "trust",
  "service",
  "other",
  "unknown",
] as const;
export type LossReason = (typeof LOSS_REASONS)[number];
export const LOSS_REASON_LABELS: Record<LossReason, string> = {
  price: "가격/예산",
  schedule: "일정",
  scope: "작업 범위",
  competitor: "타사 선택",
  cancelled: "프로젝트 취소",
  trust: "신뢰/포트폴리오",
  service: "응대 불만",
  other: "기타",
  unknown: "사유 불명",
};

export const CERTAINTY_LABELS = {
  confirmed: "확인",
  estimated: "추정",
  unknown: "사유 불명",
} as const;

export const ROLE_KEYS = ["marketing", "cs", "strategy"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const STAFF_PERMS = ["view_all_conversations", "view_finance", "view_analytics"] as const;
export type StaffPerm = (typeof STAFF_PERMS)[number];
export const STAFF_PERM_LABELS: Record<StaffPerm, string> = {
  view_all_conversations: "전체 상담 조회",
  view_finance: "금액·재무 조회",
  view_analytics: "분석실 조회",
};

export const INTEGRATION_STATUS_LABELS = {
  not_connected: "미연동",
  sample: "샘플 데이터 / 카카오 미연동",
  testing: "테스트 채널 검증 중",
  verified: "실연동 검증 완료",
  error: "연동 오류",
} as const;

export const KNOWLEDGE_KINDS = {
  price_list: "가격표",
  service_scope: "서비스 범위",
  revision_policy: "수정 정책",
  tone_guide: "말투 가이드",
} as const;

export interface OrgSettings {
  businessHours: { days: number[]; start: string; end: string }; // days: 0=일 … 6=토 (KST)
  replyAlertMinutes: number; // 사람 답변 대기 알림 기준(영업시간 분)
  quoteFollowupBusinessDays: number; // 견적 후 회신 대기 후속 연락 기준(영업일) — 이탈 확정 아님
  reports: { dailyEnabled: boolean; dailyTime: string; weeklyEnabled: boolean; weeklyDay: number; weeklyTime: string };
  aiMonthlyBudgetUsd: number;
  retentionDays: number | null; // null = 무기한(설정 전)
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  businessHours: { days: [1, 2, 3, 4, 5], start: "10:00", end: "19:00" },
  replyAlertMinutes: 60,
  quoteFollowupBusinessDays: 3,
  reports: { dailyEnabled: false, dailyTime: "09:00", weeklyEnabled: false, weeklyDay: 1, weeklyTime: "09:00" },
  aiMonthlyBudgetUsd: 30,
  retentionDays: null,
};
