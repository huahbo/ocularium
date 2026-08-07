import * as THREE from "three";
import { LoopSubdivision } from "three-subdivide";

/**
 * Procedural anatomical materials for the HRA eye model.
 *
 * The HRA GLB ships 23 per-structure meshes with NO UV coordinates, so we
 * cannot attach a hand-painted atlas. Instead every structure gets a runtime
 * CanvasTexture whose 2D pattern is generated here — vessels, fibres, pores,
 * rings — and a fresh UV set projected onto the mesh by geometry type
 * (sphere / plane / cylinder). This keeps the specimen layered and readable
 * (anatomically accurate colouring) without any external asset.
 *
 * Textures are cached per structure id and disposed with the material.
 */

const TEX_SIZE = 512;
/** Conjunctiva textures render at 1024px: the lid surface fills large screen
 *  areas, and 512 shows visible texel stepping under the projection. */
const CONJUNCTIVA_SIZE = 1024;

/** Photorealistic external textures that replace procedural patterns where a
 *  real photograph beats a hand-drawn approximation. Loaded lazily and swapped
 *  onto the material once ready.
 *  - sclera: MIT (RoboPoets/digital_human)
 *  - retina: CC0 public domain fundus photograph (Mikael Häggström, Wikimedia)
 *  - iris: real brown iris photo (RoboPoets/digital_human, MIT) — brown is the
 *    most common human iris colour (~70–80% of the world population). */
const EXTERNAL_TEXTURES: Partial<Record<AnatomyPartId, { url: string; colorSpace?: THREE.ColorSpace }>> = {
  sclera: {
    url: "/models/sclera-textures/sclera-tileable.webp",
    colorSpace: THREE.SRGBColorSpace,
  },
  retina: {
    url: "/models/sclera-textures/fundus-seamless.jpg",
    colorSpace: THREE.SRGBColorSpace,
  },
  iris: {
    url: "/models/sclera-textures/iris-brown.webp",
    colorSpace: THREE.SRGBColorSpace,
  },
};

const textureLoader = new THREE.TextureLoader();

/** Asynchronously loads a real texture for a part and swaps it onto the
 *  material's `map` when ready. Falls back to the procedural canvas silently. */
export function loadExternalTexture(id: AnatomyPartId, material: THREE.Material) {
  const ext = EXTERNAL_TEXTURES[id];
  if (!ext || !("map" in material)) return;
  textureLoader.load(
    ext.url,
    (tex) => {
      if (ext.colorSpace) tex.colorSpace = ext.colorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      (material as THREE.MeshStandardMaterial).map = tex;
      material.needsUpdate = true;
    },
    undefined,
    () => {
      // Network failure — keep the procedural canvas texture.
    },
  );
}

/** HRA mesh name → short id used for texture caching + lookup. */
export type AnatomyPartId =
  | "sclera"
  | "cornea"
  | "iris"
  | "pupil"
  | "lens"
  | "zonules"
  | "aqueous"
  | "ciliary_body"
  | "ciliary_muscle"
  | "ciliary_processes"
  | "trabecular"
  | "schlemm"
  | "conj_palpebral_upper"
  | "conj_palpebral_lower"
  | "conj_bulbar"
  | "choroid"
  | "retina"
  | "fovea"
  | "macula"
  | "optic_disc"
  | "ora_serrata"
  | "vitreous"
  | "limbus";

/** Maps the HRA mesh name to our short part id. */
const PART_FROM_MESH: Record<string, AnatomyPartId> = {
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

/** Canvas + 2D context helpers ------------------------------------------- */

function makeCanvas(size = TEX_SIZE) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx };
}

