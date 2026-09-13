import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __TALKAK_WEBDRIVER_CI__: JSON.stringify(mode === "webdriver-ci"),
  },
  clearScreen: false,
  test: {
    // Agent worktrees under .claude/ carry their own copies of every test file.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
  server: {
    port: 1420,
    strictPort: true,
  },
}));
