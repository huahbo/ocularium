import * as THREE from "three";
import type { LoadedOrgan } from "./loaders";

/**
 * Procedural layered eyeball.
 *
 * The old `eyeball.glb` (a single merged Tripo export that could not be
 * peeled) was removed as dead weight — the eye always renders the HRA model.
 * This module remains as a code-only fallback: it rebuilds the eye from
 * concentric shells, every layer its own mesh tagged with `userData.layer`,
 * which the viewer uses to show/hide layers one at a time.
 *
 * Geometry is authored at final size: the eye sits at the origin with radius
 * 1.9 (half of FIT_SIZE), the visual axis along +Z (cornea at the front), and
 * the optic nerve trailing out the back (−Z). Hotspot coordinates in
 * `anatomy-data` are authored in this exact space, so the snap-to-surface pass
 * lands dots on the right shell.
 */

const R = 1.9; // sclera outer radius — FIT_SIZE / 2

/** Cornea angular extent from the front pole (radians). Roughly the front
 *  fifth of the sphere, mirroring the limbus. */
const LIMBUS = 0.55;

/** Exposed for the layer panel UI. Order matters: outermost first. */
export const EYE_LAYERS = [
  { id: "sclera", label: "Sclera", color: "#f3eee4" },
  { id: "cornea", label: "Cornea", color: "#bfe3f0" },
  { id: "choroid", label: "Choroid", color: "#6b2230" },
  { id: "retina", label: "Retina", color: "#d996a1" },
  { id: "ciliary", label: "Ciliary Body", color: "#8a5a3a" },
  { id: "iris", label: "Iris", color: "#a57a3c" },
  { id: "pupil", label: "Pupil", color: "#101418" },
  { id: "lens", label: "Lens", color: "#e8f0f5" },
  { id: "vitreous", label: "Vitreous Humor", color: "#f0f4f7" },
  { id: "optic", label: "Optic Nerve", color: "#ead9c8" },
] as const;

/** A sphere shell whose front cap (around +Z) can be cut away, so the cornea
 *  window and the underlying shells read as open anatomy rather than a sealed
 *  ball. */
function shell(radius: number, thetaStart: number, thetaLength: number, material: THREE.Material, layer: string) {
  const geometry = new THREE.SphereGeometry(radius, 64, 48, 0, Math.PI * 2, thetaStart, thetaLength);
  // SphereGeometry measures theta from +Y; rotate so the front pole (+Z) is at
  // theta 0 — the cut then always faces the viewer.
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `eye-${layer}`;
  mesh.userData.layer = layer;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function disc(radius: number, positionZ: number, material: THREE.Material, layer: string) {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), material);
  mesh.name = `eye-${layer}`;
  mesh.userData.layer = layer;
  mesh.position.z = positionZ;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function standard(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...opts });
}

function clearShell(color: number, opacity: number) {
  return new THREE.MeshPhysicalMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.08,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
}

/** Builds the complete layered eye. Every mesh carries `userData.layer` so the
 *  viewer can peel it apart. */
export function buildEye(): LoadedOrgan {
  const pivot = new THREE.Group();
  pivot.name = "organ-pivot";
  pivot.rotation.set(0.05, -0.28, 0);

  const meshes: THREE.Mesh[] = [];

  // --- outermost shell: sclera, with the cornea window cut out of the front
  meshes.push(
    shell(
      R,
      LIMBUS,
      Math.PI - LIMBUS,
      standard(0xf3eee4, { roughness: 0.62 }),
      "sclera",
    ),
  );

  // --- transparent cornea dome over the front window
  meshes.push(shell(R + 0.02, 0, LIMBUS + 0.06, clearShell(0xdceff7, 0.3), "cornea"));

  // --- vascular choroid under the sclera, ending near the limbus
  meshes.push(
    shell(
      R - 0.06,
      LIMBUS + 0.12,
      Math.PI - LIMBUS - 0.12,
      standard(0x6b2230, { roughness: 0.7 }),
      "choroid",
    ),
  );

  // --- retina lines the back two-thirds, ending at the ora serrata
  meshes.push(
    shell(
      R - 0.12,
      Math.PI * 0.5,
      Math.PI * 0.5,
      standard(0xd996a1, { roughness: 0.6 }),
      "retina",
    ),
  );

  // --- ciliary body: the ring the lens suspends from, just behind the iris
  const ciliary = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.17, 16, 64),
    standard(0x8a5a3a, { roughness: 0.75 }),
  );
  ciliary.name = "eye-ciliary";
  ciliary.userData.layer = "ciliary";
  ciliary.position.z = 0.92;
  ciliary.frustumCulled = false;
  meshes.push(ciliary);

  // --- iris: an annular diaphragm with the pupil hole at its centre
  const iris = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.85, 64),
    standard(0xa57a3c, { roughness: 0.5, side: THREE.DoubleSide }),
  );
  iris.name = "eye-iris";
  iris.userData.layer = "iris";
  iris.position.z = 1.12;
  iris.frustumCulled = false;
  meshes.push(iris);

  // --- pupil: the dark aperture the iris ring surrounds
  meshes.push(disc(0.3, 1.1, standard(0x101418, { roughness: 0.95 }), "pupil"));

  // --- lens: a transparent biconvex body suspended behind the iris
  const lens = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 48, 32),
    clearShell(0xe8f0f5, 0.32),
  );
  lens.name = "eye-lens";
  lens.userData.layer = "lens";
  lens.scale.z = 0.45;
  lens.position.z = 0.68;
  lens.frustumCulled = false;
  meshes.push(lens);

  // --- vitreous humor: the transparent jelly filling the posterior chamber
  meshes.push(shell(R - 0.18, 0, Math.PI, clearShell(0xf0f4f7, 0.1), "vitreous"));

  // --- optic nerve: the stalk trailing out of the back of the globe
  const optic = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.42, 1.5, 32),
    standard(0xead9c8, { roughness: 0.7 }),
  );
  optic.name = "eye-optic";
  optic.userData.layer = "optic";
  optic.rotation.x = Math.PI / 2;
  optic.position.z = -2.5;
  optic.frustumCulled = false;
  meshes.push(optic);

  meshes.forEach((mesh) => pivot.add(mesh));

  return { url: "procedural:eye", pivot, meshes, mixer: null };
}
