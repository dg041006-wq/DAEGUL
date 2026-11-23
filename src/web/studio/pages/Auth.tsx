import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { sget, spost } from "../api";
import { useMe } from "../main";

export function Login() {
  const { reload } = useMe();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="login card col">
      <div className="brandmark">STAYSCENE</div>
      <h1>스타일링 스튜디오</h1>
      <p className="muted">현장 사진에 고객이 고른 가구를 놓고, 결정·전달할 수 있는 시안을 만듭니다.</p>
      <form
        className="col"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          try {
            await spost("/api/studio/auth/login", { email, password });
            await reload();
            if (!location.pathname.startsWith("/studio/")) nav("/studio");
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="f">
          이메일
          <input className="in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label className="f">
          비밀번호
          <input className="in" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {err && <div className="notice bad">{err}</div>}
        <button className="btn primary" disabled={busy}>
          로그인
        </button>
      </form>
      <p className="tiny muted">초기에는 초대받은 업체만 사용할 수 있습니다. 초대 링크로 가입하세요.</p>
    </div>
  );
}

export function Join() {
  const { token } = useParams();
  const { reload } = useMe();
  const nav = useNavigate();
  const [inv, setInv] = useState<any>(null);
  const [err, setErr] = useState("");
  const [f, setF] = useState({ name: "", email: "", password: "", workspaceName: "" });
  useEffect(() => {
    sget(`/api/studio/invites/${token}`)
      .then((i) => {
        setInv(i);
        setF((x) => ({ ...x, email: i.email ?? "", workspaceName: i.workspace_name ?? "" }));
      })
      .catch((e) => setErr(e.message));
  }, [token]);
  return (
    <div className="login card col">
      <div className="brandmark">STAYSCENE</div>
      <h1>업체 가입</h1>
      {!inv && err && <div className="notice bad">{err}</div>}
      {inv && (
        <form
          className="col"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await spost("/api/studio/auth/signup", { token, ...f });
              await reload();
              nav("/studio");
            } catch (e: any) {
              setErr(e.message);
            }
          }}
        >
          <label className="f">
            업체명
            <input className="in" value={f.workspaceName} onChange={(e) => setF({ ...f, workspaceName: e.target.value })} required />
          </label>
          <label className="f">
            이름
            <input className="in" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label className="f">
            이메일
            <input className="in" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          </label>
          <label className="f">
            비밀번호 (10자 이상)
            <input className="in" type="password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          </label>
          {err && <div className="notice bad">{err}</div>}
          <button className="btn primary">가입하고 시작</button>
        </form>
      )}
    </div>
  );
}
