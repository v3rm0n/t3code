import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// node-pty dlopens a native addon, so it ships next to the bundle in the VM
// image's node_modules. Everything else is inlined into one file.
const isNodePty = (id: string) => id === "node-pty" || id.startsWith("node-pty/");

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/main.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: (id: string) => !id.startsWith("node:") && !isNodePty(id),
        neverBundle: isNodePty,
        onlyBundle: false,
      },
    },
  }),
);
