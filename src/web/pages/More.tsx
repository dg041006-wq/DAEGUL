import { Link } from "react-router-dom";
import { useOutletContext } from "react-router-dom";
import { canDo, useSession } from "../lib/session";
import { Icon } from "../components/Icon";

export function More() {
  const { me } = useSession();
  const { logout } = useOutletContext<{ logout: () => Promise<void> }>();
  const items = [
    { to: "/schedule", label: "일정 · 작업", icon: "calendar", show: true },
    { to: "/contacts", label: "고객", icon: "user", show: true },
    { to: "/settlement", label: "정산", icon: "won", show: canDo(me, "view_finance") },
    { to: "/pipeline", label: "영업 현황", icon: "flow", show: true },
    { to: "/ideas", label: "경영 제안", icon: "spark", show: canDo(me, "view_analytics") },
    { to: "/search", label: "검색", icon: "search", show: true },
    { to: "/install", label: "앱 설치 · 알림", icon: "bell", show: true },
    { to: "/analytics", label: "분석실", icon: "chart", show: canDo(me, "view_analytics") },
    { to: "/reports", label: "보고서", icon: "doc", show: canDo(me, "view_analytics") && canDo(me, "view_finance") },
    { to: "/notifications", label: "알림함", icon: "bell", show: true },
    { to: "/settings", label: "설정", icon: "gear", show: true },
  ];
  return (
    <>
      <div className="page-head">
        <h1>더보기</h1>
      </div>
      <div className="card">
        {items
          .filter((i) => i.show)
          .map((i) => (
            <Link key={i.to} to={i.to} className="list-item" style={{ alignItems: "center", minHeight: 52 }}>
              <Icon name={i.icon} />
              {i.label}
            </Link>
          ))}
      </div>
      <div className="card">
        <p className="small">
          {me?.user.name} · {me?.role === "owner" ? "대표" : "직원"} · {me?.user.email}
        </p>
        <button className="btn" style={{ marginTop: 8 }} onClick={logout}>
          로그아웃
        </button>
      </div>
    </>
  );
}
