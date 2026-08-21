// Bakes the eye-anatomy GLB: generates UVs (sphere/plane/cylinder/radial) and
// runs the Loop-subdivision pass at build time, so the runtime viewer loads
// pre-smoothed geometry with UVs and skips both passes (saves ~3.4s of
// blocking load time). Meshes are flagged mesh.userData.baked = true, which
// survives GLTF round-trips via node extras.
//
// Usage: node scripts/bake-eye.js [input.glb] [output.glb]
//   defaults: source/eye-anatomy.glb -> .bake/eye-anatomy-baked.glb
//   then: npx @gltf-transform/cli draco .bake/eye-anatomy-baked.glb public/models/eye-anatomy.glb
//
// The file is also a module: require() it to reuse the pipeline (runBake)
// and the phase functions — tests/bake-geometry.test.mjs asserts the baked
// geometry invariants (bboxes, SC/TM ring positions, UVs, subdivision)
// against the committed source GLB.

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

const ROOT = path.resolve(__dirname, "..");
const INPUT = process.argv[2] || "source/eye-anatomy.glb";
// Intermediate output stays OUT of public/ — it is never served at runtime
// (the draco-compressed eye-anatomy.glb is), and a 56 MB file in public/ gets
// copied into every build's dist. Compress with:
//   npx @gltf-transform/cli draco .bake/eye-anatomy-baked.glb public/models/eye-anatomy.glb
const OUTPUT = process.argv[3] || ".bake/eye-anatomy-baked.glb";

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

/** Phase 2: stretch a ciliary ring along the eye axis (anterior end anchored)
 *  and remap each vertex's radius so the ring keeps hugging the sclera's inner
 *  surface at its new z. */
function stretchRingAlongZ(mesh, zMinCur, zMaxCur, zMinNew, zMaxNew, scleraInner) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  const spanCur = zMaxCur - zMinCur;
  const spanNew = zMaxNew - zMinNew;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    const f = (z - zMinCur) / spanCur; // 0 at posterior, 1 at anterior
    const zNew = zMinNew + f * spanNew;
    const rsCur = scleraInner(z);
    const rsNew = scleraInner(zNew);
    const scale = rsCur > 1e-4 ? rsNew / rsCur : 1;
    const rNew = r * scale;
    const c = r > 1e-6 ? rNew / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
    pos.setZ(i, zNew);
  }
  pos.needsUpdate = true;
}

/** Phase 2b: retract a shell's anterior edge to the ciliary body's new
 *  posterior boundary (compress z, remap radius to the sclera inner surface). */
function retractAnteriorZ(mesh, zBreak, zNewMax, scleraInner) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  let zMax = -1e9;
  for (let i = 0; i < pos.count; i += 1) zMax = Math.max(zMax, pos.getZ(i));
  const spanOld = Math.max(1e-4, zMax - zBreak);
  const spanNew = zNewMax - zBreak;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (z <= zBreak) continue;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const f = (z - zBreak) / spanOld;
    const zNew = zBreak + f * spanNew;
    const rsCur = scleraInner(z);
    const rsNew = scleraInner(zNew);
    const scale = rsCur > 1e-4 ? rsNew / rsCur : 1;
    const rNew = r * scale;
    const c = r > 1e-6 ? rNew / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
    pos.setZ(i, zNew);
  }
  pos.needsUpdate = true;
}



/** Align a ring posterior edge to a target z plane, per angle. The HRA
 *  ciliary body is a tilted ring (posterior edge z 0.375 nasal to 0.57
 *  temporal), leaving a ~1mm annular gap to the choroid anterior edge
 *  (z=0.42) on the temporal side. Physiology: pars plana posterior edge
 *  = ora serrata = choroid anterior edge, one continuous ring.
 *  Per-angle z remap (posterior to zTarget, anterior unchanged) with the
 *  radius re-attached to the sclera inner surface. Outer-rim vertices
 *  (r > 1.0) define the per-angle posterior/anterior extremes. */
function alignRingPosterior(mesh, zTarget, scleraInner) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute('position');
  const BINS = 64;
  const zMin = new Array(BINS).fill(1e9);
  const zMax = new Array(BINS).fill(-1e9);
  const binOf = (x, y) => {
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    return Math.min(BINS - 1, Math.floor((a / (Math.PI * 2)) * BINS));
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 1.0) continue; // outer rim only defines the edge
    const b = binOf(x, y);
    const z = pos.getZ(i);
    if (z < zMin[b]) zMin[b] = z;
    if (z > zMax[b]) zMax[b] = z;
  }
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.05) continue;
    const b = binOf(x, y);
    const zmin = zMin[b];
    const zmax = zMax[b];
    if (zmax <= zTarget + 1e-6) continue;
    const f = Math.max(0, (z - zmin) / Math.max(1e-4, zmax - zmin));
    const zNew = zTarget + f * (zmax - zTarget);
    const rsCur = scleraInner(z);
    const rsNew = scleraInner(zNew);
    const scale = rsCur > 1e-4 ? rsNew / rsCur : 1;
    const c = r > 1e-6 ? Math.min(r * scale, rsNew) / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
    pos.setZ(i, zNew);
  }
  pos.needsUpdate = true;
}

/** Extend the posterior center cap (r<0.55) of choroid/retina/vitreous onto
 *  the sclera inner-surface cap curve. The raw HRA shells end at z=-1.74/-1.71/-1.67,
 *  floating 0.7-1.0mm short of the sclera posterior cap (z=-1.84..-1.90), which
 *  reads as a flat wall in slice views. The sclera inner profile is non-monotonic
 *  behind z=-1.7 (cap vertices r<0.3 are skipped), so a fixed cap curve is used
 *  instead of binary search: capZ(r) anchors measured from the sclera inner cap. */
