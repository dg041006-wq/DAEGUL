import { Link } from "react-router-dom";
import { post } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { Icon } from "../components/Icon";

export function More() {
  const { me, refresh } = useSession();
  const items = [
    { to: "/pipeline", label: "고객 / 영업 현황", icon: "flow", show: true },
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
        <button className="btn" style={{ marginTop: 8 }} onClick={async () => (await post("/api/auth/logout"), refresh())}>
          로그아웃
        </button>
      </div>
    </>
  );
}
