// Bakes the eye-anatomy GLB: generates UVs (sphere/plane/cylinder/radial) and
// runs the Loop-subdivision pass at build time, so the runtime viewer loads
// pre-smoothed geometry with UVs and skips both passes (saves ~3.4s of
// blocking load time). Meshes are flagged mesh.userData.baked = true, which
// survives GLTF round-trips via node extras.
//
// Usage: node scripts/bake-eye.js [input.glb] [output.glb]
//   defaults: public/models/eye-anatomy.glb -> public/models/eye-anatomy-baked.glb

const fs = require("fs");
const path = require("path");

// GLTFExporter's binary path uses FileReader (browser-only); polyfill for node.
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onload?.();
        this.onloadend?.();
      });
    }
  };
}

const THREE = require("three");
const { GLTFLoader } = require("three/examples/jsm/loaders/GLTFLoader.js");
const { GLTFExporter } = require("three/examples/jsm/exporters/GLTFExporter.js");
const { mergeGeometries } = require("three/examples/jsm/utils/BufferGeometryUtils.js");

const ROOT = path.resolve(__dirname, "..");
const INPUT = process.argv[2] || "source/eye-anatomy.glb";
const OUTPUT = process.argv[3] || "public/models/eye-anatomy-baked.glb";

// ---- geometry-kind lookup (must mirror anatomy-materials.ts) ----
const PART_FROM_MESH = {
  VH_M_cornea_L: "cornea",
  VH_M_corneo_scleral_junction_L: "limbus",
  VH_M_iris_L: "iris",
  VH_M_pupil_L: "pupil",
  VH_M_lens_L: "lens",
  VH_M_suspensory_ligament_of_lens_L: "zonules",
  VH_M_aqueous_humor_L: "aqueous",
  VH_M_ciliary_body_L: "ciliary_body",
  VH_M_ciliary_muscle_L: "ciliary_muscle",
  VH_M_ciliary_processes_L: "ciliary_processes",
  VH_M_trabecular_meshwork_L: "trabecular",
  VH_M_schlemms_canal_L: "schlemm",
  VH_M_palpebral_conjunctiva_of_upper_eyelid_L: "conj_palpebral_upper",
  VH_M_palpebral_conjunctiva_of_lower_eyelid_L: "conj_palpebral_lower",
  VH_M_bulbar_conjunctiva_L: "conj_bulbar",
  VH_M_sclera_L: "sclera",
  VH_M_optic_choroid_L: "choroid",
  VH_M_retina_L: "retina",
  VH_M_fovea_L: "fovea",
  VH_M_macula_lutea_L: "macula",
  VH_M_optic_disc_L: "optic_disc",
  VH_M_ora_serrata_of_retina_L: "ora_serrata",
  VH_M_vitreous_humor_L: "vitreous",
};

const UV_KIND = {
  sclera: "sphere", cornea: "sphere", iris: "radial", pupil: "plane",
  lens: "sphere", zonules: "plane", aqueous: "sphere", ciliary_body: "cylinder",
  ciliary_muscle: "plane", ciliary_processes: "cylinder", trabecular: "cylinder",
  schlemm: "cylinder", conj_palpebral_upper: "sphere", conj_palpebral_lower: "sphere",
  conj_bulbar: "sphere", choroid: "sphere", retina: "sphere", fovea: "plane",
  macula: "plane", optic_disc: "plane", ora_serrata: "cylinder", vitreous: "sphere",
  limbus: "sphere",
};

/** Mirrors generatePartUVs in anatomy-materials.ts. */
function generatePartUVs(mesh, kind, backPole = false) {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos) return;
  const count = pos.count;
  const uvs = new Float32Array(count * 2);
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  let minR = Infinity;
  let maxR = 0;
  if (kind === "radial") {
    for (let i = 0; i < count; i += 1) {
      const r = Math.hypot(pos.getX(i) - center.x, pos.getZ(i) - center.z);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
  }
  for (let i = 0; i < count; i += 1) {
    const x = pos.getX(i) - center.x;
    const y = pos.getY(i) - center.y;
    const z = pos.getZ(i) - center.z;
    let u, v;
    if (kind === "sphere") {
      const r = Math.max(Math.hypot(x, y, z), 1e-5);
      u = (Math.atan2(x, z) / (Math.PI * 2)) + 0.5 + (backPole ? 0.5 : 0);
      v = Math.acos(THREE.MathUtils.clamp(y / r, -1, 1)) / Math.PI;
    } else if (kind === "radial") {
      const r = Math.max(Math.hypot(x, z), 1e-5);
      u = (Math.atan2(z, x) / (Math.PI * 2)) + 0.5;
      const span = Math.max(maxR - minR, 1e-5);
      v = (r - minR) / span;
    } else if (kind === "plane") {
      u = (x / size.x) + 0.5;
      v = (z / size.z) + 0.5;
    } else {
      const r = Math.max(Math.hypot(x, z), 1e-5);
      u = (Math.atan2(z, x) / (Math.PI * 2)) + 0.5;
      v = (y / size.y) + 0.5;
    }
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  const existing = mesh.geometry.getAttribute("uv");
  if (existing) mesh.geometry.deleteAttribute("uv");
  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

function loadGlb(file) {
  return new Promise((resolve, reject) => {
    const data = fs.readFileSync(file);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    new GLTFLoader().parse(buffer, "", (g) => resolve(g), (e) => reject(e));
  });
}

/** Radially repositions a ring mesh around the Z axis: x,y multiplied by `s`,
 *  z shifted by `dz`. Corrects TM/SC into the scleral sulcus against the
 *  limbus (maxXY 1.00, z 1.23-1.43). */
function mulberry32(seed) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function relocateRing(mesh, s, dz = 0) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i += 1) {
    pos.setX(i, pos.getX(i) * s);
    pos.setY(i, pos.getY(i) * s);
    pos.setZ(i, pos.getZ(i) + dz);
  }
  pos.needsUpdate = true;
}