function extendPosteriorToInner(mesh, zStart, opts) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute('position');
  const CAP = [
    [0.0, -1.900], [0.013, -1.900], [0.111, -1.880], [0.255, -1.860],
    [0.363, -1.840], [0.46, -1.790], [0.55, -1.710],
  ];
  // linear-edge mode: smooth bowl from z=-1.90 (r=0) to the measured
  // boundary z at r~0.55 (keeps continuity with the untouched outer ring).
  let zEdge = null;
  if (opts && opts.linearEdge) {
    // min z over the r 0.50-0.60 ring = the posterior boundary (mean would
    // mix front+back vertices of a sphere and give a wrong mid-eye target).
    let zmin = 1e9;
    for (let i = 0; i < pos.count; i += 1) {
      const rr = Math.hypot(pos.getX(i), pos.getY(i));
      if (rr >= 0.50 && rr <= 0.60) zmin = Math.min(zmin, pos.getZ(i));
    }
    zEdge = zmin < 1e8 ? zmin : -1.71;
  }
  const capZ = (r) => {
    if (zEdge !== null) return -1.90 + (zEdge + 1.90) * (r / 0.55);

    for (let i = 1; i < CAP.length; i += 1) {
      if (r <= CAP[i][0]) {
        const r0 = CAP[i - 1][0], z0 = CAP[i - 1][1];
        const r1 = CAP[i][0], z1 = CAP[i][1];
        const t = (r - r0) / (r1 - r0);
        return z0 + t * (z1 - z0);
      }
    }
    return CAP[CAP.length - 1][1];
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r >= 0.55) continue;
    if (z > zStart) continue;
    pos.setZ(i, capZ(r));
  }
  pos.needsUpdate = true;
}

/** Expand the corneal edge outward to meet the limbus inner surface. The raw
 *  cornea sits sunken in the scleral opening: its outer edge (r 0.78-0.82 at
 *  z 1.21-1.32) trails the limbus inner radius (r=0.865) by 0.3-0.5mm, an
 *  annular gap visible from the side. Vertices in z 1.20-1.36 with r>0.5 are
 *  moved radially so the outer-edge contour lands on r=0.865 for z<=1.23,
 *  tapering to no change at z>=1.35; inner+outer surfaces shift together so
 *  the 1.17mm wedge thickness is preserved. */

function expandCorneaEdge(corneaMesh) {
  if (!corneaMesh) return;
  const pos = corneaMesh.geometry.getAttribute('position');
  const Z0 = 1.15, Z1 = 1.40, BINS = 50;
  const rOut = new Array(BINS).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (z < Z0 || z > Z1) continue;
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (r < 0.5) continue;
    const b = Math.min(BINS - 1, Math.floor(((z - Z0) / (Z1 - Z0)) * BINS));
    if (r > rOut[b]) rOut[b] = r;
  }
  const outAt = (z) => {
    const f = Math.min(1, Math.max(0, (z - Z0) / (Z1 - Z0)));
    const b = Math.min(BINS - 1, Math.floor(f * BINS));
    return rOut[b] || 0.8;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.5) continue;
    if (z < 1.20 || z > 1.36) continue;
    const w = z <= 1.26 ? 1 : Math.max(0, 1 - (z - 1.26) / 0.10);
    if (w <= 0) continue;
    const delta = (0.865 - outAt(z)) * w;
    if (delta <= 0) continue;
    const c = (r + delta) / r;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

/** Translate every vertex of a mesh (used for repositioning posterior markers). */
function translateMesh(mesh, dx, dy, dz) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    pos.setX(i, pos.getX(i) + dx);
    pos.setY(i, pos.getY(i) + dy);
    pos.setZ(i, pos.getZ(i) + dz);
  }
  pos.needsUpdate = true;
}

/** Widen the anterior sclera outer surface onto the spherical reference so the
 *  cornea-limbus-sclera outer contour becomes one continuous bevel (AS-OCT
 *  morphology) instead of a stepped cylinder-cone. z 1.00-1.32 ramps up to the
 *  reference sphere r=sqrt(1.8^2 - z^2) (max +0.16u at z~1.25); z 1.25-1.32
 *  ramps back to 0 so the anterior opening rim (z>1.32, where the cornea
 *  sits) is untouched. Inner+outer surfaces shift together (shell thickness
 *  preserved). Must run BEFORE thinSclera/P0 profile so all downstream
 *  attachments (sclInFull, SC/TM, ciliary) follow automatically. */
