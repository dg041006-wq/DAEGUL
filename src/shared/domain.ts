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

export const ROLE_KEYS = ["ops", "sales", "strategy"] as const;
export const ROLE_LABELS: Record<string, string> = { ops: "운영비서", sales: "영업·상담 담당", strategy: "경영·전략 담당", meeting: "전체 회의" };
export type RoleKey = (typeof ROLE_KEYS)[number];

export const STAFF_PERMS = ["view_all_conversations", "view_finance", "view_analytics", "send_messages"] as const;
export type StaffPerm = (typeof STAFF_PERMS)[number];
export const STAFF_PERM_LABELS: Record<StaffPerm, string> = {
  view_all_conversations: "전체 상담 조회",
  view_finance: "금액·재무 조회",
  view_analytics: "분석실 조회",
  send_messages: "고객 발송 승인",
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
  reports: { dailyEnabled: boolean; dailyTime: string; weeklyEnabled: boolean; weeklyDay: number; weeklyTime: string }; // KST. 기본 매일 19:00 / 금 19:10
  aiMonthlyBudgetUsd: number;
  aiDailyCallCap: number; // 하루 모델 호출 상한 (무한 호출 방지)
  aiHourlyCallCap: number;
  retentionDays: number | null; // null = 무기한(설정 전)
  pushMinSeverity: "critical" | "important" | "info" | "off"; // 이 중요도 이상만 푸시
  eventPush: Record<string, "critical" | "important" | "info">; // 사건 종류별 중요도 재정의
  awaitingAlertRepeatHours: number; // '답변 대기' 묶음 보고 반복 간격
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  businessHours: { days: [1, 2, 3, 4, 5], start: "10:00", end: "19:00" },
  replyAlertMinutes: 60,
  quoteFollowupBusinessDays: 3,
  reports: { dailyEnabled: true, dailyTime: "19:00", weeklyEnabled: true, weeklyDay: 5, weeklyTime: "19:10" },
  aiMonthlyBudgetUsd: 30,
  aiDailyCallCap: 200,
  aiHourlyCallCap: 40,
  retentionDays: null,
  pushMinSeverity: "important",
  eventPush: {},
  awaitingAlertRepeatHours: 3,
};

export const EVENT_KINDS: Record<string, { label: string; severity: "critical" | "important" | "info"; role: "ops" | "sales" | "strategy" }> = {
  new_inquiry: { label: "신규 문의", severity: "important", role: "sales" },
  contract_confirmed: { label: "계약 확정", severity: "critical", role: "sales" },
  payment_confirmed: { label: "입금 확인", severity: "critical", role: "ops" },
  payment_claimed: { label: "고객 입금 주장(미확인)", severity: "info", role: "ops" },
  schedule_changed: { label: "일정 변경", severity: "important", role: "ops" },
  cancelled: { label: "취소/이탈", severity: "important", role: "sales" },
  complaint: { label: "불만 신호", severity: "critical", role: "sales" },
  delivery_risk: { label: "납기 위험", severity: "critical", role: "ops" },
  prep_missing: { label: "촬영 준비 누락", severity: "important", role: "ops" },
  awaiting_reply: { label: "답변 대기", severity: "important", role: "sales" },
  job_failure: { label: "중요 작업 실패", severity: "critical", role: "ops" },
  report_ready: { label: "정기 보고", severity: "important", role: "ops" },
  idea_high: { label: "중요 개선 기회", severity: "important", role: "strategy" },
  status_change: { label: "단순 상태 변화", severity: "info", role: "ops" },
};

export const PROJECT_STATUSES = ["unscheduled", "scheduled", "in_progress", "shot_done", "delivering", "delivered", "revision", "done", "cancelled", "on_hold"] as const;
export const PROJECT_STATUS_LABELS: Record<string, string> = {
  unscheduled: "날짜 미정",
  scheduled: "예정",
  in_progress: "진행중",
  shot_done: "작업 완료(납품 전)",
  delivering: "납품 준비",
  delivered: "납품 완료",
  revision: "수정 요청",
  done: "완료",
  cancelled: "취소",
  on_hold: "보류",
};
export const WORK_TYPES = ["촬영", "브랜딩", "스타일링", "시공", "기타"] as const;
export const PACKAGES = ["패키지", "베이직", "스탠다드", "프리미엄"] as const;

export const DEFAULT_CHECKLIST = {
  pre: ["주소·출입 방법 확인", "촬영 시간 확정", "주차 가능 여부 확인", "현장 준비사항 안내 발송", "계약금 입금 확인"],
  post: ["보정 컷 수 확인", "1차 납품", "수정 요청 반영", "최종 납품", "잔금 입금 확인"],
};
