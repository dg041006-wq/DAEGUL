import { NavLink, Outlet } from "react-router-dom";
import { canDo, useSession } from "../lib/session";
import { useApi, post } from "../lib/api";
import { Icon } from "./Icon";

export function Layout() {
  const { me, refresh } = useSession();
  const notes = useApi<any[]>("/api/notifications", { poll: 30000 });
  const unread = (notes.data ?? []).filter((n) => !n.read_at).length;
  const owner = me?.role === "owner";
  const items = [
    { to: "/", label: "대표실", icon: "home", end: true, show: true },
    { to: "/inbox", label: "상담함", icon: "chat", show: true },
    { to: "/pipeline", label: "고객 / 영업", icon: "flow", show: true },
    { to: "/analytics", label: "분석실", icon: "chart", show: canDo(me, "view_analytics") },
    { to: "/staff", label: "AI 직원", icon: "staff", show: true },
    { to: "/reports", label: "보고서", icon: "doc", show: canDo(me, "view_analytics") && canDo(me, "view_finance") },
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
          <div>
            {me?.user.name} · {owner ? "대표" : "직원"}
          </div>
          <button
            className="btn ghost sm"
            style={{ paddingLeft: 0 }}
            onClick={async () => {
              await post("/api/auth/logout");
              await refresh();
            }}
          >
            로그아웃
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
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