function textureFrom(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Deterministic pseudo-random (so textures are stable across visits). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a network of branching vessels over a base colour. */
function drawVessels(
  ctx: CanvasRenderingContext2D,
  base: string,
  vesselColor: string,
  seed: number,
  count = 26,
  maxLength = 0.42,
) {
  const rand = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  ctx.strokeStyle = vesselColor;
  ctx.lineCap = "round";
  for (let i = 0; i < count; i += 1) {
    const x = rand() * TEX_SIZE;
    const y = rand() * TEX_SIZE;
    const ang = rand() * Math.PI * 2;
    const len = (0.15 + rand() * maxLength) * TEX_SIZE;
    ctx.lineWidth = 0.6 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
    // a couple of branches
    for (let b = 0; b < 2; b += 1) {
      const ba = ang + (rand() - 0.5) * 1.4;
      const bl = len * (0.3 + rand() * 0.35);
      ctx.lineWidth *= 0.7;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * len * 0.6, y + Math.sin(ang) * len * 0.6);
      ctx.lineTo(x + Math.cos(ang) * len * 0.6 + Math.cos(ba) * bl, y + Math.sin(ang) * len * 0.6 + Math.sin(ba) * bl);
      ctx.stroke();
    }
  }
}

/** Deterministic smooth value noise over [0,1]²: bilinear-smoothstep
 *  interpolation over a random lattice, so the pattern is continuous —
 *  never per-pixel popping or rectangular stepping. */
function makeValueNoise(seed: number, grid = 14) {
  const rand = mulberry32(seed);
  const lattice: number[][] = Array.from({ length: grid + 1 }, () =>
    Array.from({ length: grid + 1 }, () => rand()),
  );
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u: number, v: number) => {
    const gx = Math.min(Math.floor(u * grid), grid - 1);
    const gy = Math.min(Math.floor(v * grid), grid - 1);
    const fx = smooth(u * grid - gx);
    const fy = smooth(v * grid - gy);
    const a = lattice[gy][gx];
    const b = lattice[gy][gx + 1];
    const c = lattice[gy + 1][gx];
    const d = lattice[gy + 1][gx + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/** Conjunctiva: a smooth pink mucosal bed. Palpebral conjunctiva in health is
 *  a uniform pink sheet with only the faintest fine vessel detail — NOT bold
 *  red trunks. Bulbar conjunctiva is similarly smooth.
 *
 *  The mucosal mottling is a two-octave value-noise field (broad blush + fine
 *  capillary shimmer) written per-pixel, so the surface varies continuously —
 *  no rectangles, no per-pixel speckle, even where the sphere projection
 *  stretches the texture on the curved lid. */
function drawConjunctiva(ctx: CanvasRenderingContext2D, seed: number, size = TEX_SIZE) {
  const rand = mulberry32(seed);
  // Smooth pink base with a soft vertical gradient (paler toward the lid edge).
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, "#f4d0bf");
  grad.addColorStop(0.5, "#efc4b2");
  grad.addColorStop(1, "#f2cdbd");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Continuous mucosal mottling: a broad blush octave (~37px lattice) layered
  // with a fine capillary octave (~12px), both bilinearly smooth.
  const noise = makeValueNoise(seed + 7, 14);
  const fine = makeValueNoise(seed + 31, 42);
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let p = 0, i = 0; i < data.length; i += 4, p += 1) {
    const u = (p % size) / size;
    const v = ((p / size) | 0) / size;
    const k = (noise(u, v) - 0.5) * 22 + (fine(u, v) - 0.5) * 10;
    data[i] = Math.max(0, Math.min(255, data[i] + k));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + k * 0.82));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + k * 0.7));
  }
  ctx.putImageData(image, 0, 0);

  // A whisper of deep vertical tarsal vessels — healthy palpebral conjunctiva
  // shows large veins running vertically beneath a transparent surface.
  ctx.strokeStyle = "rgba(176, 82, 72, 0.055)";
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 22; i += 1) {
    const x = rand() * size;
    const y0 = rand() * size * 0.15;
    const len = (0.45 + rand() * 0.5) * size;
    const drift = (rand() - 0.5) * 24;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.bezierCurveTo(x, y0 + len * 0.4, x + drift, y0 + len * 0.65, x + drift * 0.6, y0 + len);
    ctx.stroke();
  }

  // Faint horizontal striae from the tarsal plate.
  ctx.strokeStyle = "rgba(205, 128, 112, 0.045)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 36; i += 1) {
    const y = rand() * size;
    const x0 = rand() * size * 0.3;
    const len = (0.4 + rand() * 0.6) * size;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + len, y + (rand() - 0.5) * 7);
    ctx.stroke();
  }
}

