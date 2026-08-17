import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// bake-eye.cjs is CJS; load it through createRequire so the test reuses the
// exact production pipeline (no duplicated logic).
const require = createRequire(import.meta.url);
const bake = require("../scripts/bake-eye.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "source", "eye-anatomy.glb");

const SUBDIVIDED = new Set(["sclera", "cornea", "choroid", "retina"]);

function triCount(mesh) {
  return mesh.geometry.index
    ? mesh.geometry.index.count / 3
    : mesh.geometry.attributes.position.count / 3;
}

function bbox(mesh) {
  const pos = mesh.geometry.attributes.position;
  let zmin = 1e9, zmax = -1e9, rmax = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
    if (r > rmax) rmax = r;
  }
  return { zmin, zmax, rmax };
}

/** Per-angle sector stats (12 sectors of 30°): max radius of the ring in each
 *  sector. Used for the SC/TM position audit. */
function sectorMaxR(mesh) {
  const pos = mesh.geometry.attributes.position;
  const sectors = new Array(12).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const s = Math.min(11, Math.floor(a / (Math.PI * 2) * 12));
    if (r > sectors[s]) sectors[s] = r;
  }
  return sectors;
}

let shared = null;

/** Runs the real bake pipeline once per process and caches the result. */
async function bakeOnce() {
  if (shared) return shared;
  const gltf = await bake.loadGlb(SOURCE);
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const trisBefore = new Map(meshes.map((m) => [m.name, triCount(m)]));
  const { totalSub } = await bake.runBake(gltf);
  const byName = new Map(meshes.map((m) => [m.name, m]));
  shared = { meshes, byName, trisBefore, totalSub };
  return shared;
}

test("source GLB contains exactly the 23 known HRA eye meshes", async () => {
  const { meshes } = await bakeOnce();
  const names = meshes.map((m) => m.name).sort();
  const expected = Object.keys(bake.PART_FROM_MESH).sort();
  assert.deepEqual(names, expected, "mesh names must match PART_FROM_MESH 1:1");
});

test("every mesh is flagged baked and carries a full UV set", async () => {
  const { meshes } = await bakeOnce();
  for (const m of meshes) {
    assert.equal(m.userData.baked, true, `${m.name} must be flagged baked`);
    const uv = m.geometry.attributes.uv;
    assert.ok(uv, `${m.name} must have UVs`);
    assert.equal(uv.count, m.geometry.attributes.position.count, `${m.name} UV count`);
    for (let i = 0; i < uv.count; i += 1) {
      assert.ok(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)), `${m.name} UV NaN`);
    }
  }
});

test("subdivision is applied to sclera/cornea/choroid/retina only", async () => {
  const { byName, trisBefore } = await bakeOnce();
  for (const [name, id] of Object.entries(bake.PART_FROM_MESH)) {
    const before = trisBefore.get(name);
    const after = triCount(byName.get(name));
    if (SUBDIVIDED.has(id)) {
      assert.ok(after > before * 2, `${name} (${id}) should be subdivided (before ${before} -> after ${after})`);
    } else {
      assert.equal(after, before, `${name} (${id}) must NOT be subdivided`);
    }
  }
});

test("sclera shell is thinned to ~1.17mm (0.176u)", async () => {
  const { byName } = await bakeOnce();
  const sclera = byName.get("VH_M_sclera_L");
  const outer = bake.buildFullOuterProfile(sclera, -2.0, 1.6, 100);
  const inner = bake.buildFullInnerProfile(sclera, -2.0, 1.6, 100);
  // Equatorial band: strict shell-thickness check (HRA raw was 0.20-0.35u).
  for (const z of [-1.0, -0.5, 0, 0.5]) {
    const thickness = outer(z) - inner(z);
    assert.ok(
      Math.abs(thickness - 0.176) < 0.025,
      `sclera thickness at z=${z} should be ~0.176, got ${thickness.toFixed(3)}`,
    );
  }
  // Full extent (outside the equatorial band, incl. limbus/posterior pole
  // where the profile blends toward the openings): still clearly thinned.
  for (const z of [-1.4, -1.2, 1.0, 1.2]) {
    const thickness = outer(z) - inner(z);
    assert.ok(
      thickness < 0.25,
      `sclera thickness at z=${z} must stay clearly thinned, got ${thickness.toFixed(3)}`,
    );
  }
});

