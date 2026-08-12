import * as THREE from "three";
import type { Hotspot } from "../anatomy-data";

export type Marker = {
  hotspot: Hotspot;
  /** The point on the mesh this marker belongs to, in pivot space. */
  anchor: THREE.Vector3;
};

/** A hair off the mesh, just enough to avoid z-fighting with the skin. */
const SURFACE_LIFT = 0.02;

/** Soft ring used for the selection halo (Plan B): one gentle ring on the
 *  currently selected structure, nothing else renders. */
function ringTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, size * 0.28, c, c, size * 0.5);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.78, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.94, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.46, 0, Math.PI * 2);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Anchor manager for the anatomy hotspots. The colourful 3D dots have been
 * removed — structures are picked by raycasting their meshes, and the callout /
 * hotspot-index UI keeps working off the anchors computed here. The only thing
 * this layer still renders is a single soft halo on the selected structure.
 */
export class HotspotLayer {
  private markers: Marker[] = [];
  private group = new THREE.Group();
  private halo: THREE.Sprite | null = null;
  private haloTexture = ringTexture();

  private readonly projected = new THREE.Vector3();

  constructor() {
    this.group.name = "hotspot-layer";
  }

  get list(): readonly Marker[] {
    return this.markers;
  }

  attach(pivot: THREE.Group, hotspots: Hotspot[], meshes: THREE.Mesh[]) {
    this.clear();
    if (!hotspots.length) return;
    const anchors = snapToSurface(hotspots, pivot, meshes);
    hotspots.forEach((hotspot, index) => {
      this.markers.push({ hotspot, anchor: anchors[index].clone() });
    });
    pivot.add(this.group);
  }

  /** Plan B: one soft halo on the selected structure's anchor. Passing null
   *  (or an id with no marker) hides it. */
  setSelected(id: string | null) {
    if (!this.halo) {
      this.halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.haloTexture,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          sizeAttenuation: true,
          toneMapped: false,
          opacity: 0.55,
        }),
      );
      this.halo.renderOrder = 9;
      this.group.add(this.halo);
    }
    const marker = id ? this.markers.find((m) => m.hotspot.id === id) : null;
    if (!marker) {
      this.halo.visible = false;
      return;
    }
    this.halo.visible = true;
    this.halo.position.copy(marker.anchor);
    this.halo.scale.setScalar(0.22);
  }

  /** Screen-space anchor for the callout, from the marker's surface anchor. */
  screenPosition(id: string, camera: THREE.PerspectiveCamera, width: number, height: number) {
    const marker = this.markers.find((item) => item.hotspot.id === id);
    if (!marker) return null;
    this.group.updateWorldMatrix(true, false);
    this.projected.copy(marker.anchor).applyMatrix4(this.group.matrixWorld).project(camera);
    if (this.projected.z > 1) return null;
    return {
      x: (this.projected.x * 0.5 + 0.5) * width,
      y: (-this.projected.y * 0.5 + 0.5) * height,
      opacity: 1,
    };
  }

  clear() {
    this.markers = [];
    this.halo?.removeFromParent();
    this.halo = null;
    this.group.clear();
    this.group.removeFromParent();
  }

  dispose() {
    this.clear();
    this.haloTexture.dispose();
  }
}

/** Cones, tightest first, used to keep a dot on the side of the organ the
 *  anatomy data actually points at. The last one accepts anything. */
const DIRECTION_CONES = [0.94, 0.82, 0.6, -1.1];

type Candidate = { distance: number; mesh: THREE.Mesh; index: number; point: THREE.Vector3 };

/**
 * Moves each authored hotspot onto the mesh shell so anchors sit on the organ
 * instead of floating inside it. Picking the nearest vertex alone can snap an
 * anchor through to the far side, so candidates are first filtered by direction
 * from the organ's centre and only then by distance.
 *
 * One linear pass over the vertices, run once per organ — far cheaper and
 * steadier than raycasting a mesh every frame.
 */
function snapToSurface(hotspots: Hotspot[], pivot: THREE.Group, meshes: THREE.Mesh[]) {
  const targets = hotspots.map((hotspot) => new THREE.Vector3(...hotspot.position));
  const directions = targets.map((target) => target.clone().normalize());
  const tiers: (Candidate | null)[][] = hotspots.map(() => DIRECTION_CONES.map(() => null));
  if (!meshes.length) return targets;

  pivot.updateWorldMatrix(true, true);
  const toPivot = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const vertex = new THREE.Vector3();

  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    if (!position) continue;
    local.multiplyMatrices(toPivot, mesh.matrixWorld);

    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(local);
      const radius = vertex.length();
      for (let h = 0; h < targets.length; h += 1) {
        const distance = vertex.distanceToSquared(targets[h]);
        const cosine = radius > 1e-5 ? vertex.dot(directions[h]) / radius : 1;
        for (let t = 0; t < DIRECTION_CONES.length; t += 1) {
          if (cosine < DIRECTION_CONES[t]) continue;
          const best = tiers[h][t];
          if (best && best.distance <= distance) continue;
          if (best) {
            best.distance = distance;
            best.mesh = mesh;
            best.index = i;
            best.point.copy(vertex);
          } else {
            tiers[h][t] = { distance, mesh, index: i, point: vertex.clone() };
          }
        }
      }
    }
  }

  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  return targets.map((target, h) => {
    const chosen = tiers[h].find(Boolean);
    if (!chosen) return target;
    const normals = chosen.mesh.geometry.getAttribute("normal");
    if (normals) {
      local.multiplyMatrices(toPivot, chosen.mesh.matrixWorld);
      normalMatrix.getNormalMatrix(local);
      normal.fromBufferAttribute(normals, chosen.index).applyMatrix3(normalMatrix).normalize();
    } else {
      normal.copy(chosen.point).normalize();
    }
    // Lift outwards even when the nearest triangle happens to face inwards.
    if (normal.dot(chosen.point) < 0) normal.negate();
    return chosen.point.addScaledVector(normal, SURFACE_LIFT);
  });
}
