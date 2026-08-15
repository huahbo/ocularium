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

/** Phase 6: set a ring band's RADIAL thickness to a fixed value, keeping the
 *  outer edge fixed and moving the inner edge to `outer - targetBand`. Used to
 *  match the limbus (corneoscleral junction) shell thickness to the cornea and
 *  sclera (all 1.17 mm).
 *
 *  Per-(angle x z) granularity: the limbus is a SLOPED transition band (its
 *  radius changes along z as it tilts between cornea and sclera), so a
 *  per-angle-only outer/inner sample mixes the z-slope into the band and
 *  leaves some angles too thick (1.25-1.64 mm). We sample the outer surface
 *  per (angle, z) bin and move each inner vertex to outerAt(a, z) - target. */
function reprofileRingBand(mesh, targetBand) {
  if (!mesh) return;
  const AB = 64;
  const ZB = 32;
  const pos = mesh.geometry.getAttribute("position");
  let nor = mesh.geometry.getAttribute("normal");
  if (!nor) { mesh.geometry.computeVertexNormals(); nor = mesh.geometry.getAttribute("normal"); }
  let zmin = 1e9;
  let zmax = -1e9;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
  }
  const angleBin = (a) => {
    if (a < 0) a += Math.PI * 2;
    return Math.min(AB - 1, Math.floor((a / (Math.PI * 2)) * AB));
  };
  const zBin = (z) => Math.min(ZB - 1, Math.max(0, Math.floor(((z - zmin) / (zmax - zmin + 1e-6)) * ZB)));
  // sample the OUTER surface (radial normal points outward) per (a, z)
  const outer = new Array(AB * ZB).fill(0);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    const dot = (nor.getX(i) * x + nor.getY(i) * y) / r;
    if (dot < -0.05) continue; // inner surface only
    const idx = zBin(z) * AB + angleBin(Math.atan2(y, x));
    if (r > outer[idx]) outer[idx] = r;
  }
  // fill empty bins (nearest along angle, then along z)
  for (let zb = 0; zb < ZB; zb += 1) {
    for (let ab = 0; ab < AB; ab += 1) {
      if (outer[zb * AB + ab] > 1e-4) continue;
      let best = 0;
      for (let d = 1; d < AB && best === 0; d += 1) {
        const l = (ab - d + AB) % AB;
        const rr = (ab + d) % AB;
        if (outer[zb * AB + l] > 1e-4) best = outer[zb * AB + l];
        else if (outer[zb * AB + rr] > 1e-4) best = outer[zb * AB + rr];
      }
      if (best === 0) {
        for (let dz = 1; dz < ZB; dz += 1) {
          if (zb - dz >= 0 && outer[(zb - dz) * AB + ab] > 1e-4) { best = outer[(zb - dz) * AB + ab]; break; }
          if (zb + dz < ZB && outer[(zb + dz) * AB + ab] > 1e-4) { best = outer[(zb + dz) * AB + ab]; break; }
        }
      }
      if (best > 0) outer[zb * AB + ab] = best;
    }
  }
  const outerAt = (a, z) => {
    const af = (a / (Math.PI * 2)) * AB;
    const a0 = Math.floor(af) % AB;
    const a1 = (a0 + 1) % AB;
    const at = af - Math.floor(af);
    const zf = ((z - zmin) / (zmax - zmin + 1e-6)) * ZB;
    const z0 = Math.min(ZB - 1, Math.max(0, Math.floor(zf)));
    const z1 = Math.min(ZB - 1, z0 + 1);
    const zt = zf - Math.floor(zf);
    const v00 = outer[z0 * AB + a0];
    const v01 = outer[z0 * AB + a1];
    const v10 = outer[z1 * AB + a0];
    const v11 = outer[z1 * AB + a1];
    const v0 = v00 * (1 - at) + v01 * at;
    const v1 = v10 * (1 - at) + v11 * at;
    return v0 * (1 - zt) + v1 * zt;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) continue;
    const dot = (nor.getX(i) * x + nor.getY(i) * y) / r;
    if (dot >= -0.05) continue; // outer surface stays fixed
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const o = outerAt(a, z);
    const rNew = o - targetBand;
    if (rNew < 0.05) continue;
    const c = r > 1e-6 ? rNew / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
  }
  pos.needsUpdate = true;
}

/** Phase 3b: scale the cornea's XY extent so its diameter matches the
 *  anatomical value (~11.5 mm, down from the HRA 13.5 mm). Z is untouched.
 *  Call BEFORE reprofileCornea so the posterior rebuild uses the new edge
 *  radius. The aqueous humor (rmax 5.62 mm) stays fully covered by the
 *  cornea's new edge (5.75 mm). */
