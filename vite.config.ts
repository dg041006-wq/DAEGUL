import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 개발 서버: /studio/*, /s/* 는 스튜디오 앱(studio.html)으로
function studioFallback(): Plugin {
  return {
    name: "studio-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const u = req.url ?? "";
        if ((u === "/studio" || u.startsWith("/studio/") || u.startsWith("/s/")) && !/\.[a-z0-9]+(\?|$)/i.test(u.split("?")[0])) req.url = "/studio.html";
        next();
      });
    },
  };
}

export default defineConfig({
  root: "src/web",
  publicDir: "../../public",
  plugins: [react(), studioFallback()],
  build: {
    outDir: "../../dist-web",
    emptyOutDir: true,
    rollupOptions: { input: { main: path.resolve("src/web/index.html"), studio: path.resolve("src/web/studio.html") } },
  },
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": "http://localhost:3000" },
  },
});