function widenAnteriorSclera(scleraMesh) {
  if (!scleraMesh) return;
  const pos = scleraMesh.geometry.getAttribute('position');
  const Z0 = 1.00, Z1 = 1.32, BINS = 40;
  const tgt = (z) => Math.sqrt(Math.max(0, 1.8 * 1.8 - z * z));
  const rOut = new Array(BINS).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (z < Z0 || z > Z1) continue;
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    const b = Math.min(BINS - 1, Math.floor(((z - Z0) / (Z1 - Z0)) * BINS));
    if (r > rOut[b]) rOut[b] = r;
  }
  const outAt = (z) => {
    const f = Math.min(1, Math.max(0, (z - Z0) / (Z1 - Z0)));
    const b = Math.min(BINS - 1, Math.floor(f * BINS));
    return rOut[b] || 0.8;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (z < Z0 || z > Z1) continue;
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    // ramp: 0 at z=1.00 -> 1 at z=1.25 -> 0 at z=1.32
    let w;
    if (z <= 1.25) w = Math.min(1, (z - Z0) / 0.25);
    else w = Math.max(0, 1 - (z - 1.25) / 0.07);
    if (w <= 0) continue;
    const delta = (tgt(z) - outAt(z)) * w;
    if (delta <= 0) continue;
    const c = (r + delta) / r;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

/** Phase 4: re-profile a ciliary ring's cross-section. Keeps the outer edge on
 *  the sclera inner surface and remaps the inner edge so the radial band equals
 *  `thicknessFn(z)` (triangle: thick anterior -> 0 posterior).
 *
 *  Normalisation uses the ring's OWN per-z max/min radius (not the sclera
 *  depth): f = (maxR(z) - r)/(maxR(z) - minR(z)), so the outer edge (f=0) is
 *  ALWAYS pinned to the sclera inner surface even when the raw mesh floats
 *  inside it (the old max-depth normalisation left a gap at the anterior end
 *  where the band was inflated by the inner rim). */
function reprofileCiliary(mesh, thicknessFn, scleraInner) {
  if (!mesh) return;
  const ZB = 64;
  const pos = mesh.geometry.getAttribute("position");
  let zmin = 1e9;
  let zmax = -1e9;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
  }
  // per-z max/min radius (angle-averaged)
  const bandMax = new Array(ZB).fill(0);
  const bandMin = new Array(ZB).fill(1e9);
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (r < 0.3) continue;
    const zb = Math.min(ZB - 1, Math.max(0, Math.floor(((z - zmin) / (zmax - zmin)) * ZB)));
    if (r > bandMax[zb]) bandMax[zb] = r;
    if (r < bandMin[zb]) bandMin[zb] = r;
  }
  const bandAt = (arr, z) => {
    const f = ((z - zmin) / (zmax - zmin)) * ZB;
    const i = Math.min(ZB - 1, Math.max(0, Math.floor(f)));
    const i2 = Math.min(ZB - 1, i + 1);
    const t = f - i;
    return arr[i] * (1 - t) + arr[i2] * t;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    const rOuter = scleraInner(z);
    const mx = bandAt(bandMax, z);
    const mn = bandAt(bandMin, z);
    const f = mx - mn > 1e-4 ? Math.min(1, Math.max(0, (mx - r) / (mx - mn))) : 0;
    const t = Math.max(0, thicknessFn(z));
    const rNew = rOuter - f * t;
    const c = r > 1e-6 ? rNew / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

/** Phase 4: shorten the ciliary muscle to ~4 mm and give it a wedge profile
 *  (thick anterior -> 0 posterior), hugging the sclera (outer portion only). */
function reprofileMuscle(mesh, scleraInner) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  // 1. z remap: [0.6, 1.225] -> [0.6, 1.208]; z < 0.6 collapses to 0.6.
  for (let i = 0; i < pos.count; i += 1) {
    let z = pos.getZ(i);
    if (z < 0.6) { pos.setZ(i, 0.6); continue; }
    z = 0.6 + ((z - 0.6) / (1.225 - 0.6)) * (1.208 - 0.6);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
  // 2. wedge profile (0.085u anterior -> 0 at z 0.6).
  reprofileCiliary(mesh, (z) => (0.085 * Math.max(0, z - 0.6)) / 0.608, scleraInner);
}



/** Phase 3b: re-profile the cornea to the anatomical thickness profile
 *  (centre ~0.5 mm -> edge ~1.17 mm) by rebuilding the INNER surface along
 *  the outer-surface NORMAL, not along z. The outer (anterior) surface stays
 *  fixed; each inner vertex moves from its own (r, angle) outer point P by
 *  `-N * thicknessAt(r)`, so the measured thickness is the true shell
 *  thickness everywhere (a z-offset would under-thicken the sloped edge —
 *  the old bug: z-thickness 1.16mm read 0.87mm normal at the edge).
 *
 *  The cornea is ELLIPTICAL (nasal side sits higher than the temporal side),
 *  so the outer surface is sampled per-(r, angle) with per-bin max-z and
 *  nearest-neighbour angle fill (the old per-r-only sample collapsed the
 *  posterior onto the anterior surface on the temporal side — "touching" bug). */
function reprofileCornea(corneaMesh, thicknessCenter, thicknessEdge) {
  if (!corneaMesh) return;
  const RB = 48;
  const AB = 64;
  const pos = corneaMesh.geometry.getAttribute("position");
  let nor = corneaMesh.geometry.getAttribute("normal");
  if (!nor) { corneaMesh.geometry.computeVertexNormals(); nor = corneaMesh.geometry.getAttribute("normal"); }
  let rmax = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (r > rmax) rmax = r;
  }
  // per-(r, angle) anterior-surface z + normal
  const front = new Array(RB * AB).fill(-1e9);
  const frontN = new Array(RB * AB).fill(null);
  for (let i = 0; i < pos.count; i += 1) {
    if (nor.getZ(i) <= 0.2) continue;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const rb = Math.min(RB - 1, Math.floor((r / (rmax + 1e-6)) * RB));
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const ab = Math.min(AB - 1, Math.floor((a / (Math.PI * 2)) * AB));
    const idx = rb * AB + ab;
    if (pos.getZ(i) > front[idx]) {
      front[idx] = pos.getZ(i);
      frontN[idx] = [nor.getX(i), nor.getY(i), nor.getZ(i)];
    }
  }
  // fill empty bins along the angle (nearest-neighbour) for smooth sampling
  for (let rb = 0; rb < RB; rb += 1) {
    for (let ab = 0; ab < AB; ab += 1) {
      if (front[rb * AB + ab] > -1e8) continue;
      for (let d = 1; d < AB; d += 1) {
        const l = (ab - d + AB) % AB;
        const rr = (ab + d) % AB;
        if (front[rb * AB + l] > -1e8) { front[rb * AB + ab] = front[rb * AB + l]; frontN[rb * AB + ab] = frontN[rb * AB + l]; break; }
        if (front[rb * AB + rr] > -1e8) { front[rb * AB + ab] = front[rb * AB + rr]; frontN[rb * AB + ab] = frontN[rb * AB + rr]; break; }
      }
    }
  }
  const frontAt = (r, a) => {
    const rf = (r / (rmax + 1e-6)) * RB;
    const r0 = Math.min(RB - 1, Math.max(0, Math.floor(rf)));
    const r1 = Math.min(RB - 1, r0 + 1);
    const rt = rf - r0;
    const af = (a / (Math.PI * 2)) * AB;
    const a0 = Math.min(AB - 1, Math.max(0, Math.floor(af)));
    const a1 = (a0 + 1) % AB;
    const at = af - a0;
    const v00 = front[r0 * AB + a0];
    const v01 = front[r0 * AB + a1];
    const v10 = front[r1 * AB + a0];
    const v11 = front[r1 * AB + a1];
    const v0 = v00 * (1 - at) + v01 * at;
    const v1 = v10 * (1 - at) + v11 * at;
    return v0 * (1 - rt) + v1 * rt;
  };
  const nrmAt = (r, a) => {
    const rf = (r / (rmax + 1e-6)) * RB;
    const r0 = Math.min(RB - 1, Math.max(0, Math.floor(rf)));
    const r1 = Math.min(RB - 1, r0 + 1);
    const rt = rf - r0;
    const af = (a / (Math.PI * 2)) * AB;
    const a0 = Math.min(AB - 1, Math.max(0, Math.floor(af)));
    const a1 = (a0 + 1) % AB;
    const at = af - a0;
    const lerp = (p, q, t) => (p && q)
      ? [p[0] * (1 - t) + q[0] * t, p[1] * (1 - t) + q[1] * t, p[2] * (1 - t) + q[2] * t]
      : (p || q);
    const n0 = lerp(frontN[r0 * AB + a0], frontN[r0 * AB + a1], at);
    const n1 = lerp(frontN[r1 * AB + a0], frontN[r1 * AB + a1], at);
    const n = lerp(n0, n1, rt);
    if (!n) return [0, 0, 1];
    const L = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / L, n[1] / L, n[2] / L];
  };
  const thicknessAt = (r) => thicknessCenter + (thicknessEdge - thicknessCenter) * Math.min(1, r / rmax);
  // Only the TRUE posterior surface (normal.z < -0.2). Move along the outer
  // normal so the measured thickness is the real shell thickness.
  for (let i = 0; i < pos.count; i += 1) {
    if (nor.getZ(i) >= -0.2) continue;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const pz = frontAt(r, a);
    const [nx, ny, nz] = nrmAt(r, a);
    const t = thicknessAt(r);
    pos.setX(i, x - nx * t);
    pos.setY(i, y - ny * t);
    pos.setZ(i, pz - nz * t);
  }
  pos.needsUpdate = true;
}