function scaleCorneaDiameter(corneaMesh, targetDiameterMm) {
  if (!corneaMesh) return;
  const MM_PER_UNIT = 1.17 / 0.176; // 6.6477
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
 *  z range. Unlike buildScleraInnerProfile (anterior zone only), this covers
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

/** Phase 7b: trim the posterior "tube" that HRA gives choroid/retina at the
 *  optic-nerve foramen. The raw mesh extends BACK through the sclera's hole
 *  to z≈−11.6 AND pokes out of the eyeball (choroid r 7.81mm at z=−10.9 vs
 *  sclera outer 6.68mm). Vertices behind `zClip` are flattened onto the
 *  zClip plane with r clamped inside the sclera outer surface, leaving a
 *  smooth lip around the foramen (the hole itself stays open — the optic
 *  disc covers it). */
function trimPosteriorTube(mesh, sclOutFull, zClip) {
  if (!mesh) return;
  const pos = mesh.geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (z >= zClip) continue;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 0.3) { pos.setZ(i, zClip); continue; } // tube tip: flatten, keep r
    const rMax = sclOutFull(zClip) - 0.05; // stay inside the sclera outer lip
    const rNew = Math.min(r, rMax);
    const c = r > 1e-6 ? rNew / r : 0;
    pos.setX(i, x * c);
    pos.setY(i, y * c);
    pos.setZ(i, zClip);
  }
  pos.needsUpdate = true;
}

/** Phase 5: attach a ring (SC/TM) to the sclera INNER surface by translating
 *  each vertex along z (keeping its relative z position inside the ring) and
 *  placing its radius at `sclInFull(z) + offset + (r − rMed)`, where rMed is
 *  the ring's current median radius. Preserves the ring's full (non-circular,
 *  elliptical) shape — each vertex keeps its radial offset from the median,
 *  only the median is re-anchored. SC sits INSIDE the sclera shell (offset
 *  +0.05u ≈ 0.33mm into the sclera, per anatomy), TM on the anterior-chamber
 *  side (offset −0.03u). */
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

(async () => {
  const LoopSubdivision = (await import("three-subdivide")).LoopSubdivision;
  const t0 = Date.now();
  const gltf = await loadGlb(path.join(ROOT, INPUT));
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

  // ---- P0: sclera 外表面 profile(外表面永不变薄) ----
  const scleraMesh = meshes.find((m) => m.name === "VH_M_sclera_L");
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
    if (z >= 0.375) return (0.12 * (z - 0.375)) / 0.533;
    return 0;
  };
  reprofileCiliary(cbMesh, tBody, sclInFull);
  reprofileMuscle(muscleMesh, sclInFull);
  const irisMesh = meshes.find((m) => m.name === "VH_M_iris_L");
  attachIrisRootToCiliary(irisMesh, cbMesh);
  console.log("P6: ciliary body/muscle stretched + re-profiled; processes kept original; iris root attached");

  // ---- P7: choroid/retina 前缘回缩到 ora serrata(z~0.4), 再薄化贴变薄后 sclera 内表面 ----
  const choroidMesh = meshes.find((m) => m.name === "VH_M_optic_choroid_L");
  const retinaMesh = meshes.find((m) => m.name === "VH_M_retina_L");
  retractAnteriorZ(choroidMesh, 0.375, 0.42, sclInFull); // HRA 前缘伸到 z 1.11u, 必须收回
  retractAnteriorZ(retinaMesh, 0.375, 0.42, sclInFull);
  trimPosteriorTube(choroidMesh, sclOutFull, -1.70); // 后极视神经孔管: 压平到孔口平面 (z=-11.3mm)
  trimPosteriorTube(retinaMesh, sclOutFull, -1.70);
  attachShellToInner(choroidMesh, sclInFull, 0.0451); // 0.3mm
  attachShellToInner(retinaMesh, (z) => sclInFull(z) - 0.0451, 0.0301); // 0.2mm, 贴 choroid 内
  console.log("P7: choroid/retina anterior retracted to ora serrata + attached (0.3/0.2mm)");

  // ---- P8: vitreous 前表面贴 lens 后表面(fossa patellaris) ----
  const vitreousMesh = meshes.find((m) => m.name === "VH_M_vitreous_humor_L");
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

  const exported = await new Promise((res, rej) =>
    new GLTFExporter().parse(gltf.scene, res, rej, { binary: true, onlyVisible: false }),
  );
  const out = path.join(ROOT, OUTPUT);
  fs.writeFileSync(out, Buffer.from(exported));
  const mb = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`written ${OUTPUT} (${mb} MB)`);
})().catch((e) => { console.error("BAKE_FAIL:", e.message); process.exit(1); });
