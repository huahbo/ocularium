/** Cloudflare Worker entry point: serves the vinext RSC app + static assets.
 *  The template's image-optimization route was removed (no next/image usage;
 *  its IMAGES binding is not configured in wrangler.jsonc). */
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
