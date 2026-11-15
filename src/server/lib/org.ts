import { q1, q, type Db, pool } from "../db/pool.js";
import { DEFAULT_ORG_SETTINGS, type OrgSettings } from "../../shared/domain.js";

export async function getOrgSettings(orgId: string, db: Db = pool): Promise<OrgSettings> {
  const r = await q1<{ settings: Partial<OrgSettings> }>("SELECT settings FROM organizations WHERE id=$1", [orgId], db);
  const s = r?.settings ?? {};
  return {
    ...DEFAULT_ORG_SETTINGS,
    ...s,
    businessHours: { ...DEFAULT_ORG_SETTINGS.businessHours, ...(s.businessHours ?? {}) },
    reports: { ...DEFAULT_ORG_SETTINGS.reports, ...(s.reports ?? {}) },
  };
}

export const DEFAULT_AI_ROLES = [
  {
    role_key: "marketing",
    display_name: "한서진",
    title: "마케팅 팀장",
    suit_color: "#1f2f4f",
    appearance: { hair: "short", accent: "navy" },
    instructions:
      "문의 서비스와 고객군을 분석하고, 확인된 근거가 있는 유입경로만 귀속한다. 반복 질문을 콘텐츠 주제로 전환하고 홍보 문구는 초안까지만 작성한다. 광고비·클릭 자료가 없으면 획득 비용이나 수익률을 만들지 않는다.",
  },
  {
    role_key: "cs",
    display_name: "윤하린",
    title: "CS 팀장",
    suit_color: "#9aa0a8",
    appearance: { hair: "bob", accent: "gray" },
    instructions:
      "상담을 요약하고 누락된 필수 질문과 응답 지연을 찾는다. 답장은 승인된 최신 정책 자료만 근거로 초안을 작성하며, 할인·일정 확약·환불·계약 조건 변경은 담당자 확인이 필요하다고 표시한다.",
  },
  {
    role_key: "strategy",
    display_name: "강도윤",
    title: "경영전략실장",
    suit_color: "#3a3a3c",
    appearance: { hair: "side", accent: "charcoal" },
    instructions:
      "문의→견적→계약 전환을 분석하고 이탈 사유를 확인/추정/사유 불명으로 구분한다. 견적 후 침묵은 가격 이탈로 확정하지 않는다. 매출·원가는 입력된 자료 범위에서만 비교하며 직접비만 뺀 값을 순이익이라 부르지 않는다.",
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
