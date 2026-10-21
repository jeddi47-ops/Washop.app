import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En développement, /api (HTTP et WebSocket) est relayé vers le backend FastAPI.
// HTTPS=1 (npm run dev:https) : nécessaire pour la caméra sur un téléphone du réseau local.
export default defineConfig(async () => {
  const plugins = [react()];
  if (process.env.HTTPS === "1") {
    const { default: basicSsl } = await import("@vitejs/plugin-basic-ssl");
    plugins.push(basicSsl());
  }
  return {
    plugins,
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: process.env.BACKEND_URL || "http://localhost:8000",
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
