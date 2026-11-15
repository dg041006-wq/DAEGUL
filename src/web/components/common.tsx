import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fmtDateTime } from "../lib/format";
import { INTEGRATION_STATUS_LABELS, STAGE_LABELS, CATEGORY_LABELS, type Stage } from "../../shared/domain";

export function DataBanner({ ds }: { ds: { kakaoVerified: boolean; usingSampleData: boolean; lastSyncAt?: string | null } | null | undefined }) {
  if (!ds) return null;
  if (ds.kakaoVerified && !ds.usingSampleData) return null;
  return (
    <div className="banner warn" role="status">
      <b className="nowrap">{ds.usingSampleData ? "샘플 데이터 / 카카오 미연동" : "카카오 미연동"}</b>
      <span>
        {ds.usingSampleData
          ? "화면의 상담·수치는 가상의 샘플입니다. 실제 고객 문의 분석 결과가 아닙니다."
          : "카카오 상담 공식 연동이 검증되지 않았습니다. 표시된 데이터는 가져온 기록 범위에 한정됩니다."}
        {ds.lastSyncAt ? ` 마지막 수신 ${fmtDateTime(ds.lastSyncAt)}` : ""}
      </span>
    </div>
  );
}

export function IntegrationBadge({ status }: { status: string }) {
  const cls = status === "verified" ? "ok" : status === "error" ? "danger" : status === "sample" ? "warn" : "";
  return <span className={`badge ${cls}`}>{INTEGRATION_STATUS_LABELS[status as keyof typeof INTEGRATION_STATUS_LABELS] ?? status}</span>;
}

export function StageBadge({ stage }: { stage: string }) {
  const cls = stage === "won" ? "ok" : stage === "lost" ? "danger" : stage === "quoted" || stage === "negotiating" ? "brass" : stage === "on_hold" || stage === "waiting_contact" ? "warn" : "navy";
  return <span className={`badge ${cls}`}>{STAGE_LABELS[stage as Stage] ?? stage}</span>;
}

export function CategoryBadge({ category }: { category: string }) {
  if (category === "valid") return null;
  return <span className="badge">{CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS]}</span>;
}

export function SampleTag({ show }: { show?: boolean }) {
  return show ? <span className="badge warn">샘플</span> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="empty">불러오는 중…</div>;
}

export function ErrorBox({ error }: { error: { message: string; status?: number } | null }) {
  if (!error) return null;
  return <div className="banner danger">{error.status === 403 ? "이 화면을 볼 권한이 없습니다. 대표에게 권한을 요청하세요." : error.message}</div>;
}

export function Toast({ msg, onDone }: { msg: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [msg, onDone]);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  return { msg, show: setMsg, node: <Toast msg={msg} onDone={() => setMsg(null)} /> };
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="btn ghost sm" style={{ paddingLeft: 0 }}>
      ← {label}
    </Link>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
