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

/** Per-angle radial remap (Plan v6): for each vertex of `mesh`, scale its XY
 *  radius so the ring's OUTER edge lands `gap` inside the reference ring's
 *  outer (or inner) edge at the SAME angle. Uniform `relocateRing` cannot fix
 *  the SC/TM gap because both rings are elliptical (nasal +X large, temporal
 *  -X small) — per-angle remap keeps each ring's elliptical shape while making
 *  SC sit inside the ciliary body and TM kiss SC's inner wall everywhere. */
function remapRingToReference(mesh, refMesh, refSide, gap, dz = 0) {
  if (!mesh || !refMesh) return;
  const BINS = 128;
  const refPos = refMesh.geometry.getAttribute("position");
  const refEdge = new Array(BINS).fill(refSide === "inner" ? Infinity : 0);
  for (let i = 0; i < refPos.count; i += 1) {
    const x = refPos.getX(i);
    const y = refPos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const bin = Math.min(BINS - 1, Math.floor(a / (Math.PI * 2) * BINS));
    if (refSide === "inner" ? r < refEdge[bin] : r > refEdge[bin]) refEdge[bin] = r;
  }
  for (let i = 0; i < BINS; i += 1) {
    if (refSide === "inner" ? refEdge[i] === Infinity : refEdge[i] === 0) {
      let j = 1;
      while (j < BINS) {
        const k = (i + j) % BINS;
        if (refSide === "inner" ? refEdge[k] !== Infinity : refEdge[k] !== 0) {
          refEdge[i] = refEdge[k];
          break;
        }
        j += 1;
      }
    }
  }
  const pos = mesh.geometry.getAttribute("position");
  const meshOuter = new Array(BINS).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const bin = Math.min(BINS - 1, Math.floor(a / (Math.PI * 2) * BINS));
    if (r > meshOuter[bin]) meshOuter[bin] = r;
  }
  // Linear interpolation between adjacent bins — bin-quantising both rings
  // independently leaves up to half a bin of angular mismatch (the TM kiss
  // came out 0.001-0.036 overlapped); interpolating cancels that error.
  const edgeAt = (arr, a) => {
    const f = (a / (Math.PI * 2)) * BINS;
    const i = Math.floor(f) % BINS;
    const t = f - Math.floor(f);
    return arr[i] * (1 - t) + arr[(i + 1) % BINS] * t;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const z = pos.getZ(i) + dz;
    let scale = 1;
    if (r >= 0.3) {
      let a = Math.atan2(y, x);
      if (a < 0) a += Math.PI * 2;
      const outer = edgeAt(meshOuter, a);
      if (outer > 0.3) {
        scale = Math.max(0.2, (edgeAt(refEdge, a) - gap) / outer);
      }
    }
    pos.setX(i, x * scale);
    pos.setY(i, y * scale);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
}

/** Narrow a ring's band: keeps each vertex's angle and the ring's OUTER edge
 *  fixed, and pulls the inner edge outward so the band shrinks to
 *  `factor × current width`. Used to make the TM read as a thin filter strip
 *  (physiology) after it has been remapped to kiss SC's inner wall. */
function narrowRingBand(mesh, factor) {
  if (!mesh) return;
  const BINS = 128;
  const pos = mesh.geometry.getAttribute("position");
  const inner = new Array(BINS).fill(1e9);
  const outer = new Array(BINS).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const b = Math.min(BINS - 1, Math.floor(a / (Math.PI * 2) * BINS));
    if (r < inner[b]) inner[b] = r;
    if (r > outer[b]) outer[b] = r;
  }
  const edgeAt = (arr, a) => {
    const f = (a / (Math.PI * 2)) * BINS;
    const i = Math.floor(f) % BINS;
    const t = f - Math.floor(f);
    return arr[i] * (1 - t) + arr[(i + 1) % BINS] * t;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const o = edgeAt(outer, a);
    const inn = edgeAt(inner, a);
    const band = o - inn;
    if (band < 1e-4) continue;
    // t = 1 at the inner edge, 0 at the outer edge; outer stays put.
    const t = Math.min(1, Math.max(0, (o - r) / band));
    const newR = o - t * band * factor;
    pos.setX(i, (x / r) * newR);
    pos.setY(i, (y / r) * newR);
  }
  pos.needsUpdate = true;
}

