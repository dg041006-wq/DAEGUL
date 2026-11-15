import { useState } from "react";
import { post } from "../lib/api";
import { useSession } from "../lib/session";

export function Login() {
  const { refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-wrap">
      <form
        className="card login-card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await post("/api/auth/login", { email, password });
            await refresh();
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand" style={{ padding: 0 }}>
          <img src="/icon.svg" alt="" width={36} height={36} style={{ borderRadius: 8 }} />
          <div>
            <b>STAYSCENE OFFICE</b>
            <span>초대받은 구성원 전용 · 공개 가입 없음</span>
          </div>
        </div>
        <label className="field">
          <span>이메일</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <div className="banner danger">{err}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? "확인 중…" : "로그인"}
        </button>
        <p className="tiny muted">계정이 없으면 대표에게 초대 링크를 요청하세요.</p>
      </form>
    </div>
  );
}
