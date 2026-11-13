import { defineConfig } from "vite";
import { copyFileSync, mkdirSync } from "fs";

export default defineConfig({
  server: { port: 5177, open: false },
  build: { target: "esnext", sourcemap: true },
  optimizeDeps: { include: ["genlayer-js", "viem"] },
  plugins: [
    {
      name: "copy-reviewer-files",
      closeBundle() {
        mkdirSync("dist/docs", { recursive: true });
        mkdirSync("dist/contracts", { recursive: true });
        copyFileSync("docs/PROJECT.md", "dist/docs/PROJECT.md");
        copyFileSync("docs/CONSENSUS.md", "dist/docs/CONSENSUS.md");
        copyFileSync("contracts/bandlot.py", "dist/contracts/bandlot.py");
        copyFileSync("SUBMISSION.md", "dist/SUBMISSION.md");
      },
    },
  ],
});
