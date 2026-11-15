import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fileToBase64, patch, post, put, useApi } from "../lib/api";
import { fmtDateTime, fmtWon } from "../lib/format";
import { Empty, Loading, useToast } from "../components/common";
import { EVENT_KINDS } from "../../shared/domain";

// ───── 시트 가져오기 (미리보기 → 확인 → 확정) + 구글시트 읽기 전용 연동 ─────
export function SheetImport() {
  const list = useApi<any[]>("/api/sheet-imports", { poll: 0 });
  const sync = useApi<any>("/api/sheet-sync", { poll: 0 });
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheetId, setSheetId] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (!active && list.data?.[0]?.status === "previewed") setActive(list.data[0].id);
  }, [list.data]);
  useEffect(() => {
    if (sync.data?.config?.spreadsheet_id) setSheetId(sync.data.config.spreadsheet_id);
  }, [sync.data]);
  return (
    <>
      <div className="banner info small">
        업로드한 파일은 그 시점의 사본입니다. 구글시트 실시간 연동이 아니며 원본 시트는 수정하지 않습니다. 날짜·금액·상태가 불확실한 행은 '확인 필요'로 표시되고 추정해서 채우지 않습니다. 항목 대응표는 docs/SHEET_MAPPING.md에 있습니다.
      </div>
      <div className="card stack">
        <h2>엑셀(.xlsx) 파일 가져오기</h2>
        <p className="small muted">구글시트: 파일 → 다운로드 → Microsoft Excel(.xlsx)로 받은 뒤 올리세요.</p>
        <label className="btn primary" style={{ alignSelf: "flex-start" }}>
          {busy ? "분석 중…" : "파일 선택"}
          <input
            type="file"
            accept=".xlsx"
            hidden
            disabled={busy}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              try {
                const r = await post("/api/sheet-imports", { filename: f.name, data_base64: await fileToBase64(f) });
                setActive(r.id);
                list.reload();
              } catch (err: any) {
                toast.show(err.message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      </div>
      {active && <ImportPreview id={active} onDone={() => list.reload()} />}
      <div className="card">
        <h2>가져오기 기록</h2>
        {(list.data ?? []).map((i) => (
          <div key={i.id} className="list-item small">
            <button className="btn ghost sm" onClick={() => setActive(i.id)}>
              {i.source_label}
            </button>
            <span className={`badge ${i.status === "committed" ? "ok" : i.status === "previewed" ? "warn" : ""}`}>{{ previewed: "확인 대기", committed: "반영 완료", discarded: "취소" }[i.status as string]}</span>
            <span className="muted">{fmtDateTime(i.created_at)}</span>
          </div>
        ))}
      </div>
      <div className="card stack">
        <h2>구글시트 읽기 전용 연동</h2>
        <p className="small">
          상태:{" "}
          {sync.data?.config?.status === "verified" ? <span className="badge ok">연결 확인됨</span> : sync.data?.config?.status === "error" ? <span className="badge danger">오류</span> : sync.data?.config?.status === "configured" ? <span className="badge warn">설정됨 · 연결 미확인</span> : <span className="badge">미연결</span>}
          {sync.data?.config?.last_sync_at && ` · 마지막 읽기 ${fmtDateTime(sync.data.config.last_sync_at)}`}
          {sync.data?.config?.last_error && <span className="small"> · {sync.data.config.last_error}</span>}
        </p>
        <p className="small muted">
          서버 설정: {sync.data?.configured ? `서비스 계정 ${sync.data.serviceAccountEmail} — 이 이메일에 시트를 '뷰어'로 공유하세요.` : "GOOGLE_SERVICE_ACCOUNT_JSON 미설정 (배포 환경 비밀 변수에 서비스 계정 키를 넣어야 연결할 수 있습니다)."}
        </p>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input placeholder="스프레드시트 ID (주소의 /d/와 /edit 사이)" value={sheetId} onChange={(e) => setSheetId(e.target.value)} />
          <button className="btn" onClick={async () => (await put("/api/sheet-sync", { spreadsheet_id: sheetId }), sync.reload(), toast.show("저장했습니다."))}>
            저장
          </button>
        </div>
        <button
          className="btn"
          style={{ alignSelf: "flex-start" }}
          disabled={!sync.data?.configured}
          onClick={async () => {
            try {
              const r = await post("/api/sheet-sync/pull");
              setActive(r.id);
              list.reload();
              sync.reload();
            } catch (e: any) {
              toast.show(e.message);
              sync.reload();
            }
          }}
        >
          원본 시트 읽어서 미리보기 만들기
        </button>
        <p className="tiny muted">읽기는 변경 사항을 바로 반영하지 않고 미리보기만 만듭니다. 이미 가져온 행은 다시 만들지 않습니다.</p>
      </div>
      {toast.node}
    </>
  );
}

function ImportPreview({ id, onDone }: { id: string; onDone: () => void }) {
  const d = useApi<any>(`/api/sheet-imports/${id}`, { poll: 0 });
  const [filter, setFilter] = useState<"flagged" | "booking" | "review" | "all">("flagged");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const toast = useToast();
  if (d.loading) return <Loading />;
  if (!d.data) return null;
  const imp = d.data.import;
  const sum = imp.summary;
  const rows = d.data.rows.filter((r: any) => (filter === "all" ? true : filter === "flagged" ? r.flags.length > 0 : filter === "review" ? r.decision === "review" : r.classification === "booking"));
  const cls: Record<string, string> = { booking: "예약/작업", personal: "개인 일정", business: "사업 일정", note: "일정 메모", header: "구역 제목" };
  return (
    <div className="card stack">
      <div className="card-head">
        <h2>미리보기 · {imp.source_label}</h2>
        <span className={`badge ${imp.status === "committed" ? "ok" : "warn"}`}>{imp.status === "committed" ? "반영 완료" : imp.status === "discarded" ? "취소됨" : "확인 대기"}</span>
      </div>
      <div className="grid grid-4">
        <div className="kpi">
          <span className="l">예약/작업 행</span>
          <span className="v">{sum.bookings}</span>
          <span className="tiny muted">{sum.dateRange ? `${sum.dateRange.from} ~ ${sum.dateRange.to}` : ""}</span>
        </div>
        <div className="kpi">
          <span className="l">고객(이름·연락처 기준)</span>
          <span className="v">{sum.customers}</span>
        </div>
        <div className="kpi">
          <span className="l">확인 필요 행</span>
          <span className="v">{sum.flagged}</span>
          <span className="tiny muted">중복 의심 검토 {sum.review}</span>
        </div>
        <div className="kpi">
          <span className="l">시트 단가 합계</span>
          <span className="v" style={{ fontSize: "1.2rem" }}>{fmtWon(sum.listedPriceTotal)}</span>
          <span className="tiny muted">확정 매출 아님</span>
        </div>
      </div>
      <p className="small muted">
        개인 일정 {sum.personalBlocks}건 · 일정 메모 {sum.notes}건 · 빈 날짜 {sum.emptyDays}행(가져오지 않음){sum.alreadyImported ? ` · 이미 가져온 행 ${sum.alreadyImported}건(다시 만들지 않음)` : ""}
      </p>
      <details>
        <summary className="small">확인 필요 사유별 건수</summary>
        <ul className="small">
          {Object.entries(sum.flagCounts ?? {}).map(([k, v]) => (
            <li key={k}>
              {d.data.flagLabels[k] ?? k}: {String(v)}건
            </li>
          ))}
        </ul>
      </details>
      <div className="chips">
        {(["flagged", "review", "booking", "all"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {{ flagged: "확인 필요", review: "검토(중복 의심)", booking: "예약/작업", all: "전체" }[f]}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>행</th>
              <th>분류</th>
              <th>날짜</th>
              <th>내용</th>
              <th>확인 필요</th>
              <th>처리</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((r: any) => (
              <tr key={r.id}>
                <td className="small">{r.row_number}</td>
                <td className="small">{cls[r.classification] ?? r.classification}</td>
                <td className="small nowrap">{r.parsed.date ?? "-"}</td>
                <td className="small">
                  {r.parsed.title ?? r.parsed.blockLabel ?? (r.parsed.personBlocks ?? []).map((b: any) => `${b.person}: ${b.label}`).join(", ")}
                  {r.parsed.listedPrice != null && <span className="muted"> · 단가 {fmtWon(r.parsed.listedPrice)}</span>}
                  {r.parsed.statusRaw && <span className="muted"> · {r.parsed.statusRaw}</span>}
                  {r.parsed.timeRaw && <span className="muted"> · 시간 {r.parsed.startTime ?? `원문 "${r.parsed.timeRaw}"`}</span>}
                  {r.duplicate_of === "already_imported" && <span className="badge"> 이미 가져옴</span>}
                </td>
                <td className="tiny">{r.flags.map((f: string) => d.data.flagLabels[f] ?? f).join(" / ")}</td>
                <td>
                  {imp.status === "previewed" && r.classification !== "header" ? (
                    <select
                      value={r.decision}
                      onChange={async (e) => {
                        await patch(`/api/sheet-import-rows/${r.id}`, { decision: e.target.value });
                        d.reload();
                      }}
                      style={{ minHeight: 32, width: "auto" }}
                      aria-label={`${r.row_number}행 처리`}
                    >
                      <option value="import">가져오기</option>
                      <option value="skip">제외</option>
                      <option value="review">보류</option>
                    </select>
                  ) : (
                    <span className="tiny muted">{r.created_refs?.project_id ? <Link to={`/projects/${r.created_refs.project_id}`}>작업 보기</Link> : r.decision}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {imp.status === "previewed" && (
        <div className="row">
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              if (!confirm("'가져오기'로 선택된 행만 고객·작업·일정으로 반영합니다. '보류'·'제외' 행은 반영하지 않습니다. 진행할까요?")) return;
              setBusy(true);
              try {
                setResult(await post(`/api/sheet-imports/${id}/commit`));
                d.reload();
                onDone();
              } catch (e: any) {
                toast.show(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "반영 중…" : "확인한 내용으로 반영"}
          </button>
          <button className="btn ghost" onClick={async () => (await post(`/api/sheet-imports/${id}/discard`), d.reload(), onDone())}>
            이번 가져오기 취소
          </button>
        </div>
      )}
      {(result || imp.summary?.result) && (
        <div className="banner info small">
          반영 결과: 작업 {(result ?? imp.summary.result).projects}건, 신규 고객 {(result ?? imp.summary.result).contacts}명, 일정 {(result ?? imp.summary.result).blocks}건, 확인 필요 입금 {(result ?? imp.summary.result).claims}건, 이미 있던 행 {(result ?? imp.summary.result).skippedExisting}건 건너뜀
        </div>
      )}
      {toast.node}
    </div>
  );
}

// ───── 알림·보고·푸시 설정 ─────
export function AlertSettings() {
  const s = useApi<any>("/api/settings", { poll: 0 });
  const [v, setV] = useState<any>(null);
  const toast = useToast();
  useEffect(() => {
    if (s.data) setV(s.data);
  }, [s.data]);
  if (!v) return <Loading />;
  const sev = { critical: "긴급(즉시 푸시)", important: "중요", info: "단순 상태(앱 안에서만)" } as const;
  return (
    <div className="card stack">
      <h2>정기 보고 (한국 시간)</h2>
      <label className="check">
        <input type="checkbox" checked={v.reports.dailyEnabled} onChange={(e) => setV({ ...v, reports: { ...v.reports, dailyEnabled: e.target.checked } })} /> 일일 보고 매일
        <input type="time" value={v.reports.dailyTime} onChange={(e) => setV({ ...v, reports: { ...v.reports, dailyTime: e.target.value } })} style={{ width: "auto" }} />
      </label>
      <label className="check">
        <input type="checkbox" checked={v.reports.weeklyEnabled} onChange={(e) => setV({ ...v, reports: { ...v.reports, weeklyEnabled: e.target.checked } })} /> 주간 보고
        <select value={v.reports.weeklyDay} onChange={(e) => setV({ ...v, reports: { ...v.reports, weeklyDay: Number(e.target.value) } })} style={{ width: "auto" }}>
          {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
            <option key={i} value={i}>
              {d}요일
            </option>
          ))}
        </select>
        <input type="time" value={v.reports.weeklyTime} onChange={(e) => setV({ ...v, reports: { ...v.reports, weeklyTime: e.target.value } })} style={{ width: "auto" }} />
      </label>
      <h2 style={{ marginTop: 8 }}>푸시 알림 기준</h2>
      <label className="field">
        <span>이 중요도 이상만 휴대폰/PC 푸시 (나머지는 알림함·보고방에만)</span>
        <select value={v.pushMinSeverity} onChange={(e) => setV({ ...v, pushMinSeverity: e.target.value })}>
          <option value="critical">긴급만</option>
          <option value="important">중요 이상 (기본)</option>
          <option value="info">모든 알림</option>
          <option value="off">푸시 끄기</option>
        </select>
      </label>
      <table className="t">
        <thead>
          <tr>
            <th>사건</th>
            <th>중요도</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(EVENT_KINDS).map(([k, def]) => (
            <tr key={k}>
              <td>{def.label}</td>
              <td>
                <select value={v.eventPush?.[k] ?? def.severity} onChange={(e) => setV({ ...v, eventPush: { ...(v.eventPush ?? {}), [k]: e.target.value } })} style={{ minHeight: 32 }} aria-label={`${def.label} 중요도`}>
                  {Object.entries(sev).map(([sk, sl]) => (
                    <option key={sk} value={sk}>
                      {sl}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-grid">
        <label className="field">
          <span>답변 대기 알림 기준 (영업시간 분)</span>
          <input type="number" min={5} value={v.replyAlertMinutes} onChange={(e) => setV({ ...v, replyAlertMinutes: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>답변 대기 묶음 보고 반복 간격 (시간)</span>
          <input type="number" min={1} max={48} value={v.awaitingAlertRepeatHours} onChange={(e) => setV({ ...v, awaitingAlertRepeatHours: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>견적 후 후속 확인 (영업일)</span>
          <input type="number" min={1} value={v.quoteFollowupBusinessDays} onChange={(e) => setV({ ...v, quoteFollowupBusinessDays: Number(e.target.value) })} />
        </label>
      </div>
      <button
        className="btn primary"
        style={{ alignSelf: "flex-start" }}
        onClick={async () => {
          try {
            await patch("/api/settings", { reports: v.reports, pushMinSeverity: v.pushMinSeverity, eventPush: v.eventPush ?? {}, replyAlertMinutes: v.replyAlertMinutes, awaitingAlertRepeatHours: v.awaitingAlertRepeatHours, quoteFollowupBusinessDays: v.quoteFollowupBusinessDays });
            toast.show("저장했습니다.");
          } catch (e: any) {
            toast.show(e.message);
          }
        }}
      >
        저장
      </button>
      <p className="tiny muted">
        보고와 알림은 서버 워커가 실행합니다(브라우저를 켜 둘 필요 없음). 기기별 알림 켜기는 <Link to="/install">앱 설치·알림</Link>에서 합니다.
      </p>
      {toast.node}
    </div>
  );
}

// ───── 자동응답 ─────
export function AutoReplies() {
  const list = useApi<any[]>("/api/auto-replies", { poll: 0 });
  const [v, setV] = useState({ name: "영업시간 외 첫 문의 안내", template: "문의 감사합니다. 지금은 영업시간이 아니어서 다음 영업일에 담당자가 확인 후 답변드리겠습니다.", enabled: false });
  const toast = useToast();
  const ex = list.data?.[0];
  useEffect(() => {
    if (ex) setV({ name: ex.name, template: ex.template, enabled: ex.enabled });
  }, [ex?.id]);
  return (
    <div className="card stack">
      <h2>고객 자동응답</h2>
      <div className="banner warn small">
        자동응답은 대표님이 켠 규칙과 문구 안에서만 동작합니다(영업시간 외 첫 메시지). 금액·할인·확정·보장 표현은 저장되지 않습니다. 현재 카카오 공급사 발송이 연동되지 않아 실제 고객에게는 전송되지 않으며 발송 큐에 '공급사 미연동'으로 기록됩니다.
      </div>
      <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} aria-label="규칙 이름" />
      <textarea value={v.template} onChange={(e) => setV({ ...v, template: e.target.value })} aria-label="자동응답 문구" />
      <label className="check">
        <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> 사용
      </label>
      <button
        className="btn primary"
        style={{ alignSelf: "flex-start" }}
        onClick={async () => {
          try {
            await post("/api/auto-replies", { ...v, id: ex?.id });
            toast.show("저장했습니다.");
            list.reload();
          } catch (e: any) {
            toast.show(e.message);
          }
        }}
      >
        저장
      </button>
      {toast.node}
    </div>
  );
}

export function ActivityLog() {
  const d = useApi<any[]>("/api/activity", { tables: ["events"] });
  if (!d.data) return <Loading />;
  if (!d.data.length) return <Empty>기록된 사건이 없습니다.</Empty>;
  return (
    <div className="card table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>시각</th>
            <th>사건</th>
            <th>중요도</th>
            <th>보고</th>
          </tr>
        </thead>
        <tbody>
          {d.data.map((e) => (
            <tr key={e.id}>
              <td className="small nowrap">{fmtDateTime(e.created_at)}</td>
              <td className="small">
                {e.is_test && <span className="badge">테스트</span>} {e.link ? <Link to={e.link}>{e.title}</Link> : e.title}
              </td>
              <td className="small">{{ critical: "긴급", important: "중요", info: "상태" }[e.severity as string]}</td>
              <td className="small">{e.reported ? "보고함" : "기록만"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
