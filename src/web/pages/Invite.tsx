import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { post, useApi } from "../lib/api";
import { useSession } from "../lib/session";

export function Invite() {
  const { token } = useParams();
  const nav = useNavigate();
  const { refresh } = useSession();
  const inv = useApi<any>(`/api/invitations/${token}`, { poll: 0 });
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="login-wrap">
      <div className="card login-card stack">
        <h1>STAYSCENE OFFICE 초대</h1>
        {inv.loading ? (
          <p className="muted">확인 중…</p>
        ) : inv.error ? (
          <div className="banner danger">{inv.error.message}</div>
        ) : (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post("/api/invitations/accept", { token, name, password: pw });
                await refresh();
                nav("/");
              } catch (e: any) {
                setErr(e.message);
              }
            }}
          >
            <p className="muted small">
              {inv.data.org_name}에서 {inv.data.email} 계정을 {inv.data.role === "owner" ? "대표" : "직원"}로 초대했습니다.
            </p>
            <label className="field">
              <span>이름</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} />
            </label>
            <label className="field">
              <span>비밀번호 (10자 이상)</span>
              <input type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} required />
            </label>
            {err && <div className="banner danger">{err}</div>}
            <button className="btn primary">가입하고 시작</button>
          </form>
        )}
      </div>
    </div>
  );
}
