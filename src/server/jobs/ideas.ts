// 경영·전략 담당의 개선 제안. 사건/정해진 주기(일 1회)로만 실행하며 무한 반복 호출을 하지 않는다.
// 규칙 기반 탐지 → 근거 수치가 있는 제안만 생성. 근거가 약하면 '가설'로 표시.
// 같은 아이디어(idea_key)는 한 번만 제안하고, 채택·보류·기각 이후에도 다시 제안하지 않는다.
import { q, q1 } from "../db/pool.js";
import { recordEvent } from "../lib/events.js";

interface Candidate {
  key: string;
  category: string;
  title: string;
  evidence: string;
  refs?: unknown[];
  expected: string;
  effort: string;
  first: string;
  hypothesis: boolean;
  high?: boolean;
}

async function detect(orgId: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const notTest = `data_origin NOT IN ('test','sample')`;

  // 1) 견적 후 이탈/회신 대기 → 후속 연락 시점 표준화
  const qw = await q1<{ n: number; total: number }>(
    `SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id
                                              WHERE oc.opportunity_id=o.id AND m.sender_type='customer' AND m.sent_at > lq.sent_at)) AS n,
            count(*) AS total
     FROM opportunities o JOIN LATERAL (SELECT sent_at FROM quotes WHERE opportunity_id=o.id ORDER BY sent_at DESC LIMIT 1) lq ON true
     WHERE o.org_id=$1 AND o.${notTest} AND o.stage IN ('quoted','negotiating','lost') AND lq.sent_at > now() - interval '60 days'`,
    [orgId],
  );
  if ((qw?.total ?? 0) >= 3 && (qw!.n ?? 0) >= 2)
    out.push({
      key: "quote_followup_timing:v1",
      category: "견적 후 이탈",
      title: "견적 발송 후 2영업일·5영업일 후속 연락 표준화",
      evidence: `최근 60일 견적 ${qw!.total}건 중 ${qw!.n}건이 견적 이후 고객 회신 없음`,
      expected: "회신 대기 건 일부를 협의 단계로 되살릴 가능성 (효과는 실행 후 측정)",
      effort: "템플릿 작성 30분 + 건당 2분",
      first: "견적 후 확인 문구 1개를 승인 자료(말투 가이드)에 등록",
      hypothesis: true,
      high: (qw!.n ?? 0) >= 5,
    });

  // 2) 반복 문의 키워드 → 안내 개선
  const kws = await q<{ kw: string; n: number }>(
    `SELECT kw, count(DISTINCT conversation_id) AS n FROM (
       SELECT m.conversation_id, m.body, unnest(ARRAY['주차','가격','비용','일정','보정','원본','수정','컷','소요','계약금','환불','준비']) AS kw
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.org_id=$1 AND m.sender_type='customer' AND c.${notTest} AND m.sent_at > now() - interval '60 days') x
     WHERE body ILIKE '%' || kw || '%' GROUP BY kw HAVING count(DISTINCT conversation_id) >= 3 ORDER BY n DESC LIMIT 2`,
    [orgId],
  );
  for (const k of kws)
    out.push({
      key: `faq:${k.kw}`,
      category: "반복 문의 안내",
      title: `'${k.kw}' 관련 사전 안내문 만들기`,
      evidence: `최근 60일 상담 ${k.n}건에서 고객이 '${k.kw}' 관련 내용을 언급`,
      expected: "첫 응답 시간 단축과 반복 답변 감소 (예상)",
      effort: "안내문 작성 20분",
      first: `'${k.kw}' 안내 문구를 승인 자료에 등록하고 첫 답장 초안에 포함`,
      hypothesis: false,
    });

  // 3) 재의뢰·소개: 같은 고객의 작업이 2건 이상
  const rep = await q1<{ customers: number; jobs: number }>(
    `SELECT count(*) AS customers, COALESCE(sum(n),0) AS jobs FROM (SELECT contact_id, count(*) AS n FROM projects WHERE org_id=$1 AND contact_id IS NOT NULL AND ${notTest} AND status <> 'cancelled' GROUP BY contact_id HAVING count(*) >= 2) x`,
    [orgId],
  );
  if ((rep?.customers ?? 0) >= 2)
    out.push({
      key: "repeat_customers:v1",
      category: "재의뢰·소개",
      title: "재의뢰 고객 대상 소개/재방문 혜택 기준 만들기",
      evidence: `작업 2건 이상 맡긴 고객 ${rep!.customers}명 (작업 ${rep!.jobs}건)`,
      expected: "기존 고객 재의뢰·소개 유입 증가 가능성 (가격·혜택은 대표 결정 필요)",
      effort: "기준 정리 1시간",
      first: "재의뢰 고객 목록을 고객 화면에서 확인하고 감사 연락 대상 3명 선정",
      hypothesis: true,
    });

  // 4) 묶음 상품: 같은 고객이 서로 다른 작업 구분(촬영·브랜딩·시공 등)을 맡김
  const bundle = await q1<{ n: number }>(
    `SELECT count(*) AS n FROM (SELECT contact_id FROM projects WHERE org_id=$1 AND contact_id IS NOT NULL AND work_type IS NOT NULL AND ${notTest}
       GROUP BY contact_id HAVING count(DISTINCT work_type) >= 2) x`,
    [orgId],
  );
  if ((bundle?.n ?? 0) >= 1)
    out.push({
      key: "bundle_package:v1",
      category: "묶음 상품",
      title: "촬영 + 브랜딩(안내책자·키트) 묶음 구성 검토",
      evidence: `서로 다른 작업 구분을 함께 맡긴 고객 ${bundle!.n}명`,
      expected: "건당 작업 규모 확대 가능성 (가격은 승인 전 제안하지 않음)",
      effort: "구성안 작성 1시간",
      first: "기존 묶음 고객의 작업 내역을 보고 구성 초안 작성",
      hypothesis: true,
    });

  // 5) 시간 대비 수익: 낮은 단가 구간 비중 (작업 시간 기록이 없어 단가만으로 본 가설)
  const band = await q1<{ low: number; total: number }>(
    `SELECT count(*) FILTER (WHERE COALESCE(agreed_amount, listed_price) <= 120000) AS low, count(*) AS total
     FROM projects WHERE org_id=$1 AND ${notTest} AND COALESCE(agreed_amount, listed_price) > 0 AND status <> 'cancelled'`,
    [orgId],
  );
  if ((band?.total ?? 0) >= 10 && band!.low / band!.total >= 0.25)
    out.push({
      key: "low_price_band:v1",
      category: "수익성",
      title: "12만원 이하 소규모 작업의 이동·보정 시간 기록 시작",
      evidence: `단가 기록이 있는 작업 ${band!.total}건 중 ${band!.low}건(${Math.round((band!.low / band!.total) * 100)}%)이 12만원 이하 (작업 시간 기록 없음)`,
      expected: "시간 대비 수익이 낮은 유형을 확인해 최소 금액·지역 기준을 정할 근거 확보",
      effort: "작업마다 소요 시간 1줄 기록",
      first: "다음 5건 작업에 이동·촬영·보정 시간을 메모로 기록",
      hypothesis: true,
    });

  // 6) 무상/0원 작업
  const zero = await q1<{ n: number }>(`SELECT count(*) AS n FROM projects WHERE org_id=$1 AND ${notTest} AND listed_price = 0 AND agreed_amount IS NULL`, [orgId]);
  if ((zero?.n ?? 0) >= 3)
    out.push({
      key: "zero_price_jobs:v1",
      category: "수익성",
      title: "0원 작업(포트폴리오·지인·묶음 포함 여부) 기준 정리",
      evidence: `단가 0원으로 기록된 작업 ${zero!.n}건`,
      expected: "무상 작업이 다른 계약에 포함된 것인지 구분돼 실제 수익성 파악 가능",
      effort: "30분",
      first: "0원 작업 목록을 정산 화면에서 확인하고 묶음 계약 여부 표시",
      hypothesis: false,
    });

  // 7) 납품 지연·수정 요청
  const rev = await q1<{ n: number }>(`SELECT count(*) AS n FROM projects WHERE org_id=$1 AND ${notTest} AND (revision_count >= 2 OR (delivered_at IS NOT NULL AND delivery_due IS NOT NULL AND delivered_at::date > delivery_due))`, [orgId]);
  if ((rev?.n ?? 0) >= 2)
    out.push({
      key: "revision_checklist:v1",
      category: "납품·수정",
      title: "촬영 전 컷 리스트 합의로 수정 요청 줄이기",
      evidence: `수정 2회 이상 또는 납기 초과 작업 ${rev!.n}건`,
      expected: "수정 횟수·납기 지연 감소 (예상)",
      effort: "체크리스트 항목 1개 추가",
      first: "촬영 전 체크리스트에 '필수 컷 목록 고객 확인'을 추가",
      hypothesis: true,
    });

  // 8) 새 영업 대상: 숙박 키워드가 있는 작업 비중
  const stay = await q1<{ n: number; total: number }>(
    `SELECT count(*) FILTER (WHERE (title || ' ' || COALESCE(address,'') || ' ' || COALESCE(notes,'')) ~ '(호스텔|한옥|스테이|게스트|객실|룸|펜션|호텔)') AS n, count(*) AS total
     FROM projects WHERE org_id=$1 AND ${notTest}`,
    [orgId],
  );
  if ((stay?.total ?? 0) >= 10 && (stay!.n ?? 0) >= 5)
    out.push({
      key: "stay_targets:v1",
      category: "새 영업 대상·콘텐츠",
      title: "숙박 공간(호스텔·한옥·객실형) 사례를 묶은 포트폴리오 콘텐츠",
      evidence: `작업 ${stay!.total}건 중 ${stay!.n}건이 숙박 관련 키워드 포함`,
      expected: "숙박업 운영자 대상 문의 증가 가능성 (성과는 게시 후 측정)",
      effort: "사례 3건 정리 2시간",
      first: "숙박 작업 중 결과가 좋은 3건을 골라 게시물 초안 작성",
      hypothesis: true,
    });
  return out;
}

