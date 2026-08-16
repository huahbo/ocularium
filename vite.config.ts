import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    build: {
      // Rolldown splits three.js into its own cacheable chunk automatically
      // (three.module ~570 kB); keep the group name stable and raise the
      // warning threshold so the independent 3D runtime doesn't alarm.
      rolldownOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes("node_modules/three")) return "three";
          },
        },
      },
      chunkSizeWarningLimit: 750,
    },
    server: {
      // Cloudflare quick tunnels hit the server with a random
      // *.trycloudflare.com Host header — allow it (and workers.dev) so
      // tunneled previews work without disabling host checks entirely.
      allowedHosts: ["*.trycloudflare.com", "*.workers.dev"],
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    preview: {
      // `vinext start` serves the production build through Vite's preview
      // server, which validates the Host header against preview.allowedHosts.
      allowedHosts: ["*.trycloudflare.com", "*.workers.dev"],
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});