/** Limbus (corneoscleral junction): a 1–2 mm transition band between the clear
 *  avascular cornea and the vascular sclera. In health it shows a blue-grey
 *  ring with a dense RADIAL network of fine limbal vessels (the palisades of
 *  Vogt / marginal corneal arcades) — not random plaques. */
function drawLimbus(ctx: CanvasRenderingContext2D) {
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  // Soft blue-grey transitional base (light scattering at the oblique
  // cornea-sclera interface), slightly warmer toward the rim.
  const grad = ctx.createRadialGradient(cx, cy, TEX_SIZE * 0.1, cx, cy, TEX_SIZE * 0.5);
  grad.addColorStop(0, "#e8ecef");
  grad.addColorStop(0.7, "#c9d4da");
  grad.addColorStop(1, "#d9c9bf");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Dense radial limbal vessels: many fine spokes from the inner arcade,
  // thinning toward the periphery, slightly reddish.
  const spokes = 90;
  const rand = mulberry32(77);
  for (let i = 0; i < spokes; i += 1) {
    const ang = (i / spokes) * Math.PI * 2 + rand() * 0.06;
    const r0 = TEX_SIZE * (0.16 + rand() * 0.08);
    const r1 = r0 + TEX_SIZE * (0.2 + rand() * 0.16);
    ctx.strokeStyle = `rgba(185,70,60,${0.18 + rand() * 0.2})`;
    ctx.lineWidth = 0.7 + rand() * 1.1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }
  // A faint dense arcade ring at the corneal border (marginal arcades).
  ctx.strokeStyle = "rgba(150,60,55,0.14)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, TEX_SIZE * 0.24, 0, Math.PI * 2);
  ctx.stroke();
}