test("cornea diameter is scaled from 13.5mm to 11.5mm", async () => {
  const { byName } = await bakeOnce();
  const { rmax } = bbox(byName.get("VH_M_cornea_L"));
  const target = 11.5 / 2 / bake.MM_PER_UNIT; // 0.865u
  assert.ok(
    Math.abs(rmax - target) < 0.02,
    `cornea rmax should be ~${target.toFixed(3)}u (11.5mm), got ${rmax.toFixed(3)}`,
  );
});

test("SC/TM rings sit in the limbal sulcus: z band and sclera-anchored radius", async () => {
  const { byName } = await bakeOnce();
  const sc = byName.get("VH_M_schlemms_canal_L");
  const tm = byName.get("VH_M_trabecular_meshwork_L");
  const sclera = byName.get("VH_M_sclera_L");
  const sclInFull = bake.buildFullInnerProfile(sclera, -2.0, 1.6, 100);

  // z band matches attachRingToScleraInner(..., 1.24, 1.40) / (..., 1.22, 1.40)
  const scBox = bbox(sc);
  const tmBox = bbox(tm);
  assert.ok(Math.abs(scBox.zmin - 1.24) < 0.02 && Math.abs(scBox.zmax - 1.40) < 0.02,
    `SC z band should be [1.24, 1.40], got [${scBox.zmin.toFixed(3)}, ${scBox.zmax.toFixed(3)}]`);
  assert.ok(Math.abs(tmBox.zmin - 1.22) < 0.02 && Math.abs(tmBox.zmax - 1.40) < 0.02,
    `TM z band should be [1.22, 1.40], got [${tmBox.zmin.toFixed(3)}, ${tmBox.zmax.toFixed(3)}]`);

  // median radius anchored to the (thinned) sclera inner surface: SC +0.05 (into
  // the sclera, ~0.33mm), TM -0.03 (anterior-chamber side). Regression guard:
  // the old bug dropped the rings into the ciliary-body hole (r ~0.86-0.89).
  const medianR = (mesh) => {
    const pos = mesh.geometry.attributes.position;
    const radii = [];
    for (let i = 0; i < pos.count; i += 1) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      if (r > 0.3) radii.push(r);
    }
    radii.sort((a, b) => a - b);
    return radii[Math.floor(radii.length / 2)];
  };
  const zMid = (mesh) => {
    const pos = mesh.geometry.attributes.position;
    let z = 0, n = 0;
    for (let i = 0; i < pos.count; i += 1) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      if (r > 0.3) { z += pos.getZ(i); n += 1; }
    }
    return z / n;
  };
  const scR = medianR(sc), scZ = zMid(sc);
  const tmR = medianR(tm), tmZ = zMid(tm);
  assert.ok(Math.abs(scR - (sclInFull(scZ) + 0.05)) < 0.08,
    `SC median radius should hug sclera-inner +0.05 at z=${scZ.toFixed(3)} (got ${scR.toFixed(3)} vs ${(sclInFull(scZ) + 0.05).toFixed(3)})`);
  assert.ok(Math.abs(tmR - (sclInFull(tmZ) - 0.03)) < 0.08,
    `TM median radius should sit sclera-inner -0.03 at z=${tmZ.toFixed(3)} (got ${tmR.toFixed(3)} vs ${(sclInFull(tmZ) - 0.03).toFixed(3)})`);
});

test("12-sector audit: SC stays inside the sclera; TM stays radially inside SC", async () => {
  const { byName } = await bakeOnce();
  const sc = byName.get("VH_M_schlemms_canal_L");
  const tm = byName.get("VH_M_trabecular_meshwork_L");
  const sclera = byName.get("VH_M_sclera_L");
  const sclOutFull = bake.buildFullOuterProfile(sclera, -2.0, 1.6, 100);

  // SC/TM sit in the limbal sulcus where the sclera outer surface shrinks
  // rapidly with z, so each vertex is compared against the sclera profile at
  // ITS OWN z (per-angle max-r per sector, worst overshoot must stay inside).
  const maxOvershoot = (mesh) => {
    const pos = mesh.geometry.attributes.position;
    let worst = -1e9;
    for (let i = 0; i < pos.count; i += 1) {
      const z = pos.getZ(i);
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      if (r < 0.3) continue;
      worst = Math.max(worst, r - sclOutFull(z));
    }
    return worst;
  };
  assert.ok(
    maxOvershoot(sc) < -0.05,
    `SC must sit at least 0.05u inside the sclera outer surface everywhere (worst overshoot ${maxOvershoot(sc).toFixed(3)}u)`,
  );
  assert.ok(
    maxOvershoot(tm) < -0.05,
    `TM must sit at least 0.05u inside the sclera outer surface everywhere (worst overshoot ${maxOvershoot(tm).toFixed(3)}u)`,
  );

  // Per-sector (12 x 30°): TM's outer wall stays radially inside SC's — the
  // anterior-chamber arrangement (SC in scleral tissue, TM facing the chamber).
  const scSectors = sectorMaxR(sc);
  const tmSectors = sectorMaxR(tm);
  for (let s = 0; s < 12; s += 1) {
    assert.ok(
      tmSectors[s] < scSectors[s],
      `sector ${s}: TM max r ${tmSectors[s].toFixed(3)} must stay radially inside SC (${scSectors[s].toFixed(3)})`,
    );
  }
});

