import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";

export interface Me {
  user: { id: string; email: string; name: string };
  org: { id: string; name: string; timezone: string };
  role: "owner" | "staff";
  perms: Record<string, boolean>;
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void> }>({ me: null, loading: true, refresh: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try {
      setMe(await get<Me>("/api/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
    const h = () => setMe(null);
    window.addEventListener("ss:unauthorized", h);
    return () => window.removeEventListener("ss:unauthorized", h);
  }, []);
  return <Ctx.Provider value={{ me, loading, refresh }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
export const canDo = (me: Me | null, perm: string) => !!me && (me.role === "owner" || me.perms?.[perm] === true);
