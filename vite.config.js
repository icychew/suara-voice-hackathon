import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const isPublicBuild = mode === "public";
  const isOperatorBuild = mode === "operator";
  const input = {
    main: resolve(process.cwd(), "index.html"),
    prototype: resolve(process.cwd(), "prototype/index.html"),
  };

  if (!isPublicBuild) {
    input.voice = resolve(process.cwd(), "voice/index.html");
  }

  return {
    base: "/",
    define: {
      __SUARA_VOICE_ENTRY_ROUTE__: JSON.stringify(isPublicBuild ? null : "/voice/"),
    },
    plugins: [react(), ...(isOperatorBuild ? [{
      name: "suara-operator-boundary",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "suara-operator-only.json",
          source: JSON.stringify({ operatorOnly: true, deployable: false, purpose: "loopback_canary" }) });
      },
    }] : [])],
    build: {
      outDir: isPublicBuild ? "dist-public" : isOperatorBuild ? "dist-operator" : "dist",
      sourcemap: false,
      rollupOptions: { input },
      modulePreload: {
        polyfill: false,
      },
    },
  };
});