/** Radial iris pattern: fine fibres from the pupil edge outward. */
function drawIris(
  ctx: CanvasRenderingContext2D,
  base: string,
  inner: string,
  outer: string,
  seed: number,
) {
  const rand = mulberry32(seed);
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  // background radial gradient (inner → outer ring)
  const grad = ctx.createRadialGradient(cx, cy, TEX_SIZE * 0.1, cx, cy, TEX_SIZE * 0.5);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  // radial fibres
  for (let i = 0; i < 220; i += 1) {
    const ang = rand() * Math.PI * 2;
    const r0 = TEX_SIZE * (0.1 + rand() * 0.05);
    const r1 = TEX_SIZE * (0.3 + rand() * 0.2);
    const wob = (rand() - 0.5) * 0.18;
    ctx.strokeStyle = `rgba(60,35,12,${0.12 + rand() * 0.22})`;
    ctx.lineWidth = 0.5 + rand() * 1.3;
    ctx.beginPath();
    for (let r = r0; r < r1; r += 2) {
      const a = ang + Math.sin(r * 0.05 + rand()) * wob;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (r === r0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // collarette ring
  ctx.strokeStyle = "rgba(45,25,10,0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, TEX_SIZE * 0.36, 0, Math.PI * 2);
  ctx.stroke();
  // dark limbal edge
  ctx.strokeStyle = "rgba(20,10,5,0.5)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, TEX_SIZE * 0.48, 0, Math.PI * 2);
  ctx.stroke();
}

/** Choroid: a deep red-brown vascular bed. The arterial tree radiates from the
 *  posterior pole (texture centre) and now reaches the texture edge — the
 *  choroid lines the whole inner sclera, so cross-sections at the equator must
 *  show vessels too. Vortex veins return coarsely from the periphery. */
function drawChoroid(ctx: CanvasRenderingContext2D) {
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  const R = TEX_SIZE * 0.5;
  // Deep red-brown base with a subtle radial falloff.
  const grad = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
  grad.addColorStop(0, "#9a3844");
  grad.addColorStop(1, "#6e2030");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Subtle high-frequency mottle (too weak to form visible blobs) plus a
  // capillary plexus of fine short vessels, so the bed reads as dense living
  // tissue instead of flat colour or drop-like noise patches.
  const noise = makeValueNoise(31, 40);
  const image = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  const data = image.data;
  for (let p = 0, i = 0; i < data.length; i += 4, p += 1) {
    const u = (p % TEX_SIZE) / TEX_SIZE;
    const v = ((p / TEX_SIZE) | 0) / TEX_SIZE;
    const k = (noise(u, v) - 0.5) * 7;
    data[i] = Math.max(0, Math.min(255, data[i] + k));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + k * 0.9));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + k * 0.8));
  }
  ctx.putImageData(image, 0, 0);

  const rand = mulberry32(31);

  // Capillary plexus: many fine short vessels scattered over the whole bed.
  ctx.strokeStyle = "rgba(30,8,12,0.24)";
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 700; i += 1) {
    const angle = rand() * Math.PI * 2;
    const r0 = R * (0.08 + rand() * 0.88);
    const len = R * (0.03 + rand() * 0.07);
    const a2 = angle + (rand() - 0.5) * 0.9;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
    ctx.lineTo(cx + Math.cos(a2) * (r0 + len), cy + Math.sin(a2) * (r0 + len));
    ctx.stroke();
  }

  // Full-surface arterial tree from the posterior pole (short ciliary
  // arteries): trunks run to the texture edge, branching along the way.
  ctx.lineCap = "round";
  const trunks = 10;
  for (let t = 0; t < trunks; t += 1) {
    const baseAngle = (t / trunks) * Math.PI * 2 + rand() * 0.2;
    const drawBranch = (angle: number, r: number, width: number, depth: number) => {
      const span = depth === 4 ? 0.82 : depth === 3 ? 0.34 : depth === 2 ? 0.18 : 0.1;
      const length = R * span * (0.8 + rand() * 0.2);
      const endR = Math.min(r + length, R * 0.97);
      const curve = (rand() - 0.5) * 0.3;
      ctx.strokeStyle = `rgba(25,6,10,${0.45 + rand() * 0.18})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      ctx.quadraticCurveTo(
        cx + Math.cos(angle + curve) * (r + length * 0.5),
        cy + Math.sin(angle + curve) * (r + length * 0.5),
        cx + Math.cos(angle + curve * 0.4) * endR,
        cy + Math.sin(angle + curve * 0.4) * endR,
      );
      ctx.stroke();
      if (depth > 0 && endR < R * 0.95) {
        const splits = rand() < 0.75 ? 2 : 3;
        for (let b = 0; b < splits; b += 1) {
          drawBranch(angle + (b === 0 ? -0.24 : 0.24) + (rand() - 0.5) * 0.24, endR, width * 0.62, depth - 1);
        }
      }
    };
    // Staggered origins keep the trunk bundle from clotting into a dark blob
    // around the posterior pole.
    drawBranch(baseAngle, R * (0.07 + rand() * 0.06), 2.6 + rand() * 1.2, 4);
  }

  // Mid-tier radial vessels filling the gaps between trunks, so no sector of
  // the choroid reads as an empty vessel-free patch (which cross-sections
  // exposed as "water-drop" holes with dark vascular borders).
  ctx.strokeStyle = "rgba(28,7,11,0.32)";
  ctx.lineWidth = 1.5;
  for (let t = 0; t < 12; t += 1) {
    const angle = ((t + 0.5) / 12) * Math.PI * 2 + rand() * 0.12;
    const fromR = R * (0.12 + rand() * 0.08);
    const toR = R * (0.88 + rand() * 0.09);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * fromR, cy + Math.sin(angle) * fromR);
    ctx.quadraticCurveTo(
      cx + Math.cos(angle + 0.2) * (fromR + (toR - fromR) * 0.5),
      cy + Math.sin(angle + 0.2) * (fromR + (toR - fromR) * 0.5),
      cx + Math.cos(angle + 0.08) * toR,
      cy + Math.sin(angle + 0.08) * toR,
    );
    ctx.stroke();
  }

  // Vortex veins: coarse venous channels returning from the periphery toward
  // the posterior pole, evenly spaced so no side clumps into a dark patch.
  const veins = 5;
  for (let t = 0; t < veins; t += 1) {
    const angle = (t / veins) * Math.PI * 2 + rand() * 0.18;
    const fromR = R * (0.92 + rand() * 0.04);
    const toR = R * (0.38 + rand() * 0.1);
    ctx.strokeStyle = `rgba(18,4,8,${0.35 + rand() * 0.15})`;
    ctx.lineWidth = 2.4 + rand() * 1.0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * fromR, cy + Math.sin(angle) * fromR);
    ctx.quadraticCurveTo(
      cx + Math.cos(angle + 0.35) * R * 0.66,
      cy + Math.sin(angle + 0.35) * R * 0.66,
      cx + Math.cos(angle + 0.15) * toR,
      cy + Math.sin(angle + 0.15) * toR,
    );
    ctx.stroke();
  }
  ctx.lineCap = "butt";

  // Edge feathering: fade vessel darkness toward the texture borders so the
  // sphere mapping's seams and poles never show abruptly-cut vessels — smooth
  // transitions even where the topology converges.
  const final = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  const fdata = final.data;
  const EDGE_FADE = 14;
  for (let y = 0; y < TEX_SIZE; y += 1) {
    for (let x = 0; x < TEX_SIZE; x += 1) {
      const dEdge = Math.min(x, y, TEX_SIZE - 1 - x, TEX_SIZE - 1 - y);
      if (dEdge >= EDGE_FADE) continue;
      const t = dEdge / EDGE_FADE; // 0 at edge → 1 inside
      const i = (y * TEX_SIZE + x) * 4;
      const lift = (1 - t) * 0.55;
      fdata[i] = fdata[i] + (255 - fdata[i]) * lift * 0.5;
      fdata[i + 1] = fdata[i + 1] + (255 - fdata[i + 1]) * lift * 0.5;
      fdata[i + 2] = fdata[i + 2] + (255 - fdata[i + 2]) * lift * 0.5;
    }
  }
  ctx.putImageData(final, 0, 0);
}

/** Retina: soft pink bed with a sparse, gently branching vascular tree. */
function drawRetina(ctx: CanvasRenderingContext2D) {
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  ctx.fillStyle = "#c98a88";
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  const rand = mulberry32(55);
  // A few arc-like retinal vessels sweeping from the optic disc area.
  for (let t = 0; t < 6; t += 1) {
    const angle = -Math.PI / 2 + t * 0.5 + rand() * 0.2;
    ctx.strokeStyle = "rgba(140,40,55,0.55)";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * TEX_SIZE * 0.05, cy + Math.sin(angle) * TEX_SIZE * 0.05);
    ctx.quadraticCurveTo(
      cx + Math.cos(angle) * TEX_SIZE * 0.3,
      cy + Math.sin(angle) * TEX_SIZE * 0.3,
      cx + Math.cos(angle + 0.5) * TEX_SIZE * 0.45,
      cy + Math.sin(angle + 0.5) * TEX_SIZE * 0.45,
    );
    ctx.stroke();
  }
}

/** Porous / trabecular meshwork: a grid of small dark pores. */
function drawTrabecular(ctx: CanvasRenderingContext2D, base: string) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  const step = 16;
  for (let y = 0; y < TEX_SIZE; y += step) {
    for (let x = 0; x < TEX_SIZE; x += step) {
      ctx.fillStyle = `rgba(70,45,18,${0.25 + ((x + y) % 40) / 130})`;
      ctx.beginPath();
      ctx.arc(x + step / 2 + (x % step), y + step / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // faint beam lines between pores
  ctx.strokeStyle = "rgba(120,90,40,0.35)";
  ctx.lineWidth = 1.4;
  for (let i = 0; i < TEX_SIZE; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, TEX_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(TEX_SIZE, i);
    ctx.stroke();
  }
}

/** Concentric lens fibre rings. */
function drawLens(ctx: CanvasRenderingContext2D, base: string) {
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  const grad = ctx.createRadialGradient(cx, cy, TEX_SIZE * 0.05, cx, cy, TEX_SIZE * 0.5);
  grad.addColorStop(0, "#fffbe8");
  grad.addColorStop(1, "#d9e3c9");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  ctx.strokeStyle = "rgba(160,150,90,0.30)";
  for (let r = TEX_SIZE * 0.12; r < TEX_SIZE * 0.5; r += 9) {
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Striated fibres for the ciliary muscle / body. */
function drawStriations(
  ctx: CanvasRenderingContext2D,
  base: string,
  stripe: string,
  angle: number,
  seed: number,
) {
  const rand = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  const spacing = 7;
  ctx.save();
  ctx.translate(TEX_SIZE / 2, TEX_SIZE / 2);
  ctx.rotate(angle);
  ctx.strokeStyle = stripe;
  ctx.lineWidth = 2.2;
  for (let i = -TEX_SIZE; i < TEX_SIZE; i += spacing) {
    ctx.beginPath();
    ctx.moveTo(i + (rand() - 0.5) * 2, -TEX_SIZE);
    ctx.lineTo(i + (rand() - 0.5) * 2, TEX_SIZE);
    ctx.stroke();
  }
  ctx.restore();
}

/** Textured base for a solid structure with faint noise. */
function drawNoiseBase(ctx: CanvasRenderingContext2D, base: string, seed: number, amount = 0.06) {
  const rand = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  for (let i = 0; i < 1400; i += 1) {
    ctx.fillStyle = `rgba(255,255,255,${rand() * amount})`;
    ctx.fillRect(rand() * TEX_SIZE, rand() * TEX_SIZE, 2, 2);
  }
}

// ---------------------------------------------------------------------------
// Texture registry
// ---------------------------------------------------------------------------

const cache = new Map<AnatomyPartId, THREE.CanvasTexture>();

function getOrBuild(id: AnatomyPartId, build: () => THREE.CanvasTexture): THREE.CanvasTexture {
  const hit = cache.get(id);
  if (hit) return hit;
  const tex = build();
  cache.set(id, tex);
  return tex;
}

/** Builds (and caches) the base-colour texture for a structure. */
export function partTexture(id: AnatomyPartId): THREE.CanvasTexture {
  return getOrBuild(id, () => {
    const { canvas, ctx } = makeCanvas();
    switch (id) {
      case "sclera":
        drawVessels(ctx, "#f4efe4", "rgba(214,120,105,0.35)", 11, 18, 0.3);
        break;
      case "limbus":
        drawLimbus(ctx);
        break;
      case "conj_palpebral_upper":
      case "conj_palpebral_lower":
      case "conj_bulbar": {
        // 1024px: the lid surface fills large screen areas at 1.2x UV
        // magnification — 512 shows visible texel stepping.
        const { canvas: hiCanvas, ctx: hiCtx } = makeCanvas(CONJUNCTIVA_SIZE);
        drawConjunctiva(hiCtx, id === "conj_bulbar" ? 21 : 15, CONJUNCTIVA_SIZE);
        return textureFrom(hiCanvas);
      }
      case "iris":
        drawIris(ctx, "", "#7a4c1d", "#b5813a", 42);
        break;
      case "pupil":
        ctx.fillStyle = "#0a0a0c";
        ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
        break;
      case "lens":
        drawLens(ctx, "");
        break;
      case "zonules":
        drawStriations(ctx, "rgba(240,244,240,0.85)", "rgba(200,205,190,0.7)", Math.PI / 4, 5);
        break;
      case "aqueous":
        ctx.fillStyle = "rgba(200,225,240,0.6)";
        ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
        break;
      case "ciliary_body":
        drawStriations(ctx, "#a0603c", "rgba(70,32,16,0.5)", 0.35, 8);
        break;
      case "ciliary_muscle":
        drawStriations(ctx, "#8c3d24", "rgba(45,16,8,0.55)", 0.1, 13);
        break;
      case "ciliary_processes":
        drawStriations(ctx, "#7a3320", "rgba(40,14,6,0.6)", 0.55, 17);
        break;
      case "trabecular":
        drawTrabecular(ctx, "#c9a866");
        break;
      case "schlemm":
        drawStriations(ctx, "#b06a52", "rgba(90,30,20,0.45)", 0, 23);
        break;
      case "choroid":
        drawChoroid(ctx);
        break;
      case "retina":
        drawRetina(ctx);
        break;
      case "fovea":
        drawNoiseBase(ctx, "#e0b26a", 71);
        break;
      case "macula":
        drawNoiseBase(ctx, "#d9b45a", 72);
        break;
      case "optic_disc":
        drawNoiseBase(ctx, "#d8c8b2", 73);
        break;
      case "ora_serrata":
        drawVessels(ctx, "#b06660", "rgba(90,25,30,0.7)", 81, 22, 0.4);
        break;
      case "vitreous":
        ctx.fillStyle = "rgba(220,230,235,0.45)";
        ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
        break;
      default:
        drawNoiseBase(ctx, "#cccccc", 1);
    }
    return textureFrom(canvas);
  });
}

/** Frees every cached procedural texture. */
export function disposePartTextures() {
  cache.forEach((tex) => tex.dispose());
  cache.clear();
}

/** Parts whose large triangles visibly facet the texture on a curved sphere.
 *  One Loop-subdivision pass quadruples their faces and, with uvSmooth, keeps
 *  the projected UVs continuous so vessel detail no longer reads as flat
 *  polygon blocks. Vitreous is deliberately excluded: it is a translucent
 *  jelly filling the posterior chamber, so its surface reads as a smooth
 *  shell either way — subdividing it costs ~4.7s of blocking load time. */
const SMOOTH_PARTS: ReadonlySet<AnatomyPartId> = new Set([
  "sclera",
  "cornea",
  "choroid",
  "retina",
]);

/**
 * Smooths a mesh's geometry with one Loop-subdivision pass (4× faces) so the
 * procedural/external texture maps without visible polygonal faceting. Called
 * after UVs are generated. Returns true when the geometry was subdivided.
 */
export function smoothPartGeometry(mesh: THREE.Mesh, id: AnatomyPartId): boolean {
  if (!SMOOTH_PARTS.has(id)) return false;
  const original = mesh.geometry;
  // uvSmooth averages new UVs so the texture stays continuous across the
  // subdivided faces (no seams or tearing at the vessel tree).
  const smooth = LoopSubdivision.modify(original, 1, { uvSmooth: true });
  mesh.geometry = smooth;
  original.dispose();
  return true;
}

// ---------------------------------------------------------------------------
// UV projection
// ---------------------------------------------------------------------------

/** Generates UVs for a mesh based on its dominant geometry type. When
 *  `backPole` is true the texture centre maps to the posterior pole (−Z) —
 *  used by choroid/retina whose vessel tree converges at the optic disc.
 *  `radial` maps an annular mesh (iris) so its centre hole (pupil) lines up
 *  with the texture centre: angle → u, radius (inner hole → outer rim) → v. */
export function generatePartUVs(
  mesh: THREE.Mesh,
  kind: "sphere" | "plane" | "cylinder" | "radial",
  backPole = false,
) {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos) return;
  const count = pos.count;
  const uvs = new Float32Array(count * 2);
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // Radial projection needs the inner (pupil) radius from the centre axis.
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
    let u: number;
    let v: number;
    if (kind === "sphere") {
      const r = Math.max(Math.hypot(x, y, z), 1e-5);
      // Azimuth anchored at +Z: u=0.5 (texture centre) faces the pupil axis,
      // so the sclera's white centre lands on the front of the eye.
      // With backPole the azimuth flips 180°, converging at −Z (optic disc).
      u = (Math.atan2(x, z) / (Math.PI * 2)) + 0.5 + (backPole ? 0.5 : 0);
      v = Math.acos(THREE.MathUtils.clamp(y / r, -1, 1)) / Math.PI;
    } else if (kind === "radial") {
      // Annular mapping: texture centre (pupil) ↔ mesh centre hole.
      const r = Math.max(Math.hypot(x, z), 1e-5);
      u = (Math.atan2(z, x) / (Math.PI * 2)) + 0.5;
      const span = Math.max(maxR - minR, 1e-5);
      v = (r - minR) / span;
    } else if (kind === "plane") {
      u = (x / size.x) + 0.5;
      v = (z / size.z) + 0.5;
    } else {
      // cylinder around Y
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

/** Geometry kind for each part, chosen to keep the pattern readable. */
const UV_KIND: Record<AnatomyPartId, "sphere" | "plane" | "cylinder" | "radial"> = {
  sclera: "sphere",
  cornea: "sphere",
  iris: "radial",
  pupil: "plane",
  lens: "sphere",
  zonules: "plane",
  aqueous: "sphere",
  ciliary_body: "cylinder",
  ciliary_muscle: "plane",
  ciliary_processes: "cylinder",
  trabecular: "cylinder",
  schlemm: "cylinder",
  conj_palpebral_upper: "sphere",
  conj_palpebral_lower: "sphere",
  conj_bulbar: "sphere",
  choroid: "sphere",
  retina: "sphere",
  fovea: "plane",
  macula: "plane",
  optic_disc: "plane",
  ora_serrata: "cylinder",
  vitreous: "sphere",
  limbus: "sphere",
};

export function partIdForMesh(name: string): AnatomyPartId | null {
  return PART_FROM_MESH[name] ?? null;
}

export function uvKindForPart(id: AnatomyPartId): "sphere" | "plane" | "cylinder" | "radial" {
  return UV_KIND[id];
}

// ---------------------------------------------------------------------------
// Material factory
// ---------------------------------------------------------------------------

/**
 * Builds the material for one HRA structure. Transparent structures (cornea,
 * lens, aqueous, vitreous) use a physical material flagged so the viewer's
 * fade/reset logic restores transparency instead of forcing opaque.
 */
export function partMaterial(id: AnatomyPartId): THREE.Material {
  const map = partTexture(id);
  const transparentParts: AnatomyPartId[] = ["cornea", "lens", "aqueous", "vitreous", "zonules"];
  const isTransparent = transparentParts.includes(id);

  if (isTransparent) {
    const defaultOpacity = id === "cornea" ? 0.55 : id === "zonules" ? 0.85 : 0.5;
    const mat = new THREE.MeshPhysicalMaterial({
      map,
      transparent: true,
      opacity: defaultOpacity,
      roughness: id === "cornea" ? 0.06 : 0.25,
      metalness: 0,
      clearcoat: id === "cornea" ? 1 : 0.35,
      clearcoatRoughness: 0.08,
      side: THREE.DoubleSide,
      depthWrite: id === "zonules" ? true : false,
    });
    // The viewer's fade/reset must keep these transparent after intro.
    mat.userData.proceduralTransparent = true;
    mat.userData.defaultOpacity = defaultOpacity;
    return mat;
  }

  const mat = new THREE.MeshStandardMaterial({
    map,
    roughness: id === "iris" ? 0.72 : id === "sclera" ? 0.6 : 0.68,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  return mat;
}
