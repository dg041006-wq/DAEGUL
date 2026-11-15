import { useEffect, useState } from "react";
import { get, post } from "../lib/api";
import { useSession } from "../lib/session";

export function Login() {
  const { refresh } = useSession();
  const [setupOpen, setSetupOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ open: boolean }>("/api/setup/status")
      .then((r) => setSetupOpen(r.open))
      .catch(() => {});
  }, []);
  return (
    <div className="login-wrap">
      <form
        className="card login-card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            if (setupOpen) await post("/api/setup/owner", { token, email, name, password });
            else await post("/api/auth/login", { email, password });
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
            <span>{setupOpen ? "최초 대표 계정 설정" : "초대받은 구성원 전용 · 공개 가입 없음"}</span>
          </div>
        </div>
        {setupOpen && (
          <>
            <div className="banner info small">아직 대표 계정이 없습니다. 배포 설정(환경변수)의 SETUP_TOKEN 값을 입력해 대표 계정을 만드세요. 만든 즉시 이 화면은 닫힙니다.</div>
            <label className="field">
              <span>설정 토큰 (SETUP_TOKEN)</span>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" />
            </label>
            <label className="field">
              <span>대표 이름</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          </>
        )}
        <label className="field">
          <span>이메일</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>비밀번호{setupOpen ? " (10자 이상)" : ""}</span>
          <input type="password" autoComplete={setupOpen ? "new-password" : "current-password"} minLength={setupOpen ? 10 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <div className="banner danger">{err}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? "확인 중…" : setupOpen ? "대표 계정 만들기" : "로그인"}
        </button>
        {!setupOpen && <p className="tiny muted">계정이 없으면 대표에게 초대 링크를 요청하세요. 로그인은 30일간 유지되며, 공용 PC에서는 사용 후 로그아웃하세요.</p>}
      </form>
    </div>
  );
}
