import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static site: `npm run build` writes dist/, which any static host (e.g. GitHub Pages) can serve.
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["harfbuzzjs"] },
  build: { target: "es2022" },
});