/** Phase 5: thin the sclera shell to its real thickness. The HRA sclera is
 *  ~1.3-2.3 mm thick (equator ~1.3 mm) vs the real ~0.4-1.0 mm (equator 0.4 mm,
 *  limbus 0.5 mm, posterior pole 1.0 mm). Move the INNER surface outward so the
 *  shell thickness matches `thicknessFn(z)`; the outer surface stays fixed. */
function thinSclera(scleraMesh, thicknessFn) {
  if (!scleraMesh) return;
  const RB = 48;
  const pos = scleraMesh.geometry.getAttribute("position");
  let nor = scleraMesh.geometry.getAttribute("normal");
  if (!nor) { scleraMesh.geometry.computeVertexNormals(); nor = scleraMesh.geometry.getAttribute("normal"); }
  let zmin = 1e9;
  let zmax = -1e9;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
  }
  const outer = new Array(RB).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    const b = Math.min(RB - 1, Math.floor(((pos.getZ(i) - zmin) / (zmax - zmin)) * RB));
    if (r > outer[b]) outer[b] = r;
  }
  const outerAt = (z) => {
    const f = ((z - zmin) / (zmax - zmin)) * RB;
    const i = Math.min(RB - 1, Math.max(0, Math.floor(f)));
    const i2 = Math.min(RB - 1, i + 1);
    const t = f - i;
    return outer[i] * (1 - t) + outer[i2] * t;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    // radial normal component: >0 = outward (outer surface), <0 = inward (inner)
    const dot = (nor.getX(i) * x + nor.getY(i) * y) / r;
    if (dot >= 0) continue; // inner surface only
    const target = outerAt(z) - thicknessFn(z);
    const c = r > 1e-6 ? target / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}



/** Unit scale: the bake model works in "units" where the sclera shell
 *  thickness constant 0.176u = 1.17mm (see thinSclera/thicknessFn), so
 *  1 unit = 6.6477 mm. */
const MM_PER_UNIT = 1.17 / 0.176; // 6.6477

/** Phase 3b: scale the cornea's XY extent so its diameter matches the
 *  anatomical value (~11.5 mm, down from the HRA 13.5 mm). Z is untouched.
 *  Call BEFORE reprofileCornea so the posterior rebuild uses the new edge
 *  radius. The aqueous humor (rmax 5.62 mm) stays fully covered by the
 *  cornea's new edge (5.75 mm). */
function scaleCorneaDiameter(corneaMesh, targetDiameterMm) {
  if (!corneaMesh) return;
  const pos = corneaMesh.geometry.getAttribute("position");
  let rmax = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (r > rmax) rmax = r;
  }
  const targetR = (targetDiameterMm / 2) / MM_PER_UNIT;
  const scale = rmax > 1e-4 ? targetR / rmax : 1;
  for (let i = 0; i < pos.count; i += 1) {
    pos.setX(i, pos.getX(i) * scale);
    pos.setY(i, pos.getY(i) * scale);
  }
  pos.needsUpdate = true;
  console.log(`scaled cornea diameter ${(rmax * 2 * MM_PER_UNIT).toFixed(1)}mm -> ${targetDiameterMm}mm (scale ${scale.toFixed(3)})`);
}

/** Build a per-z profile of a shell's OUTER surface (max r of ALL vertices)
 *  over the FULL z range. The sclera outer surface never moves (thinSclera
 *  only touches the inner surface), so this can be sampled before/after
 *  thinning. Used as the radial target for limbus attachment. */
function buildFullOuterProfile(mesh, z0, z1, zbins) {
  const pos = mesh.geometry.getAttribute("position");
  const outer = new Array(zbins).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (r < 0.3) continue;
    const f = (z - z0) / (z1 - z0);
    if (f < 0 || f >= 1) continue;
    const b = Math.floor(f * zbins);
    if (r > outer[b]) outer[b] = r;
  }
  for (let b = 0; b < zbins; b += 1) {
    if (outer[b] > 1e-4) continue;
    for (let j = 1; j < zbins; j += 1) {
      if (b - j >= 0 && outer[b - j] > 1e-4) { outer[b] = outer[b - j]; break; }
      if (b + j < zbins && outer[b + j] > 1e-4) { outer[b] = outer[b + j]; break; }
    }
  }
  return (z) => {
    const f = (z - z0) / (z1 - z0);
    const fb = Math.min(zbins - 1, Math.max(0, f * zbins));
    const i = Math.floor(fb);
    const i2 = Math.min(zbins - 1, i + 1);
    const t = fb - i;
    return outer[i] * (1 - t) + outer[i2] * t;
  };
}

/** Build a per-z profile of a shell's INNER surface (min r of inner-surface
 *  vertices, identified by the radial normal pointing inward) over the FULL
 *  z range. Unlike buildScleraInnerProfile's removed predecessor (anterior zone only), this covers
 *  the posterior pole, which choroid/retina need. */
function buildFullInnerProfile(mesh, z0, z1, zbins) {
  const pos = mesh.geometry.getAttribute("position");
  let nor = mesh.geometry.getAttribute("normal");
  if (!nor) { mesh.geometry.computeVertexNormals(); nor = mesh.geometry.getAttribute("normal"); }
  const inner = new Array(zbins).fill(1e9);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    const dot = (nor.getX(i) * x + nor.getY(i) * y) / r;
    if (dot >= -0.05) continue; // outer surface only
    const f = (z - z0) / (z1 - z0);
    if (f < 0 || f >= 1) continue;
    const b = Math.floor(f * zbins);
    if (r < inner[b]) inner[b] = r;
  }
  for (let b = 0; b < zbins; b += 1) {
    if (inner[b] !== 1e9) continue;
    for (let j = 1; j < zbins; j += 1) {
      if (b - j >= 0 && inner[b - j] !== 1e9) { inner[b] = inner[b - j]; break; }
      if (b + j < zbins && inner[b + j] !== 1e9) { inner[b] = inner[b + j]; break; }
    }
  }
  return (z) => {
    const f = (z - z0) / (z1 - z0);
    const fb = Math.min(zbins - 1, Math.max(0, f * zbins));
    const i = Math.floor(fb);
    const i2 = Math.min(zbins - 1, i + 1);
    const t = fb - i;
    return inner[i] * (1 - t) + inner[i2] * t;
  };
}

