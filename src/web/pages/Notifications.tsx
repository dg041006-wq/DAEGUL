import { Link } from "react-router-dom";
import { post, useApi } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { Empty, Loading } from "../components/common";

export function Notifications() {
  const n = useApi<any[]>("/api/notifications", { poll: 20000 });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>알림함</h1>
          <p className="muted small">푸시 알림이 지원되지 않는 기기에서도 이곳에서 모든 알림을 확인할 수 있습니다. 알림에는 상담 원문을 표시하지 않습니다.</p>
        </div>
        <button className="btn" onClick={async () => (await post("/api/notifications/read-all"), n.reload())}>
          모두 읽음
        </button>
      </div>
      <div className="card">
        {n.loading ? (
          <Loading />
        ) : !n.data?.length ? (
          <Empty>알림이 없습니다.</Empty>
        ) : (
          n.data.map((x) => (
            <Link key={x.id} to={x.link ?? "#"} className="list-item" style={{ opacity: x.read_at ? 0.6 : 1 }}>
              {!x.read_at && <span className="status-dot live" style={{ marginTop: 7 }} />}
              <div>
                <div>{x.title}</div>
                <div className="tiny muted">{fmtDateTime(x.created_at)}</div>
              </div>
            </Link>
          ))
        )}
      </div>
    </>
  );
}
