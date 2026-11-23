import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import "./studio.css";
import { sget } from "./api";
import { Login, Join } from "./pages/Auth";
import { Home } from "./pages/Home";
import { Assets } from "./pages/Assets";
import { Ops } from "./pages/Ops";
import { SharePage } from "./pages/Share";
import { Editor } from "./editor/Editor";

export interface Me {
  user: { id: string; email: string; name: string; is_ops: boolean };
  workspace: { id: string; name: string; kind: string; limits: any };
  isOps: boolean;
  usage: { renders: number; cost: number };
  capabilities: { renderer: boolean; aiEdit: boolean };
}
const Ctx = createContext<{ me: Me | null; reload: () => Promise<void> }>({ me: null, reload: async () => {} });
export const useMe = () => useContext(Ctx);

function ProjectRedirect() {
  const { id } = useParams();
  const [room, setRoom] = useState<string | null>(null);
  useEffect(() => {
    sget(`/api/studio/projects/${id}`).then((p) => setRoom(p.rooms[0]?.id ?? "none"));
  }, [id]);
  if (!room) return <div className="page muted">불러오는 중…</div>;
  if (room === "none") return <Navigate to="/studio" replace />;
  return <Navigate to={`/studio/r/${room}`} replace />;
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setMe(await sget<Me>("/api/studio/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (location.pathname.startsWith("/s/")) {
      setLoading(false);
      return;
    }
    reload();
    const h = () => setMe(null);
    window.addEventListener("studio:unauthorized", h);
    return () => window.removeEventListener("studio:unauthorized", h);
  }, [reload]);
  if (loading) return <div className="page muted">불러오는 중…</div>;
  return (
    <Ctx.Provider value={{ me, reload }}>
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="/studio/join/:token" element={<Join />} />
        {!me ? (
          <Route path="*" element={<Login />} />
        ) : (
          <>
            <Route path="/studio" element={<Home />} />
            <Route path="/studio/p/:id" element={<ProjectRedirect />} />
            <Route path="/studio/r/:roomId" element={<Editor />} />
            <Route path="/studio/assets" element={<Assets />} />
            <Route path="/studio/ops" element={<Ops />} />
            <Route path="*" element={<Navigate to="/studio" replace />} />
          </>
        )}
      </Routes>
    </Ctx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