/** Phase 7: attach a shell exactly to a reference inner surface — outer
 *  surface vertices land on `outerFn(z)`, inner surface vertices land
 *  `thickness` radially inside it. Replaces the old fixed shiftShellOutward,
 *  which could not follow the sloped/posterior sclera profile. */
function attachShellToInner(mesh, outerFn, thickness) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  let nor = mesh.geometry.getAttribute("normal");
  if (!nor) { mesh.geometry.computeVertexNormals(); nor = mesh.geometry.getAttribute("normal"); }
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    const dot = (nor.getX(i) * x + nor.getY(i) * y) / r;
    const target = outerFn(z) - (dot < -0.05 ? thickness : 0);
    const c = r > 1e-6 ? target / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

/** Phase 3b: pull the aqueous humor's ANTERIOR surface onto the cornea's new
 *  inner (posterior) surface so the two are flush (anterior chamber front),
 *  and clamp its SIDE wall inside the cornea edge. Sampled per-(r, angle):
 *  cornea inner z (min-z per bin, true posterior), aqueous pushed back where
 *  it crosses, pulled forward where it lags; plus a per-z clamp on r so the
 *  aqueous never pokes OUT past the (shrunk) cornea — the old bug: aqueous
 *  kept its 13.5mm-era radius and showed as a crescent ring outside the
 *  11.5mm cornea in cross-sections. */
function flushAqueousToCornea(aqueousMesh, corneaMesh) {
  if (!aqueousMesh || !corneaMesh) return;
  const RB = 48;
  const AB = 64;
  const cpos = corneaMesh.geometry.getAttribute("position");
  let cnor = corneaMesh.geometry.getAttribute("normal");
  if (!cnor) { corneaMesh.geometry.computeVertexNormals(); cnor = corneaMesh.geometry.getAttribute("normal"); }
  let crmax = 0;
  for (let i = 0; i < cpos.count; i += 1) {
    const r = Math.hypot(cpos.getX(i), cpos.getY(i));
    if (r > crmax) crmax = r;
  }
  const inner = new Array(RB * AB).fill(1e9);
  for (let i = 0; i < cpos.count; i += 1) {
    const x = cpos.getX(i);
    const y = cpos.getY(i);
    const r = Math.hypot(x, y);
    const rb = Math.min(RB - 1, Math.floor((r / (crmax + 1e-6)) * RB));
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const ab = Math.min(AB - 1, Math.floor((a / (Math.PI * 2)) * AB));
    const idx = rb * AB + ab;
    if (cpos.getZ(i) < inner[idx]) inner[idx] = cpos.getZ(i);
  }
  for (let rb = 0; rb < RB; rb += 1) {
    for (let ab = 0; ab < AB; ab += 1) {
      if (inner[rb * AB + ab] < 1e8) continue;
      for (let d = 1; d < AB; d += 1) {
        const l = (ab - d + AB) % AB;
        const rr = (ab + d) % AB;
        if (inner[rb * AB + l] < 1e8) { inner[rb * AB + ab] = inner[rb * AB + l]; break; }
        if (inner[rb * AB + rr] < 1e8) { inner[rb * AB + ab] = inner[rb * AB + rr]; break; }
      }
    }
  }
  const innerAt = (r, a) => {
    const rf = (r / (crmax + 1e-6)) * RB;
    const r0 = Math.min(RB - 1, Math.max(0, Math.floor(rf)));
    const r1 = Math.min(RB - 1, r0 + 1);
    const rt = rf - r0;
    const af = (a / (Math.PI * 2)) * AB;
    const a0 = Math.min(AB - 1, Math.max(0, Math.floor(af)));
    const a1 = (a0 + 1) % AB;
    const at = af - a0;
    const v00 = inner[r0 * AB + a0];
    const v01 = inner[r0 * AB + a1];
    const v10 = inner[r1 * AB + a0];
    const v11 = inner[r1 * AB + a1];
    const v0 = v00 * (1 - at) + v01 * at;
    const v1 = v10 * (1 - at) + v11 * at;
    return v0 * (1 - rt) + v1 * rt;
  };
  // per-z max r of the cornea's TRUE INNER surface (normal.z < -0.2) — the
  // side-wall limit for the aqueous.
  let czmin = 1e9;
  let czmax = -1e9;
  for (let i = 0; i < cpos.count; i += 1) {
    const z = cpos.getZ(i);
    czmin = Math.min(czmin, z);
    czmax = Math.max(czmax, z);
  }
  const ZB = 80;
  const cInR = new Array(ZB).fill(0);
  for (let i = 0; i < cpos.count; i += 1) {
    if (cnor.getZ(i) >= -0.2) continue; // inner only
    const z = cpos.getZ(i);
    const r = Math.hypot(cpos.getX(i), cpos.getY(i));
    const b = Math.min(ZB - 1, Math.max(0, Math.floor(((z - czmin) / (czmax - czmin + 1e-6)) * ZB)));
    if (r > cInR[b]) cInR[b] = r;
  }
  for (let b = 0; b < ZB; b += 1) {
    if (cInR[b] > 1e-4) continue;
    for (let j = 1; j < ZB; j += 1) {
      if (b - j >= 0 && cInR[b - j] > 1e-4) { cInR[b] = cInR[b - j]; break; }
      if (b + j < ZB && cInR[b + j] > 1e-4) { cInR[b] = cInR[b + j]; break; }
    }
  }
  const cInRAt = (z) => {
    const f = ((z - czmin) / (czmax - czmin + 1e-6)) * ZB;
    const i = Math.min(ZB - 1, Math.max(0, Math.floor(f)));
    const i2 = Math.min(ZB - 1, i + 1);
    const t = f - i;
    return cInR[i] * (1 - t) + cInR[i2] * t;
  };
  const pos = aqueousMesh.geometry.getAttribute("position");
  const GAP = 0.005; // ~0.03mm, avoid z-fighting with the cornea inner face
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    // side wall: never exceed the cornea's inner-surface radius at this z
    const rMax = cInRAt(z);
    if (r > rMax - GAP && rMax > 0.3) {
      const c = (rMax - GAP) / r;
      pos.setX(i, x * c);
      pos.setY(i, y * c);
    }
    if (r > crmax) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const iz = innerAt(r, a);
    if (pos.getZ(i) > iz - GAP) pos.setZ(i, iz - GAP);
  }
  pos.needsUpdate = true;
}