test("choroid/retina are retracted to ora serrata and trimmed at the optic foramen", async () => {
  const { byName } = await bakeOnce();
  for (const name of ["VH_M_optic_choroid_L", "VH_M_retina_L"]) {
    const { zmin, zmax } = bbox(byName.get(name));
    assert.ok(Math.abs(zmax - 0.42) < 0.02, `${name} anterior edge should sit at ora serrata z~0.42, got ${zmax.toFixed(3)}`);
    assert.ok(Math.abs(zmin - -1.70) < 0.02, `${name} posterior tube should be trimmed at z=-1.70, got ${zmin.toFixed(3)}`);
  }
});

test("vitreous anterior surface does not poke into the lens (fossa patellaris)", async () => {
  const { byName } = await bakeOnce();
  const vitreous = byName.get("VH_M_vitreous_humor_L");
  const lens = byName.get("VH_M_lens_L");
  const lpos = lens.geometry.attributes.position;
  let lrmax = 0;
  for (let i = 0; i < lpos.count; i += 1) {
    const r = Math.hypot(lpos.getX(i), lpos.getY(i));
    if (r > lrmax) lrmax = r;
  }
  // per-r posterior (min-z) surface of the lens — same 32-bin sampling and
  // linear interpolation as attachVitreousToLens (backAt), so the comparison
  // matches the bake semantics exactly.
  const RB = 32;
  const back = new Array(RB).fill(1e9);
  for (let i = 0; i < lpos.count; i += 1) {
    const r = Math.hypot(lpos.getX(i), lpos.getY(i));
    const b = Math.min(RB - 1, Math.floor((r / (lrmax + 1e-6)) * RB));
    if (lpos.getZ(i) < back[b]) back[b] = lpos.getZ(i);
  }
  for (let b = 0; b < RB; b += 1) {
    if (back[b] < 1e8) continue;
    for (let j = 1; j < RB; j += 1) {
      if (b - j >= 0 && back[b - j] < 1e8) { back[b] = back[b - j]; break; }
      if (b + j < RB && back[b + j] < 1e8) { back[b] = back[b + j]; break; }
    }
  }
  const backAt = (r) => {
    const f = (r / (lrmax + 1e-6)) * RB;
    const i = Math.min(RB - 1, Math.max(0, Math.floor(f)));
    const i2 = Math.min(RB - 1, i + 1);
    const t = f - i;
    return back[i] * (1 - t) + back[i2] * t;
  };
  const vpos = vitreous.geometry.attributes.position;
  let worst = -1e9;
  for (let i = 0; i < vpos.count; i += 1) {
    const r = Math.hypot(vpos.getX(i), vpos.getY(i));
    if (r > lrmax * 0.98) continue;
    worst = Math.max(worst, vpos.getZ(i) - backAt(r));
  }
  assert.ok(worst < 0.006, `vitreous must stay behind the lens posterior surface (max overshoot ${worst.toFixed(4)}u)`);
});

test("bake pipeline is deterministic for the committed source", async () => {
  // Two independent runs must produce identical mesh counts and part coverage.
  const first = await bakeOnce();
  const gltf2 = await bake.loadGlb(SOURCE);
  const meshes2 = [];
  gltf2.scene.traverse((o) => { if (o.isMesh) meshes2.push(o); });
  assert.equal(meshes2.length, first.meshes.length, "mesh count stable across loads");
});