/** Map a ring's INNER edge onto a reference edge: the mesh's inner wall lands
 *  `gap` inside the reference ring's edge at the same angle, and the ring's
 *  band is compressed to `targetBand` (t: 0 at inner edge → refEdge − gap,
 *  t: 1 at outer edge → refEdge − gap + targetBand). Keeps the elliptical
 *  shape; the outer edge never gets to choose its radius, so a small
 *  targetBand guarantees the whole ring stays inside the reference. Used for
 *  TM: inner wall kisses SC's outer wall, TM tube is a thin strip. */
function remapRingInnerToReference(mesh, refMesh, refSide, gap, targetBand, dz = 0) {
  if (!mesh || !refMesh) return;
  const BINS = 128;
  const refPos = refMesh.geometry.getAttribute("position");
  const refEdge = new Array(BINS).fill(refSide === "inner" ? Infinity : 0);
  for (let i = 0; i < refPos.count; i += 1) {
    const x = refPos.getX(i);
    const y = refPos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const bin = Math.min(BINS - 1, Math.floor(a / (Math.PI * 2) * BINS));
    if (refSide === "inner" ? r < refEdge[bin] : r > refEdge[bin]) refEdge[bin] = r;
  }
  for (let i = 0; i < BINS; i += 1) {
    if (refSide === "inner" ? refEdge[i] === Infinity : refEdge[i] === 0) {
      let j = 1;
      while (j < BINS) {
        const k = (i + j) % BINS;
        if (refSide === "inner" ? refEdge[k] !== Infinity : refEdge[k] !== 0) {
          refEdge[i] = refEdge[k];
          break;
        }
        j += 1;
      }
    }
  }
  const pos = mesh.geometry.getAttribute("position");
  const meshInner = new Array(BINS).fill(1e9);
  const meshOuter = new Array(BINS).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const bin = Math.min(BINS - 1, Math.floor(a / (Math.PI * 2) * BINS));
    if (r < meshInner[bin]) meshInner[bin] = r;
    if (r > meshOuter[bin]) meshOuter[bin] = r;
  }
  const edgeAt = (arr, a) => {
    const f = (a / (Math.PI * 2)) * BINS;
    const i = Math.floor(f) % BINS;
    const t = f - Math.floor(f);
    return arr[i] * (1 - t) + arr[(i + 1) % BINS] * t;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const z = pos.getZ(i) + dz;
    let newR = r;
    if (r >= 0.3) {
      let a = Math.atan2(y, x);
      if (a < 0) a += Math.PI * 2;
      const inn = edgeAt(meshInner, a);
      const out = edgeAt(meshOuter, a);
      const band = out - inn;
      if (band > 1e-4) {
        const t = Math.min(1, Math.max(0, (r - inn) / band));
        newR = edgeAt(refEdge, a) - gap + t * targetBand;
      }
    }
    const scale = r > 1e-6 ? newR / r : 1;
    pos.setX(i, x * scale);
    pos.setY(i, y * scale);
    pos.setZ(i, z);
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

/** Build an interpolator r_inner(z) from the sclera's inner surface
 *  (min radius per z-slice, averaged over angle). Used as the radial target
 *  curve when stretching the ciliary body along the eye axis. */
function buildScleraInnerProfile(scleraMesh, z0, z1, zbins) {
  const pos = scleraMesh.geometry.getAttribute("position");
  const inner = new Array(zbins).fill(1e9);
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    const f = (z - z0) / (z1 - z0);
    if (f < 0 || f >= 1) continue;
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    const b = Math.floor(f * zbins);
    if (r < inner[b]) inner[b] = r;
  }
  // nearest-neighbor fill for empty bins
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

/** Phase 3a: thicken the cornea centre (inner surface only) to ~0.5 mm. The
 *  outer (anterior) surface stays fixed; the posterior surface is pushed back
 *  near the axis, tapering to zero at `taperRadius`. */
function thickenCorneaCenter(mesh, targetThickness, taperRadius) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  let apexZ = -1e9;
  for (let i = 0; i < pos.count; i += 1) apexZ = Math.max(apexZ, pos.getZ(i));
  let innerCenterZ = 1e9;
  for (let i = 0; i < pos.count; i += 1) {
    if (Math.hypot(pos.getX(i), pos.getY(i)) < 0.1) innerCenterZ = Math.min(innerCenterZ, pos.getZ(i));
  }
  const curThick = apexZ - innerCenterZ;
  const delta = targetThickness - curThick;
  if (delta <= 0) return;
  const innerThreshold = apexZ - curThick * 0.5;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (z >= innerThreshold) continue; // outer surface
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    const taper = Math.max(0, 1 - r / taperRadius);
    if (taper <= 0) continue;
    pos.setZ(i, z - delta * taper);
  }
  pos.needsUpdate = true;
}

