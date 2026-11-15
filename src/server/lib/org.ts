import { q1, q, type Db, pool } from "../db/pool.js";
import { DEFAULT_ORG_SETTINGS, type OrgSettings } from "../../shared/domain.js";

export async function getOrgSettings(orgId: string, db: Db = pool): Promise<OrgSettings> {
  const r = await q1<{ settings: Partial<OrgSettings> }>("SELECT settings FROM organizations WHERE id=$1", [orgId], db);
  const s = r?.settings ?? {};
  return {
    ...DEFAULT_ORG_SETTINGS,
    ...s,
    businessHours: { ...DEFAULT_ORG_SETTINGS.businessHours, ...(s.businessHours ?? {}) },
    eventPush: { ...(s.eventPush ?? {}) },
    reports: { ...DEFAULT_ORG_SETTINGS.reports, ...(s.reports ?? {}) },
  };
}

export const DEFAULT_AI_ROLES = [
  {
    role_key: "ops",
    display_name: "한서진",
    title: "운영비서",
    suit_color: "#22304f",
    appearance: { hair: "wave", accent: "pearl" },
    instructions:
      "일정, 할 일, 납기, 누락 업무, 미수금 확인 대상을 챙기고 대표 보고를 총괄한다. 문의 응대·견적 내용과 매출 분석은 다른 담당에게 넘기고, 운영 일정과 마감 관점에서만 짧게 보고한다.",
  },
  {
    role_key: "sales",
    display_name: "윤하린",
    title: "영업·상담 담당",
    suit_color: "#8d8f96",
    appearance: { hair: "bob", accent: "silver" },
    instructions:
      "문의 정리, 고객별 이력, 견적·답장 초안, 후속 연락과 계약 진행을 관리한다. 승인된 가격표·정책만 근거로 하며 새로운 가격·할인·계약 조건을 약속하지 않는다. 일정·미수금 총괄과 경영 분석은 다른 담당 영역이다.",
  },
  {
    role_key: "strategy",
    display_name: "강서연",
    title: "경영·전략 담당",
    suit_color: "#3a3a3c",
    appearance: { hair: "updo", accent: "gold" },
    instructions:
      "매출과 수익성, 전환율, 병목, 신규 상품과 영업 기회, 개선 아이디어를 분석한다. 근거가 부족하면 가설로 표시하고 예상 효과와 실제 성과를 구분한다. 개별 상담 응대와 일정 관리는 다른 담당 영역이다.",
  },
] as const;

export async function createOrganization(name: string, db: Db = pool) {
  const org = await q1<{ id: string }>(
    "INSERT INTO organizations(name, settings) VALUES ($1,$2) RETURNING id",
    [name, DEFAULT_ORG_SETTINGS],
    db,
  );
  for (const r of DEFAULT_AI_ROLES) {
    await q(
      `INSERT INTO ai_roles(org_id, role_key, display_name, title, suit_color, appearance, instructions)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [org!.id, r.role_key, r.display_name, r.title, r.suit_color, r.appearance, r.instructions],
      db,
    );
  }
  await q(
    `INSERT INTO integrations(org_id, provider, status) VALUES ($1,'kakao_counsel','not_connected') ON CONFLICT DO NOTHING`,
    [org!.id],
    db,
  );
  return org!.id;
}
