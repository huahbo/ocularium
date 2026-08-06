import assert from "node:assert/strict";
import test from "node:test";

/** Boots the built RSC worker and requests the home page, mirroring how the
 *  production server would serve it (assets are intentionally 404 here —
 *  we only assert the SSR HTML shell). */
async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Ocularium home page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Ocularium/);
  assert.match(html, /Eye layers/);
  assert.match(html, /Anterior segment/);
});

test("exposes the Ocularium metadata", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /<title>Ocularium/);
  assert.match(html, /Anatomy of vision, in 3D/);
});