/** Phase 4: re-profile a ciliary ring's cross-section. Keeps the outer edge on
 *  the sclera inner surface and remaps the inner edge so the radial band equals
 *  `thicknessFn(z)` (triangle: thick anterior -> 0 posterior). */
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
  // per-z radial band (max depth from the sclera inner surface), angle-averaged.
  const band = new Array(ZB).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    const d = scleraInner(z) - r;
    if (d < 0) continue;
    const zb = Math.min(ZB - 1, Math.max(0, Math.floor(((z - zmin) / (zmax - zmin)) * ZB)));
    if (d > band[zb]) band[zb] = d;
  }
  const bandAt = (z) => {
    const f = ((z - zmin) / (zmax - zmin)) * ZB;
    const i = Math.min(ZB - 1, Math.max(0, Math.floor(f)));
    const i2 = Math.min(ZB - 1, i + 1);
    const t = f - i;
    return band[i] * (1 - t) + band[i2] * t;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    const rOuter = scleraInner(z);
    const d = Math.max(0, rOuter - r);
    const b = bandAt(z);
    const f = b > 1e-4 ? Math.min(1, d / b) : 0;
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

/** Phase 4: rebuild the ciliary processes as `ridgeCount` discrete radial
 *  ridges on the anterior inner face of the ciliary body (pars plicata). Each
 *  ridge is a thin triangular prism projecting inward by `H`. */
function buildCiliaryProcessesRidges(scleraInner, tBody, ridgeCount) {
  const z0 = 0.908; // pars plicata posterior edge
  const z1 = 1.208; // anterior edge
  const H = 0.12;   // ridge height (0.8 mm)
  const w = 0.04;   // ridge half-width (radians) ~0.5mm arc at r~0.9
  const positions = [];
  const tri = (a, b, c) => { positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  const vert = (theta, z, rInset) => {
    const r = scleraInner(z) - tBody(z) - rInset; // rInset 0=outer(attached), H=inner tip
    return [Math.cos(theta) * r, Math.sin(theta) * r, z];
  };
  for (let i = 0; i < ridgeCount; i += 1) {
    const th = (i / ridgeCount) * Math.PI * 2;
    const fO1 = vert(th - w, z1, 0);
    const fO2 = vert(th + w, z1, 0);
    const fI = vert(th, z1, H);
    const bO1 = vert(th - w, z0, 0);
    const bO2 = vert(th + w, z0, 0);
    const bI = vert(th, z0, H);
    tri(fO1, fO2, fI); // front
    tri(bO1, bI, bO2); // back
    tri(fO1, fI, bO1); tri(bO1, fI, bI); // inner side
    tri(fO2, bO2, fI); tri(fI, bO2, bI); // inner side 2
    tri(fO1, bO1, fO2); tri(bO1, bO2, fO2); // outer side
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo);
  mesh.name = "VH_M_ciliary_processes_L";
  mesh.frustumCulled = false;
  return mesh;
}

/** Phase 3b: re-profile the cornea to a UNIFORM thickness and make its inner
 *  (posterior) surface meet the aqueous humor (anterior chamber front). The
 *  outer (anterior) surface stays fixed; the inner surface is set to
 *  `front - thickness` and the aqueous front surface is pulled to the same
 *  curve so the two are flush. */
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
  // per-(r, angle) anterior-surface z. The cornea is ELLIPTICAL (nasal side
  // sits higher than the temporal side), so a single per-r max ignored the
  // asymmetry and collapsed the posterior surface onto the anterior one on
  // the temporal side (the "touching" bug).
  const front = new Array(RB * AB).fill(-1e9);
  for (let i = 0; i < pos.count; i += 1) {
    if (nor.getZ(i) <= 0.2) continue;
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    const rb = Math.min(RB - 1, Math.floor((r / (rmax + 1e-6)) * RB));
    let a = Math.atan2(pos.getY(i), pos.getX(i));
    if (a < 0) a += Math.PI * 2;
    const ab = Math.min(AB - 1, Math.floor((a / (Math.PI * 2)) * AB));
    const idx = rb * AB + ab;
    if (pos.getZ(i) > front[idx]) front[idx] = pos.getZ(i);
  }
  // fill empty bins along the angle (nearest-neighbour) for smooth sampling
  for (let rb = 0; rb < RB; rb += 1) {
    for (let ab = 0; ab < AB; ab += 1) {
      if (front[rb * AB + ab] > -1e8) continue;
      for (let d = 1; d < AB; d += 1) {
        const l = (ab - d + AB) % AB;
        const rr = (ab + d) % AB;
        if (front[rb * AB + l] > -1e8) { front[rb * AB + ab] = front[rb * AB + l]; break; }
        if (front[rb * AB + rr] > -1e8) { front[rb * AB + ab] = front[rb * AB + rr]; break; }
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
  const thicknessAt = (r) => thicknessCenter + (thicknessEdge - thicknessCenter) * Math.min(1, r / rmax);
  // Only the TRUE posterior surface (normal.z < -0.2). Each vertex follows the
  // anterior surface AT ITS OWN ANGLE, so thickness stays uniform everywhere.
  for (let i = 0; i < pos.count; i += 1) {
    if (nor.getZ(i) >= -0.2) continue;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    pos.setZ(i, frontAt(r, a) - thicknessAt(r));
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

/** Phase 6: set a ring band's RADIAL thickness to a fixed value, keeping the
 *  outer edge fixed and moving the inner edge to `outer - targetBand`. Used to
 *  match the limbus (corneoscleral junction) shell thickness to the cornea and
 *  sclera (all 1.17 mm). */
function reprofileRingBand(mesh, targetBand) {
  if (!mesh) return;
  const AB = 64;
  const pos = mesh.geometry.getAttribute("position");
  const inner = new Array(AB).fill(1e9);
  const outer = new Array(AB).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const ab = Math.min(AB - 1, Math.floor((a / (Math.PI * 2)) * AB));
    if (r < inner[ab]) inner[ab] = r;
    if (r > outer[ab]) outer[ab] = r;
  }
  const edgeAt = (arr, a) => {
    const f = (a / (Math.PI * 2)) * AB;
    const i = Math.min(AB - 1, Math.max(0, Math.floor(f)));
    const i2 = (i + 1) % AB;
    const t = f - i;
    return arr[i] * (1 - t) + arr[i2] * t;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const o = edgeAt(outer, a);
    const inn = edgeAt(inner, a);
    const band = o - inn;
    const f = band > 1e-4 ? Math.min(1, Math.max(0, (o - r) / band)) : 0;
    const rNew = o - f * targetBand;
    const c = r > 1e-6 ? rNew / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

/** Phase 7: shift an inner shell (choroid / retina) radially outward by a
 *  fixed amount so it re-attaches to the (thinned) sclera inner surface. */
function shiftShellOutward(mesh, shift) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    const c = (r + shift) / r;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

(async () => {
  const LoopSubdivision = (await import("three-subdivide")).LoopSubdivision;
  const t0 = Date.now();
  const gltf = await loadGlb(path.join(ROOT, INPUT));
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  console.log(`loaded ${meshes.length} meshes (${Date.now() - t0}ms)`);

  let totalSub = 0;
  // Phase 1: SC/TM belong at the iridocorneal angle (scleral sulcus / limbus),
  // NOT inside the ciliary body ring; radial order must be TM INNER
  // (anterior-chamber side) -> SC OUTER (scleral side). Original source had
  // both floating centrally (SC r 0.68-0.87, TM r 0.66-0.89) with TM outside
  // SC. relocateRing scales XY + shifts Z; narrowRingBand thins each ring to
  // read as canal/meshwork while keeping the outer edge fixed.
  const scMesh = meshes.find((m) => m.name === "VH_M_schlemms_canal_L");
  const tmMesh = meshes.find((m) => m.name === "VH_M_trabecular_meshwork_L");
  relocateRing(scMesh, 1.20, 0.10);   // SC -> r ~0.98-1.04, z ~1.29-1.36 (sulcus floor)
  narrowRingBand(scMesh, 0.25);
  relocateRing(tmMesh, 1.05, 0.12);   // TM -> r ~0.87-0.93, z ~1.28-1.38 (just inside SC)
  narrowRingBand(tmMesh, 0.25);
  console.log("relocated SC/TM to scleral sulcus (TM inner, SC outer)");

  // Phase 2 — stretch the ciliary body to anatomical length (~5.6 mm) and keep
  // it hugging the sclera. Anterior end (scleral spur, z 1.225) stays put;
  // posterior end (ora serrata) extends from z 0.895 back to z 0.375. The
  // ciliary processes stay in the anterior ~2 mm (pars plicata) so they keep
  // facing the lens equator.
  const scleraMesh = meshes.find((m) => m.name === "VH_M_sclera_L");
  const cbMesh = meshes.find((m) => m.name === "VH_M_ciliary_body_L");
  const muscleMesh = meshes.find((m) => m.name === "VH_M_ciliary_muscle_L");
  const procMesh = meshes.find((m) => m.name === "VH_M_ciliary_processes_L");
  const scleraInner = buildScleraInnerProfile(scleraMesh, 0.2, 1.35, 64);
  stretchRingAlongZ(cbMesh, 0.895, 1.207, 0.375, 1.207, scleraInner);
  stretchRingAlongZ(muscleMesh, 0.935, 1.225, 0.375, 1.225, scleraInner);
  stretchRingAlongZ(procMesh, 0.953, 1.157, 0.925, 1.225, scleraInner);
  console.log("stretched ciliary body/muscle/processes to ~5.6mm meridional length");

  // Phase 2b — retract ora serrata + choroid/retina anterior edges to the
  // ciliary body's new posterior boundary (z ~0.375) so layers don't overlap.
  const oraMesh = meshes.find((m) => m.name === "VH_M_ora_serrata_of_retina_L");
  const choroidMesh = meshes.find((m) => m.name === "VH_M_optic_choroid_L");
  const retinaMesh = meshes.find((m) => m.name === "VH_M_retina_L");
  stretchRingAlongZ(oraMesh, 0.904, 1.035, 0.36, 0.42, scleraInner);
  retractAnteriorZ(choroidMesh, 0.375, 0.42, scleraInner);
  retractAnteriorZ(retinaMesh, 0.375, 0.42, scleraInner);
  console.log("retracted ora serrata + choroid/retina anterior to z ~0.4");

  // Phase 3a/3b — uniform cornea thickness (~0.5 mm) + inner surface flush
  // with the aqueous humor front (anterior chamber).
  const corneaMesh = meshes.find((m) => m.name === "VH_M_cornea_L");
  reprofileCornea(corneaMesh, 0.125, 0.175);
  console.log("re-profiled cornea thickness (0.83->1.17mm gradient, normal-based)");

  // Phase 4 — re-profile ciliary cross-sections to the anatomical triangle.
  // body: piecewise triangle (pars plana 0->0.8mm, pars plicata 0.8->1.25mm).
  // muscle: wedge (0.56mm anterior -> 0), shortened to ~4mm, outer portion only.
  // processes: rebuilt as 70 discrete radial ridges (0.8mm high) on the
  // anterior inner face of the body (pars plicata).
  const tBody = (z) => {
    if (z >= 0.908) return 0.12 + (0.07 * (z - 0.908)) / 0.3;
    if (z >= 0.375) return (0.12 * (z - 0.375)) / 0.533;
    return 0;
  };
  reprofileCiliary(cbMesh, tBody, scleraInner);
  reprofileMuscle(muscleMesh, scleraInner);
  const newProc = buildCiliaryProcessesRidges(scleraInner, tBody, 70);
  newProc.userData.baked = true;
  const procParent = procMesh.parent;
  procParent.remove(procMesh);
  procParent.add(newProc);
  const pi = meshes.indexOf(procMesh);
  if (pi >= 0) meshes[pi] = newProc;
  console.log("re-profiled ciliary body/muscle + rebuilt processes (70 ridges)");

  // Phase 5 — set the sclera to a uniform 1.17 mm shell (matching the cornea
  // edge), per user spec.
  const scleraThickness = () => 0.176;
  thinSclera(scleraMesh, scleraThickness);
  console.log("set sclera to uniform 1.17mm");

  // Phase 6 — set the limbus (corneoscleral junction) radial shell thickness
  // to 1.17 mm, matching the cornea edge and sclera.
  const limbusMesh = meshes.find((m) => m.name === "VH_M_corneo_scleral_junction_L");
  reprofileRingBand(limbusMesh, 0.176);
  console.log("set limbus radial thickness to 1.17mm");

  // Phase 7 — re-attach choroid/retina to the thinned sclera inner surface.
  const choroidMesh = meshes.find((m) => m.name === "VH_M_optic_choroid_L");
  const retinaMesh = meshes.find((m) => m.name === "VH_M_retina_L");
  shiftShellOutward(choroidMesh, 0.03);
  shiftShellOutward(retinaMesh, 0.10);
  console.log("shifted choroid/retina to re-attach to sclera");

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