/** Phase 6: attach the limbus (corneoscleral junction) to the sclera OUTER
 *  surface — outer-surface vertices land exactly on sclOutFull(z), inner
 *  vertices land on the CORNEA's outer surface at the same z (the limbus is
 *  the transition band between the 11.5 mm cornea and the sclera, so its
 *  inner face must follow the cornea edge — pinning it to
 *  sclOutFull − 1.17 mm left a 0.3-1.2 mm crack at the corneoscleral
 *  junction). Fixes the limbus floating inside the sclera AND the crack. */
function attachLimbusToSclera(limbusMesh, sclOutFull, corneaMesh) {
  if (!limbusMesh) return;
  // sample the cornea's OUTER surface per-z max-r (anterior normal.z > 0.2)
  const ZB = 80;
  const cpos = corneaMesh.geometry.getAttribute("position");
  let cnor = corneaMesh.geometry.getAttribute("normal");
  if (!cnor) { corneaMesh.geometry.computeVertexNormals(); cnor = corneaMesh.geometry.getAttribute("normal"); }
  let czmin = 1e9;
  let czmax = -1e9;
  for (let i = 0; i < cpos.count; i += 1) {
    const z = cpos.getZ(i);
    czmin = Math.min(czmin, z);
    czmax = Math.max(czmax, z);
  }
  const cOut = new Array(ZB).fill(0);
  for (let i = 0; i < cpos.count; i += 1) {
    if (cnor.getZ(i) <= 0.2) continue;
    const z = cpos.getZ(i);
    const r = Math.hypot(cpos.getX(i), cpos.getY(i));
    const b = Math.min(ZB - 1, Math.max(0, Math.floor(((z - czmin) / (czmax - czmin + 1e-6)) * ZB)));
    if (r > cOut[b]) cOut[b] = r;
  }
  for (let b = 0; b < ZB; b += 1) {
    if (cOut[b] > 1e-4) continue;
    for (let j = 1; j < ZB; j += 1) {
      if (b - j >= 0 && cOut[b - j] > 1e-4) { cOut[b] = cOut[b - j]; break; }
      if (b + j < ZB && cOut[b + j] > 1e-4) { cOut[b] = cOut[b + j]; break; }
    }
  }
  const cOutAt = (z) => {
    const f = ((z - czmin) / (czmax - czmin + 1e-6)) * ZB;
    const i = Math.min(ZB - 1, Math.max(0, Math.floor(f)));
    const i2 = Math.min(ZB - 1, i + 1);
    const t = f - i;
    return cOut[i] * (1 - t) + cOut[i2] * t;
  };
  const pos = limbusMesh.geometry.getAttribute("position");
  let nor = limbusMesh.geometry.getAttribute("normal");
  if (!nor) { limbusMesh.geometry.computeVertexNormals(); nor = limbusMesh.geometry.getAttribute("normal"); }
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    const dot = (nor.getX(i) * x + nor.getY(i) * y) / r;
    // outer: sclera outer surface; inner: cornea outer surface (transition band)
    const target = dot >= -0.05 ? sclOutFull(z) : Math.max(cOutAt(z), 0.3);
    const c = r > 1e-6 ? target / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

/** Phase 7b: close the posterior of choroid/retina onto the sclera INNER
 *  surface (surface projection, not a flat cut). The raw HRA mesh has a tube
 *  poking back through the optic-nerve region (z about -11.6); the old
 *  version flattened everything behind zClip onto one plane, which reads as
 *  a sliced-off flat cap. Now each vertex keeps its angle and slides along
 *  the sclera inner surface (binary search on the per-z inner radius), so
 *  the posterior becomes a smooth bowl matching the sclera closed cap. */
function trimPosteriorTube(mesh, scleraInner, zClip) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute('position');
  const zLo = -2.0; // inner-profile lower bound
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (z >= zClip) continue;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const rClip = scleraInner(zClip);
    let zNew = zClip;
    if (r > rClip) {
      // slide toward -Z until the inner surface radius matches this vertex
      let lo = zLo;
      let hi = zClip;
      for (let it = 0; it < 24; it += 1) {
        const mid = (lo + hi) / 2;
        if (scleraInner(mid) >= r) hi = mid;
        else lo = mid;
      }
      zNew = (lo + hi) / 2;
    }
    const rs = scleraInner(zNew);
    const c = rs > 1e-4 ? rs / r : 1;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
    pos.setZ(i, zNew);
  }
  pos.needsUpdate = true;
}

function attachRingToScleraInner(mesh, sclInFull, offset, zMinNew, zMaxNew) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  let zmin = 1e9;
  let zmax = -1e9;
  const radii = [];
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (r < 0.3) continue;
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
    radii.push(r);
  }
  if (radii.length === 0) return;
  radii.sort((a, b) => a - b);
  const rMed = radii[Math.floor(radii.length / 2)];
  const spanCur = Math.max(1e-4, zmax - zmin);
  const spanNew = zMaxNew - zMinNew;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    const f = (z - zmin) / spanCur; // 0 at posterior, 1 at anterior
    const zNew = zMinNew + f * spanNew;
    const rNew = sclInFull(zNew) + offset + (r - rMed);
    const c = r > 1e-6 ? rNew / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
    pos.setZ(i, zNew);
  }
  pos.needsUpdate = true;
}

/** Phase 6b: attach the iris ROOT to the ciliary body's inner face. The iris
 *  disc (rmax 5.61mm at z 7.62) ends 0.1-0.3mm short of the ciliary body's
 *  inner edge (5.73mm), which reads as a crack around the iris in
 *  cross-sections. Outer iris vertices (z < 8.0mm) are pushed radially onto
 *  the ciliary body's inner surface. */
