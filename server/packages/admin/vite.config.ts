import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Reactor 管理后台（Web Admin）。开发期经 /api 代理到本机 identity 服务(8791)。
export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: "./",
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8791",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: { outDir: "dist" },
});
