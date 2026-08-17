// Ocularium 3D interaction regression: peel / quiz / tour (no conditions).
// Run: node scripts/e2e-regression.mjs  (needs `npm run start` on :3000 + chromium 1234)
// Headless WebGL is slow (12s per readPixels) — keep timeouts generous.
import pw from "playwright-core";
import { appendFileSync } from "node:fs";
const LOG = "tests/artifacts/regression.log";
const log = (m) => { try { appendFileSync(LOG, new Date().toISOString() + " " + m + "\n"); } catch {} };

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000/";
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  [" + extra + "]" : ""));
};
async function clickEl(page, locator) {
  // Model loads (especially Anatomy mode) cover the chrome with .model-loader;
  // wait it away so the click lands on the actual control. Also scroll the
  // target into view — mouse.click does not auto-scroll like locator.click.
  await page.waitForSelector(".model-loader", { state: "detached", timeout: 45000 }).catch(() => {});
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error("no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

log("=== start ===");
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 90000 });
  log("goto done");
  await page.waitForSelector(".three-mount canvas", { timeout: 60000 });
  log("canvas found");
  await page.waitForTimeout(4000);
  check("page title", (await page.title()).includes("Ocularium"));
  const layerCount = await page.locator(".structure-item").count();
  check("structure rail 24 layers", layerCount === 24, "count=" + layerCount);

    // ---- mode switch (Layered -> Anatomy -> Outflow -> Layered) ----
  // Anatomy/Outflow reload the GLB, which (headless) takes a while and covers
  // the chrome with .model-loader — retry the click until the tab selects.
  const modes = page.locator(".mode-switch button");
  const modeNames = await modes.allTextContents();
  check("mode switch has 3 tabs", modeNames.length === 3, modeNames.map(s => s.trim()).join(","));
  const modeClick = async (i) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await page.waitForSelector(".model-loader", { state: "detached", timeout: 45000 }).catch(() => {});
      const box = await modes.nth(i).boundingBox();
      if (!box) throw new Error("no mode tab box");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(900);
      if ((await modes.nth(i).getAttribute("aria-selected")) === "true") return true;
    }
    return false;
  };
  check("anatomy mode selected", await modeClick(1));
  check("outflow mode selected", await modeClick(2));
  check("back to layered mode", await modeClick(0));

  // ---- peel ----
  const corneaEye = page.locator(".structure-item", { hasText: "Cornea" }).first().locator(".structure-eye");
  const pressedBefore = await corneaEye.getAttribute("aria-pressed");
  await clickEl(page, corneaEye);
  await page.waitForTimeout(800);
  const pressedHidden = await corneaEye.getAttribute("aria-pressed");
  check("peel: cornea hidden toggles aria-pressed", pressedBefore !== pressedHidden, pressedBefore + " -> " + pressedHidden);
  log("peel hidden shot...");
  await page.screenshot({ path: "tests/artifacts/peel-cornea-hidden.png" });
  await clickEl(page, corneaEye);
  await page.waitForTimeout(800);
  check("peel: cornea restored", (await corneaEye.getAttribute("aria-pressed")) === pressedBefore);

  // ---- quiz ----
  await clickEl(page, page.locator(".action-grid button", { hasText: "Quiz" }).first());
  await page.waitForSelector(".quiz-card", { timeout: 15000 });
  check("quiz opens", true);
  const hintBefore = await page.locator(".quiz-hint").first().textContent().catch(() => "");
  const canvas = await page.locator(".three-mount canvas").boundingBox();
  await page.mouse.click(canvas.x + canvas.width - 15, canvas.y + 15);
  await page.waitForTimeout(1600);
  const hintAfter = await page.locator(".quiz-hint").first().textContent().catch(() => "");
  check("quiz: empty-space click is not an attempt", hintBefore === hintAfter, JSON.stringify([hintBefore, hintAfter]));
  await clickEl(page, page.getByRole("button", { name: "Skip" }));
  await page.waitForTimeout(600);
  const progress = (await page.locator(".quiz-head em").textContent()).trim();
  check("quiz: skip advances to 2/10", progress === "2 / 10", progress);
  log("quiz shot...");
  await page.screenshot({ path: "tests/artifacts/quiz-q2.png" });
  await clickEl(page, page.locator(".quiz-close"));
  await page.waitForTimeout(600);
  check("quiz closes", (await page.locator(".quiz-card").count()) === 0);

  // ---- tour ----
  await clickEl(page, page.locator(".action-grid button", { hasText: "Tour" }).first());
  await page.waitForSelector(".tour-card", { timeout: 15000 });
  const t1 = (await page.locator(".tour-card h3").textContent()).trim();
  check("tour step 1 = Cornea", t1 === "Cornea", t1);
  await clickEl(page, page.locator(".tour-next"));
  await page.waitForTimeout(800);
  const t2 = (await page.locator(".tour-card h3").textContent()).trim();
  check("tour step 2 = Iris", t2 === "Iris", t2);
  log("tour shot...");
  await page.screenshot({ path: "tests/artifacts/tour-step2.png" });
  await clickEl(page, page.locator(".tour-close"));
  await page.waitForTimeout(600);
  check("tour closes", (await page.locator(".tour-card").count()) === 0);

  // ---- structure search filters the rail ----
  await page.locator(".structure-search input").fill("retina");
  await page.waitForTimeout(500);
  const filtered = await page.locator(".structure-item").count();
  check("search 'retina' filters rail", filtered === 2, "count=" + filtered);
  await page.locator(".structure-search-clear").click({ force: true }).catch(() => {});
  await page.locator(".structure-search input").fill("");
  await page.waitForTimeout(500);
  check("search clears back to 24", (await page.locator(".structure-item").count()) === 24);

  // ---- rail selection highlights the layer ----
  const choroidItem = page.locator(".structure-item", { hasText: "Choroid" }).first();
  await clickEl(page, choroidItem);
  await page.waitForTimeout(900);
  check("choroid row active", (await choroidItem.getAttribute("aria-pressed")) === "true");

  // ---- opacity slider for a transparent layer ----
  await clickEl(page, page.locator(".structure-item", { hasText: "Cornea" }).first());
  await page.waitForTimeout(700);
  const slider = page.locator(".structure-slider input");
  check("opacity slider appears for cornea", (await slider.count()) === 1);
  await slider.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "30");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(600);
  const pct = (await page.locator(".structure-slider em").textContent()).trim();
  check("opacity slider sets 30%", pct === "30%", pct);
  // reset selection
  await clickEl(page, page.locator(".brand"));
  await page.waitForTimeout(500);

  // ---- X-Ray tool toggle ----
  const xray = page.locator(".tool-button", { hasText: "X-Ray" }).first();
  await clickEl(page, xray);
  await page.waitForTimeout(600);
  check("xray activates", (await xray.getAttribute("aria-pressed")) === "true");
  await clickEl(page, xray);
  await page.waitForTimeout(600);
  check("xray deactivates", (await xray.getAttribute("aria-pressed")) === "false");

  log("final state ok");
} catch (e) {
  check("unhandled error: " + e.message.split("\n")[0], false);
  log("ERROR: " + e.message);
} finally {
  check("no page JS errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
log("=== done " + (results.length - failed) + "/" + results.length + " ===");
process.exit(failed ? 1 : 0);