function attachIrisRootToCiliary(irisMesh, ciliaryMesh) {
  if (!irisMesh || !ciliaryMesh) return;
  const ZB = 40;
  const cpos = ciliaryMesh.geometry.getAttribute("position");
  let czmin = 1e9;
  let czmax = -1e9;
  for (let i = 0; i < cpos.count; i += 1) {
    const z = cpos.getZ(i);
    czmin = Math.min(czmin, z);
    czmax = Math.max(czmax, z);
  }
  const cInR = new Array(ZB).fill(1e9);
  for (let i = 0; i < cpos.count; i += 1) {
    const z = cpos.getZ(i);
    const r = Math.hypot(cpos.getX(i), cpos.getY(i));
    if (r < 0.3) continue;
    const b = Math.min(ZB - 1, Math.max(0, Math.floor(((z - czmin) / (czmax - czmin + 1e-6)) * ZB)));
    if (r < cInR[b]) cInR[b] = r;
  }
  for (let b = 0; b < ZB; b += 1) {
    if (cInR[b] < 1e8) continue;
    for (let j = 1; j < ZB; j += 1) {
      if (b - j >= 0 && cInR[b - j] < 1e8) { cInR[b] = cInR[b - j]; break; }
      if (b + j < ZB && cInR[b + j] < 1e8) { cInR[b] = cInR[b + j]; break; }
    }
  }
  const cInRAt = (z) => {
    const f = ((z - czmin) / (czmax - czmin + 1e-6)) * ZB;
    const i = Math.min(ZB - 1, Math.max(0, Math.floor(f)));
    const i2 = Math.min(ZB - 1, i + 1);
    const t = f - i;
    return cInR[i] * (1 - t) + cInR[i2] * t;
  };
  const pos = irisMesh.geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3 || z > 1.21) continue; // only the root band (z < 8.0mm)
    const target = cInRAt(z) - 0.01; // kiss the ciliary inner face
    if (r < target) {
      const c = target / r;
      pos.setX(i, x * c);
      pos.setY(i, y * c);
    }
  }
  pos.needsUpdate = true;
}

/** Phase 8: push the vitreous humour's anterior surface back onto the lens's
 *  posterior surface (the vitreous normally has a fossa patellaris cupping
 *  the lens). Sampled per-r (min-z of the lens = its posterior face); only
 *  vertices that cross into the lens are moved, with a small gap to avoid
 *  z-fighting. */
function attachVitreousToLens(vitreousMesh, lensMesh) {
  if (!vitreousMesh || !lensMesh) return;
  const RB = 32;
  const lpos = lensMesh.geometry.getAttribute("position");
  let lrmax = 0;
  for (let i = 0; i < lpos.count; i += 1) {
    const r = Math.hypot(lpos.getX(i), lpos.getY(i));
    if (r > lrmax) lrmax = r;
  }
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
  const pos = vitreousMesh.geometry.getAttribute("position");
  const GAP = 0.005;
  for (let i = 0; i < pos.count; i += 1) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (r > lrmax) continue;
    const bz = backAt(r);
    if (pos.getZ(i) > bz - GAP) pos.setZ(i, bz - GAP);
  }
  pos.needsUpdate = true;
}