/** Builds the 28 collector channels as fine lines (THREE.Line — not tubes,
 *  ~1/10 the calibre of SC). They leave the outer wall of Schlemm's canal
 *  (r = SC outer wall = 1.28, just outside the ciliary body's outer rim,
 *  z = 0.92 at the ciliary body's posterior rim) and run radially through the
 *  sclera to its surface (r≈1.55). Distribution: 28 total, nasal-dominant
 *  (inferonasal densest), per the literature. */
function buildCollectorChannels() {
  const SC_R = 1.28;
  const END_R = 1.55;
  const Z = 0.92;
  const rand = mulberry32(77);
  const positions = [];
  const addLine = (thetaDeg) => {
    const a = THREE.MathUtils.degToRad(thetaDeg);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(a) * SC_R, Math.sin(a) * SC_R, Z),
      new THREE.Vector3(Math.cos(a + 0.05) * (SC_R + 0.28), Math.sin(a + 0.05) * (SC_R + 0.28), Z + 0.03),
      new THREE.Vector3(Math.cos(a + 0.015) * END_R, Math.sin(a + 0.015) * END_R, Z + 0.015),
    ]);
    curve.getPoints(7).forEach((p) => positions.push(p.x, p.y, p.z));
  };
  const pick = (start, end, n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push(start + ((i + 0.5) / n) * (end - start) + (rand() - 0.5) * 6);
    }
    return out;
  };
  // 0° = +X (nasal for the left eye), 90° = +Y, 180° = -X, 270° = -Y
  const angles = [
    ...pick(278, 352, 9), // inferonasal: 10 (9 in 278-352 + 1 near +X)
    ...pick(354, 356, 1),
    ...pick(12, 78, 6),   // superonasal: 6
    ...pick(192, 258, 6), // inferotemporal: 6
    ...pick(102, 168, 6), // superotemporal: 6
  ];
  if (angles.length !== 28) throw new Error(`CC count ${angles.length} != 28`);
  angles.forEach(addLine);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  const mesh = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd9c27a, transparent: true, opacity: 0.9 }));
  mesh.name = "VH_M_collector_channel_L";
  mesh.userData.baked = true;
  mesh.frustumCulled = false;
  return mesh;
}

(async () => {
  const LoopSubdivision = (await import("three-subdivide")).LoopSubdivision;
  const t0 = Date.now();
  const gltf = await loadGlb(path.join(ROOT, INPUT));
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  console.log(`loaded ${meshes.length} meshes (${Date.now() - t0}ms)`);

  let totalSub = 0;
  // Correct SC/TM placement relative to the ciliary body ring (maxXY 1.18):
  // SC sits INSIDE the ring's outer edge — SC outer wall 1.158 (0.864 × 1.34),
  // a hair inside the ciliary body's 1.18 outer rim, hugging it from within.
  // TM's outer edge is scaled to kiss SC's inner wall exactly (TM 0.885 ×
  // 1.024 ≈ 0.906 = SC inner wall 0.676 × 1.34) — full contact, no gap, no
  // overlap. Both sit at the ciliary body's posterior rim plane (z ≈ 0.9):
  // SC dz −0.30 (z 0.891-0.963), TM dz −0.30 aligns with SC.
  relocateRing(meshes.find((m) => m.name === "VH_M_trabecular_meshwork_L"), 1.018, -0.27);
  relocateRing(meshes.find((m) => m.name === "VH_M_schlemms_canal_L"), 1.34, -0.3);
  console.log("relocated TM (x1.018, z-0.27) and SC (x1.34, z-0.30)");

  for (const mesh of meshes) {
    const id = PART_FROM_MESH[mesh.name] || null;
    if (!id) continue;
    const kind = UV_KIND[id];
    generatePartUVs(mesh, kind, id === "choroid" || id === "retina");
    if (id === "sclera" || id === "cornea" || id === "choroid" || id === "retina") {
      const s = Date.now();
      const original = mesh.geometry;
      const smooth = LoopSubdivision.modify(original, 1, { uvSmooth: true });
      mesh.geometry = smooth;
      original.dispose();
      const dt = Date.now() - s;
      totalSub += dt;
      console.log(`  subdivided ${id}: ${dt}ms, tris=${Math.round(smooth.index ? smooth.index.count / 3 : smooth.attributes.position.count / 3)}`);
    } else {
      console.log(`  uv only     ${id}`);
    }
    mesh.userData.baked = true;
  }
  console.log(`total subdivision ${totalSub}ms`);

  // Collector channels are NOT baked: gltf-transform's draco pass drops Line
  // primitives, so the viewer generates them at runtime (viewer.ts).

  const exported = await new Promise((res, rej) =>
    new GLTFExporter().parse(gltf.scene, res, rej, { binary: true, onlyVisible: false }),
  );
  const out = path.join(ROOT, OUTPUT);
  fs.writeFileSync(out, Buffer.from(exported));
  const mb = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`written ${OUTPUT} (${mb} MB)`);
})().catch((e) => { console.error("BAKE_FAIL:", e.message); process.exit(1); });