export async function generateIdeas(orgId: string, maxNew = 3) {
  const cands = await detect(orgId);
  const created: string[] = [];
  for (const c of cands) {
    if (created.length >= maxNew) break;
    const r = await q1<{ id: string }>(
      `INSERT INTO ideas(org_id, idea_key, category, title, evidence, evidence_refs, expected_effect, effort, first_action, is_hypothesis, importance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (org_id, idea_key) DO NOTHING RETURNING id`,
      [orgId, c.key, c.category, c.title, c.evidence, JSON.stringify(c.refs ?? []), c.expected, c.effort, c.first, c.hypothesis, c.high ? "high" : "normal"],
    );
    if (!r) continue;
    created.push(r.id);
    if (c.high)
      await recordEvent(orgId, {
        kind: "idea_high",
        title: `중요 개선 기회: ${c.title}`,
        dedupeKey: `idea:${r.id}`,
        entityType: "idea",
        entityId: r.id,
        link: "/ideas",
        feedText: `대표님, 바로 검토할 만한 기회가 있습니다. ${c.title}\n근거: ${c.evidence}\n첫 행동: ${c.first}`,
        actions: [{ label: "제안 보기", type: "open", link: "/ideas" }],
      });
  }
  return created;
}

/** 일일 보고에 넣을 제안: 아직 보고하지 않은 제안 우선, 최대 n개 */
export async function ideasForReport(orgId: string, n = 3) {
  return q<any>(
    `SELECT * FROM ideas WHERE org_id=$1 AND status='proposed' ORDER BY (reported_at IS NULL) DESC, importance DESC, created_at DESC LIMIT $2`,
    [orgId, n],
  );
}