async function runBake(gltf) {
  const LoopSubdivision = (await import("three-subdivide")).LoopSubdivision;
  const t0 = Date.now();
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  console.log(`loaded ${meshes.length} meshes (${Date.now() - t0}ms)`);

  let totalSub = 0;
  // =====================================================================
  // 方案 A: 从 HRA 源头重新渲染。核心原则:
  //   - HRA 是基座: 所有 23 个结构拓扑/形态保留, 只做坐标变换
  //   - thinSclera 最先执行, 之后所有贴附操作使用"变薄后"的 sclera profile
  //   - 每个结构只在其原始位置做最小坐标变换, 不互相补偿
  // =====================================================================

  const scleraMesh = meshes.find((m) => m.name === "VH_M_sclera_L");

  // ---- P-0.5: 巩膜前部外表面外扩到球面参考(角膜-缘-巩膜连续斜接) ----
  widenAnteriorSclera(scleraMesh);

  // ---- P0: sclera 外表面 profile(外表面永不变薄) ----
  const sclOutFull = buildFullOuterProfile(scleraMesh, -2.0, 1.6, 100);
  console.log("P0: sclera outer profile built");

  // ---- P1: 先变薄 sclera 到 1.17mm(外表面不动) ----
  thinSclera(scleraMesh, () => 0.176);
  console.log("P1: sclera thinned to 1.17mm");

  // ---- P2: 变薄后的 sclera 内表面 profile(全 z 范围) ----
  const sclInFull = buildFullInnerProfile(scleraMesh, -2.0, 1.6, 100);
  console.log("P2: sclera inner profile built (post-thin)");

  // ---- P3: 角膜 — 直径 13.5→11.5mm + 法向厚度重建 + aqueous flush ----
  const corneaMesh = meshes.find((m) => m.name === "VH_M_cornea_L");
  scaleCorneaDiameter(corneaMesh, 11.5);
  reprofileCornea(corneaMesh, 0.075, 0.176); // 中心 0.5mm → 边缘 1.17mm, 法向
  expandCorneaEdge(corneaMesh); // 边缘外扩贴角膜缘内缘(消除环形缝隙)
  const aqueousMesh = meshes.find((m) => m.name === "VH_M_aqueous_humor_L");
  flushAqueousToCornea(aqueousMesh, corneaMesh);
  console.log("P3: cornea diameter 11.5mm + normal-thickness rebuild + aqueous flush");

  // ---- P4: limbus 内表面贴角膜外表面(消除角巩膜缘裂口), 外表面贴 sclera ----
  const limbusMesh = meshes.find((m) => m.name === "VH_M_corneo_scleral_junction_L");
  attachLimbusToSclera(limbusMesh, sclOutFull, corneaMesh);
  console.log("P4: limbus attached (outer=sclera, inner=cornea edge)");

  // ---- P5: SC/TM 按变薄后 sclera 内表面定位(保留环带形态, 非正圆) ----
  // 解剖: SC 位于角巩膜缘巩膜组织内(~0.33mm), TM 在前房角侧
  const scMesh = meshes.find((m) => m.name === "VH_M_schlemms_canal_L");
  const tmMesh = meshes.find((m) => m.name === "VH_M_trabecular_meshwork_L");
  attachRingToScleraInner(scMesh, sclInFull, 0.05, 1.24, 1.40);  // SC: 进巩膜 0.05u
  attachRingToScleraInner(tmMesh, sclInFull, -0.03, 1.22, 1.40);  // TM: 前房角侧
  console.log("P5: SC/TM attached to sclera inner (SC outer-in-sclera, TM anterior-chamber)");

  // ---- P6: 睫状体/睫状肌/睫状突 — 拉伸 + 重塑, 用变薄后 profile; 睫状突保留原始 ----
  const cbMesh = meshes.find((m) => m.name === "VH_M_ciliary_body_L");
  const muscleMesh = meshes.find((m) => m.name === "VH_M_ciliary_muscle_L");
  const procMesh = meshes.find((m) => m.name === "VH_M_ciliary_processes_L");
  stretchRingAlongZ(cbMesh, 0.895, 1.207, 0.375, 1.207, sclInFull);
  stretchRingAlongZ(muscleMesh, 0.935, 1.225, 0.375, 1.225, sclInFull);
  stretchRingAlongZ(procMesh, 0.953, 1.157, 0.925, 1.225, sclInFull); // 保留原始 76608 顶点
  const tBody = (z) => {
    if (z >= 0.908) return 0.12 + (0.07 * (z - 0.908)) / 0.3;
    if (z >= 0.375) return 0.12 * Math.pow((z - 0.375) / 0.533, 1.6); // 后段幂收尖: z=0.42 处 0.067->0.018mm
    return 0;
  };
  reprofileCiliary(cbMesh, tBody, sclInFull);
  reprofileMuscle(muscleMesh, sclInFull);
  // P6.5: 睫状体后缘对齐到脉络膜前缘(0.42) - 消除颞侧 ~1mm 环形缺口
  alignRingPosterior(cbMesh, 0.42, sclInFull);
  const irisMesh = meshes.find((m) => m.name === "VH_M_iris_L");
  attachIrisRootToCiliary(irisMesh, cbMesh);
  console.log("P6: ciliary body/muscle stretched + re-profiled; processes kept original; iris root attached");

  // ---- P7: choroid/retina 前缘回缩到 ora serrata(z~0.4), 再薄化贴变薄后 sclera 内表面 ----
  const choroidMesh = meshes.find((m) => m.name === "VH_M_optic_choroid_L");
  const retinaMesh = meshes.find((m) => m.name === "VH_M_retina_L");
  const vitreousMesh = meshes.find((m) => m.name === "VH_M_vitreous_humor_L");
  retractAnteriorZ(choroidMesh, 0.375, 0.42, sclInFull); // HRA 前缘伸到 z 1.11u, 必须收回
  retractAnteriorZ(retinaMesh, 0.375, 0.42, sclInFull);
  trimPosteriorTube(choroidMesh, sclInFull, -1.84); // 后极曲面贴 sclera 内表面(旧版压平像被削平)
  trimPosteriorTube(retinaMesh, sclInFull, -1.84);
  attachShellToInner(choroidMesh, sclInFull, 0.0451); // 0.3mm
  attachShellToInner(retinaMesh, (z) => sclInFull(z) - 0.0451, 0.0301); // 0.2mm, 贴 choroid 内
  // P7.5: 后极中心区沿 sclera 内表面小帽延伸(消除 slice 平墙)
  extendPosteriorToInner(choroidMesh, -1.60);
  extendPosteriorToInner(retinaMesh, -1.60);
  extendPosteriorToInner(vitreousMesh, -1.40, { linearEdge: true });
  // P7.6: 后极三结构归位 - disc 移到鼻侧(真实左眼), fovea/macula 下移贴延伸后的内表面
  const discMesh = meshes.find((m) => m.name === "VH_M_optic_disc_L");
  const foveaMesh = meshes.find((m) => m.name === "VH_M_fovea_L");
  const maculaMesh = meshes.find((m) => m.name === "VH_M_macula_lutea_L");
  translateMesh(discMesh, 1.014, 0.119, -0.125);   // 颞侧 -> 鼻侧 +3.2mm 偏上 0.8mm, 贴内表面
  translateMesh(foveaMesh, 0.0, 0.0, -0.258);       // 下移贴中心帽内表面(z -1.89)
  translateMesh(maculaMesh, 0.025, 0.032, -0.260);  // 跟随 fovea, 贴内表面
  console.log("P7: choroid/retina anterior retracted to ora serrata + attached (0.3/0.2mm)");

  // ---- P8: vitreous 前表面贴 lens 后表面(fossa patellaris) ----
  const lensMesh = meshes.find((m) => m.name === "VH_M_lens_L");
  attachVitreousToLens(vitreousMesh, lensMesh);
  console.log("P8: vitreous front pushed onto lens posterior");

  // ---- P9: ora serrata 归位到睫状体后缘 ----
  const oraMesh = meshes.find((m) => m.name === "VH_M_ora_serrata_of_retina_L");
  stretchRingAlongZ(oraMesh, 0.904, 1.035, 0.36, 0.42, sclInFull);
  console.log("P9: ora serrata repositioned");

  // ---- P10: UV + subdivision + 导出 ----
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

  return { meshes, totalSub };
}

/** Exports the baked scene to a binary GLB buffer (GLTFExporter). */
async function exportBaked(gltf) {
  return new Promise((res, rej) =>
    new GLTFExporter().parse(gltf.scene, res, rej, { binary: true, onlyVisible: false }),
  );
}

async function main() {
  const gltf = await loadGlb(path.join(ROOT, INPUT));
  await runBake(gltf);
  const exported = await exportBaked(gltf);
  const out = path.join(ROOT, OUTPUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(exported));
  const mb = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`written ${OUTPUT} (${mb} MB)`);
}

// CLI entry (node scripts/bake-eye.cjs [input.glb] [output.glb]); when required
// as a module (tests/bake-geometry.test.mjs) only the exports are used.
if (require.main === module) {
  main().catch((e) => { console.error("BAKE_FAIL:", e.message); process.exit(1); });
}

module.exports = {
  ROOT, INPUT, OUTPUT, MM_PER_UNIT,
  PART_FROM_MESH, UV_KIND,
  loadGlb, runBake, exportBaked, generatePartUVs,
  stretchRingAlongZ, retractAnteriorZ, reprofileCiliary, reprofileMuscle,
  reprofileCornea, thinSclera, scaleCorneaDiameter, buildFullOuterProfile,
  buildFullInnerProfile, attachShellToInner, flushAqueousToCornea,
  attachLimbusToSclera, trimPosteriorTube, attachRingToScleraInner,
  attachIrisRootToCiliary, attachVitreousToLens,
};
