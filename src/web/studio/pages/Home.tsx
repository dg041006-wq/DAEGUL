import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sget, spost } from "../api";
import { useMe } from "../main";

export function TopNav() {
  const { me } = useMe();
  return (
    <div className="topnav">
      <Link to="/studio" className="brandmark" style={{ textDecoration: "none" }}>
        STAYSCENE <span className="muted" style={{ fontWeight: 500, letterSpacing: 0 }}>스타일링 스튜디오</span>
      </Link>
      <div className="spacer" />
      <Link className="btn ghost sm" to="/studio">
        프로젝트
      </Link>
      <Link className="btn ghost sm" to="/studio/assets">
        가구 제품
      </Link>
      {me?.isOps && (
        <Link className="btn ghost sm" to="/studio/ops">
          운영
        </Link>
      )}
      <span className="tiny muted">{me?.workspace.name}</span>
      <button
        className="btn sm"
        onClick={async () => {
          await spost("/api/studio/auth/logout");
          location.href = "/studio";
        }}
      >
        로그아웃
      </button>
    </div>
  );
}

export function Home() {
  const { me } = useMe();
  const nav = useNavigate();
  const [projects, setProjects] = useState<any[] | null>(null);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    sget("/api/studio/projects").then(setProjects);
  }, []);
  return (
    <>
      <TopNav />
      <div className="page col" style={{ gap: 20 }}>
        <div className="row wrap" style={{ alignItems: "flex-end" }}>
          <div className="grow col" style={{ gap: 4 }}>
            <h1>프로젝트</h1>
            <p className="muted">현장 사진 1~3장 → 기준점 보정 → 가구 배치 → 시점별 합성 → 고객 공유. 결과는 모두 버전으로 남습니다.</p>
          </div>
          <button
            className="btn"
            disabled={!!busy}
            onClick={async () => {
              setBusy("sample");
              try {
                const r = await spost("/api/studio/samples/open");
                nav(`/studio/r/${r.roomId}`);
              } catch (e: any) {
                setErr(e.message);
                setBusy("");
              }
            }}
          >
            {busy === "sample" ? "샘플 준비 중…" : "샘플 프로젝트 열기"}
          </button>
        </div>
        {!me?.capabilities.renderer && <div className="notice">이 서버에는 3D 렌더 워커(Chromium)가 없어 최종 합성은 대기 상태로 남습니다. 배치 미리보기는 정상 동작합니다.</div>}
        {err && <div className="notice bad">{err}</div>}
        <form
          className="card row wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy("new");
            try {
              const p = await spost("/api/studio/projects", { name, clientName: client || undefined });
              nav(`/studio/r/${p.firstRoomId}`);
            } catch (e: any) {
              setErr(e.message);
              setBusy("");
            }
          }}
        >
          <label className="f grow">
            새 프로젝트 이름
            <input className="in" placeholder="예: 성수동 OO빌라 거실" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="f" style={{ width: 200 }}>
            고객명(선택)
            <input className="in" value={client} onChange={(e) => setClient(e.target.value)} />
          </label>
          <button className="btn primary" style={{ alignSelf: "flex-end" }} disabled={!name.trim() || !!busy}>
            만들기
          </button>
        </form>
        <div className="grid-cards">
          {projects === null && <div className="muted">불러오는 중…</div>}
          {projects?.length === 0 && <div className="muted">아직 프로젝트가 없습니다. 샘플로 먼저 흐름을 확인해 보세요.</div>}
          {projects?.map((p) => (
            <Link key={p.id} to={`/studio/p/${p.id}`} className="card proj col" style={{ gap: 6 }}>
              <div className="row">
                <b className="grow">{p.name}</b>
                {p.is_sample && <span className="chip guide">샘플</span>}
              </div>
              <span className="tiny muted">
                {p.client_name ?? "고객 미지정"} · 방 {p.rooms}개 · {new Date(p.created_at).toLocaleDateString("ko-KR")}
              </span>
              {p.last_render_at && <span className="tiny muted">마지막 렌더 {new Date(p.last_render_at).toLocaleString("ko-KR")}</span>}
            </Link>
          ))}
        </div>
        <p className="tiny muted">
          이번 달 렌더 {me?.usage.renders ?? 0}회 / 한도 {me?.workspace.limits?.monthlyRenders ?? "-"}회
        </p>
      </div>
    </>
  );
}
