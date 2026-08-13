import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __TALKAK_WEBDRIVER_CI__: JSON.stringify(mode === "webdriver-ci"),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
}));
