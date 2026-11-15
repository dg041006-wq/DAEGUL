import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { canDo, useSession } from "../lib/session";
import { useApi, post, type SaveState } from "../lib/api";
import { startRealtime, stopRealtime, useConnState } from "../lib/realtime";
import { cleanupOnLogout, registerSW } from "../lib/pwa";
import { Icon } from "./Icon";

function SyncStatus() {
  const conn = useConnState();
  const [save, setSave] = useState<SaveState>({ state: "idle" });
  useEffect(() => {
    const h = (e: Event) => setSave((e as CustomEvent).detail);
    window.addEventListener("ss:save", h);
    return () => window.removeEventListener("ss:save", h);
  }, []);
  useEffect(() => {
    if (save.state !== "saved") return;
    const t = setTimeout(() => setSave({ state: "idle" }), 2000);
    return () => clearTimeout(t);
  }, [save]);
  return (
    <div className="sync" role="status" aria-live="polite">
      <span className={`status-dot ${conn === "live" ? "live" : conn === "offline" ? "down" : ""}`} />
      <span>{conn === "live" ? "실시간 연결됨" : conn === "offline" ? "연결 끊김 — 재연결 중" : "연결 중"}</span>
      {save.state === "saving" && <span className="badge navy">저장 중…</span>}
      {save.state === "saved" && <span className="badge ok">저장됨</span>}
      {save.state === "error" && <span className="badge danger">저장 실패: {save.message}</span>}
    </div>
  );
}

export function Layout() {
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const notes = useApi<any[]>("/api/notifications", { tables: ["notifications"] });
  const unread = (notes.data ?? []).filter((n) => !n.read_at).length;
  const [newVersion, setNewVersion] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    startRealtime();
    registerSW();
    const h = () => setNewVersion(true);
    window.addEventListener("ss:newversion", h);
    return () => {
      window.removeEventListener("ss:newversion", h);
    };
  }, []);
  const logout = async () => {
    await cleanupOnLogout();
    stopRealtime();
    await post("/api/auth/logout").catch(() => {});
    await refresh();
    nav("/");
  };
  const fin = canDo(me, "view_finance");
  const items = [
    { to: "/", label: "대표실", icon: "home", end: true, show: true },
    { to: "/inbox", label: "상담함", icon: "chat", show: true },
    { to: "/schedule", label: "일정·작업", icon: "calendar", show: true },
    { to: "/contacts", label: "고객", icon: "user", show: true },
    { to: "/pipeline", label: "영업 현황", icon: "flow", show: true },
    { to: "/settlement", label: "정산", icon: "won", show: fin },
    { to: "/staff", label: "AI 직원", icon: "staff", show: true },
    { to: "/reports", label: "보고서", icon: "doc", show: canDo(me, "view_analytics") && fin },
    { to: "/ideas", label: "경영 제안", icon: "spark", show: canDo(me, "view_analytics") },
    { to: "/analytics", label: "분석실", icon: "chart", show: canDo(me, "view_analytics") },
    { to: "/tasks", label: "할 일", icon: "check", show: true },
    { to: "/notifications", label: "알림함", icon: "bell", show: true, count: unread },
    { to: "/settings", label: "설정", icon: "gear", show: true },
  ];
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="주 메뉴">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <div>
            <b>STAYSCENE</b>
            <span>OFFICE · {me?.org.name}</span>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
          }}
          style={{ marginBottom: 10 }}
        >
          <input placeholder="고객·작업·대화·보고서 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="통합 검색" />
        </form>
        <nav className="nav">
          {items
            .filter((i) => i.show)
            .map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end}>
                <Icon name={i.icon} />
                {i.label}
                {i.count ? <span className="count">{i.count}</span> : null}
              </NavLink>
            ))}
        </nav>
        <div className="sidebar-foot">
          <SyncStatus />
          <div style={{ marginTop: 6 }}>
            {me?.user.name} · {me?.role === "owner" ? "대표" : "직원"}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <NavLink to="/install" className="btn ghost sm" style={{ paddingLeft: 0 }}>
              앱 설치·알림
            </NavLink>
            <button className="btn ghost sm" onClick={logout}>
              로그아웃
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="mobile-top mobile-only">
          <SyncStatus />
          <NavLink to="/search" className="btn ghost sm" aria-label="검색">
            <Icon name="search" />
          </NavLink>
        </div>
        {newVersion && (
          <div className="banner info">
            <span style={{ flex: 1 }}>새 버전이 배포되었습니다.</span>
            <button className="btn sm primary" onClick={() => location.reload()}>
              새로고침
            </button>
          </div>
        )}
        <Outlet context={{ logout }} />
      </main>
      <nav className="bottom-nav" aria-label="하단 메뉴">
        <NavLink to="/" end>
          <Icon name="home" />홈
        </NavLink>
        <NavLink to="/inbox">
          <Icon name="chat" />상담
        </NavLink>
        <NavLink to="/staff">
          <Icon name="staff" />AI 직원
        </NavLink>
        <NavLink to="/tasks">
          <Icon name="check" />할 일
        </NavLink>
        <NavLink to="/more">
          <Icon name="more" />더보기
          {unread ? <span className="dot" aria-label={`읽지 않은 알림 ${unread}건`} /> : null}
        </NavLink>
      </nav>
    </div>
  );
}
