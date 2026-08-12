import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import gsap from "gsap";
import type { Hotspot, QuizMode } from "../anatomy-data";
import { AnatomyAssetManager, type LoadedOrgan } from "./loaders";
import { HotspotLayer } from "./hotspots";
import { disposeObject } from "./dispose";
import { partIdForMesh, partMaterial, generatePartUVs, uvKindForPart, loadExternalTexture, smoothPartGeometry } from "./anatomy-materials";

type ViewerCallbacks = {
  onLoading: (loading: boolean, progress: number) => void;
  onSelect: (hotspot: Hotspot | null) => void;
};

/** Builds an organ from code (e.g. the layered eye) instead of loading a GLB. */
export type ProceduralOrganFactory = () => LoadedOrgan;

const DOT_PIXELS = 34;
const CAMERA_FOV = 34;
const DEPTH_PREPASS = "depth-prepass";
const PLINTH_Y = -2.5;
const PLINTH_TOP = PLINTH_Y + 0.17;
/** Slightly above eye level, so the plinth reads as a disc the organ sits on
 *  rather than an edge-on band across the background. */
const HOME_CAMERA = { x: 0, y: 1.05, z: 8.2 };
const HOME_TARGET = { x: 0, y: 0.02, z: 0 };

// ---------------------------------------------------------------------------
// Condition geometry deformations (FIT_SIZE space, +Z front / -Z back)
// ---------------------------------------------------------------------------

/** Rhegmatogenous retinal detachment: the inferior neurosensory retina lifts
 *  away from the pigment epithelium along its radial direction, with a gentle
 *  corrugation like the real "sail" of a detached retina. */
function deformRetinaDetachment(mesh: THREE.Mesh) {
  const attribute = mesh.geometry.getAttribute("position");
  const count = attribute.count;
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    p.set(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
    const radius = Math.max(p.length(), 1e-5);
    const lower = THREE.MathUtils.clamp(-p.y / radius, 0, 1); // 1 = inferior
    const peripheral = THREE.MathUtils.clamp((radius - 1.15) / 0.6, 0, 1); // near equator
    const corrugation = 0.5 + 0.5 * Math.sin(p.x * 4.5);
    const lift = 0.16 * lower * peripheral * corrugation;
    p.addScaledVector(p.clone().divideScalar(radius), lift);
    attribute.setXYZ(i, p.x, p.y, p.z);
  }
  attribute.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

/** Glaucomatous optic-nerve-head cupping: the disc centre sinks toward the
 *  nerve (−Z), deepest at the cup axis — the classic enlarged cup-to-disc. */
function deformOpticCup(mesh: THREE.Mesh) {
  const attribute = mesh.geometry.getAttribute("position");
  for (let i = 0; i < attribute.count; i += 1) {
    const x = attribute.getX(i);
    const y = attribute.getY(i);
    const z = attribute.getZ(i);
    const distance = Math.hypot(x, y); // distance from the optic axis
    const cup = Math.max(0, 1 - distance / 0.45);
    attribute.setZ(i, z - 0.24 * cup * cup);
  }
  attribute.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

/** Age-related lens swelling in cataract: the lens expands a few percent
 *  outward from its centre (≈ [0, 0, 0.68]). */
function deformLensSwelling(mesh: THREE.Mesh) {
  const attribute = mesh.geometry.getAttribute("position");
  const centre = new THREE.Vector3(0, 0, 0.68);
  for (let i = 0; i < attribute.count; i += 1) {
    const x = attribute.getX(i) - centre.x;
    const y = attribute.getY(i) - centre.y;
    const z = attribute.getZ(i) - centre.z;
    attribute.setXYZ(i, centre.x + x * 1.09, centre.y + y * 1.09, centre.z + z * 1.09);
  }
  attribute.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

export class AnatomyViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  private controls: OrbitControls;
  private assets: AnatomyAssetManager;
  private hotspots = new HotspotLayer();
  private callbacks: ViewerCallbacks;
  private container: HTMLElement;
  private organ: LoadedOrgan | null = null;
  private plinth!: THREE.Mesh;
  private contactShadow!: THREE.Mesh;

  private frame = 0;
  private clock = new THREE.Clock();
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  /** Writes depth only — used to resolve a fading organ to one surface. */
  private depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
  private crossSection = false;
  private isolated = false;
  /** True while the current organ was built from code rather than loaded. */
  private procedural = false;

  private width = 1;
  private height = 1;
  private isVisible = true;
  private isPageVisible = true;

  // Render-on-demand bookkeeping: the loop only draws when something moved.
  private dirty = true;
  private busyUntil = 0;
  private loadRequest = 0;

  private basePixelRatio: number;

  private autoRotateWanted = true;
  private interactionUntil = 0;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private hoverProbe: { x: number; y: number } | null = null;
  private pointerId: number | null = null;
  private pointerStart = { x: 0, y: 0 };
  private dragged = false;
  private calloutEl: HTMLElement | null = null;
  private fadeTween: gsap.core.Tween | null = null;
  private disposed = false;

  constructor(container: HTMLElement, callbacks: ViewerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    const lowPower = window.matchMedia("(max-width: 780px)").matches || (navigator.hardwareConcurrency ?? 8) < 6;
    // Fixed, decided once. A dynamic controller used to live here and it was a
    // net negative: frame *intervals* are vsync-quantised, so a brief hitch read
    // as GPU load, dropped the buffer, and — because a vsync-locked 16.7ms never
    // met the step-up threshold — never recovered. The scene renders in ~2ms, so
    // there is nothing to adapt away from.
    this.basePixelRatio = Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !lowPower,
      alpha: true,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    // Shadow mapping would render every organ twice per frame; a baked contact
    // shadow gives the same read for free.
    this.renderer.shadowMap.enabled = false;
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D anatomy model. Drag to rotate, scroll to zoom, and click a dot to read about that structure.",
    );
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(HOME_CAMERA.x, HOME_CAMERA.y, HOME_CAMERA.z);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 4.8;
    this.controls.maxDistance = 12;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.65;
    this.controls.target.set(HOME_TARGET.x, HOME_TARGET.y, HOME_TARGET.z);

    this.assets = new AnatomyAssetManager(this.renderer);
    this.buildEnvironment();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        this.isVisible = entry.isIntersecting;
        if (this.isVisible) this.dirty = true;
      },
      { rootMargin: "120px" },
    );
    this.intersectionObserver.observe(container);

    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.controls.addEventListener("start", this.onControlStart);
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("keydown", this.onKeyDown);

    this.resize();
    this.animate();
  }

  // ---------------------------------------------------------------- scene

  private buildEnvironment() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    this.scene.add(new THREE.HemisphereLight(0xfff8ee, 0x33252d, 0.72));

    const key = new THREE.DirectionalLight(0xfff3e7, 3.5);
    key.position.set(4.8, 6.5, 6.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe6ecff, 1.12);
    fill.position.set(-4.5, 1.2, 5.2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffb7a5, 1.6);
    rim.position.set(-4, 3.5, -5.5);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xff8d70, 0.72, 11, 2);
    warm.position.set(-3, -1.4, 3.5);
    this.scene.add(warm);
    const glow = new THREE.PointLight(0xee7c6a, 0.5, 8, 2);
    glow.name = "organ-glow";
    glow.position.set(2.8, 0.4, 2.8);
    this.scene.add(glow);

    this.scene.environment = this.buildEnvironmentMap();

    this.plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(2.3, 2.48, 0.34, 56),
      new THREE.MeshStandardMaterial({ color: 0xead7c1, roughness: 0.78, metalness: 0 }),
    );
    this.plinth.position.y = PLINTH_Y;
    this.scene.add(this.plinth);

    this.contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 4.2),
      new THREE.MeshBasicMaterial({
        map: contactShadowTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.62,
        toneMapped: false,
      }),
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.position.y = PLINTH_TOP + 0.005;
    this.contactShadow.renderOrder = 1;
    this.scene.add(this.contactShadow);

    const positions = new Float32Array(48 * 3);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = (Math.random() - 0.5) * 9;
      positions[i + 1] = (Math.random() - 0.5) * 6;
      positions[i + 2] = (Math.random() - 0.5) * 5 - 2;
    }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.scene.add(
      new THREE.Points(
        particleGeometry,
        new THREE.PointsMaterial({ color: 0xe7a18e, size: 0.013, transparent: true, opacity: 0.16 }),
      ),
    );
  }

  /** A tiny warm-to-cool gradient probe: better material response than a bare
   *  light rig, and it costs one PMREM bake instead of per-frame work. */
  private buildEnvironmentMap() {
    const width = 16;
    const height = 32;
    const data = new Uint8Array(width * height * 4);
    const top = new THREE.Color(0xfff3e4);
    const bottom = new THREE.Color(0x6b4f45);
    const mixed = new THREE.Color();
    for (let y = 0; y < height; y += 1) {
      mixed.copy(bottom).lerp(top, Math.pow(1 - y / (height - 1), 0.7));
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = mixed.r * 255;
        data[i + 1] = mixed.g * 255;
        data[i + 2] = mixed.b * 255;
        data[i + 3] = 255;
      }
    }
    const source = new THREE.DataTexture(data, width, height);
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.SRGBColorSpace;
    source.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = pmrem.fromEquirectangular(source).texture;
    pmrem.dispose();
    source.dispose();
    return environment;
  }

  // ---------------------------------------------------------------- organs

  prefetch(url: string) {
    this.assets.prefetch(url);
  }

  async setOrgan(modelUrl: string, hotspots: Hotspot[], accent: string, procedural?: ProceduralOrganFactory) {
    const request = ++this.loadRequest;
    this.select(null);
    this.xrayActive = false;
    this.xraySnapshot = [];
    this.conditionActive = false;
    this.conditionSnapshot = [];
    this.conditionGeomSnapshot = [];
    this.stopAqueousFlow();
    this.callbacks.onLoading(true, 0);

    const outgoing = this.organ;
    if (outgoing) {
      // Switching mid-fade would otherwise leave the tween running and the
      // depth proxies attached to a released organ.
      this.fadeTween?.kill();
      this.fadeTween = null;
      this.setDepthPrepass(outgoing, false);
      this.hotspots.clear();
      this.busy(0.8);
      await gsap.to(outgoing.pivot.scale, {
        x: 0.72, y: 0.72, z: 0.72,
        duration: 0.34,
        ease: "power2.in",
        onUpdate: () => (this.dirty = true),
      });
      if (this.procedural) {
        outgoing.pivot.removeFromParent();
        disposeObject(outgoing.pivot);
      } else {
        this.assets.release(outgoing);
      }
      this.organ = null;
      this.procedural = false;
      this.dirty = true;
    }

    this.tween(this.camera.position, { z: 9.2, duration: 0.42, ease: "power2.inOut" });

    let organ: LoadedOrgan;
    if (procedural) {
      // Procedural organs are already in FIT_SIZE space, so the loader's
      // normalise-to-fit pass is skipped entirely.
      organ = procedural();
    } else {
      try {
        organ = await this.assets.load(modelUrl, (progress) => {
          if (request === this.loadRequest) this.callbacks.onLoading(true, progress);
        });
      } catch (error) {
        if (request === this.loadRequest) this.callbacks.onLoading(false, 0);
        throw error;
      }
    }
    if (request !== this.loadRequest || this.disposed) {
      if (procedural) {
        disposeObject(organ.pivot);
      }
      return;
    }

    this.organ = organ;
    this.procedural = Boolean(procedural);
    if (!procedural) {
      this.applyAnatomyMaterials(organ);
      // Collector channels are decorative — never let them break the load.
      try {
        this.buildCollectorChannels(organ);
      } catch (error) {
        console.warn("collector channels skipped:", error);
      }
    }
    organ.pivot.scale.setScalar(1);
    organ.pivot.position.set(0, 0, 0);
    this.scene.add(organ.pivot);
    organ.pivot.updateWorldMatrix(true, true);

    // Anchor the dots while the organ is still invisible, then play the intro.
    this.hotspots.attach(organ.pivot, hotspots, organ.meshes);
    this.hotspots.setPixelSize(DOT_PIXELS, this.height, CAMERA_FOV);
    if (this.crossSection) this.applyClipping(true);

    const glow = this.scene.getObjectByName("organ-glow") as THREE.PointLight | undefined;
    glow?.color.set(accent);

    organ.pivot.scale.setScalar(0.58);
    organ.pivot.position.z = -1.3;
    this.busy(1.4);
    this.fade(organ, 1, 0.72);
    // The organ is on screen from here on, so the load is over as far as the UI
    // is concerned — the intro animation should play in the open, not behind a
    // loading panel.
    this.callbacks.onLoading(false, 1);
    gsap.timeline({ onUpdate: () => (this.dirty = true) })
      .to(organ.pivot.scale, { x: 1, y: 1, z: 1, duration: 0.9, ease: "back.out(1.25)" }, 0)
      .to(organ.pivot.position, { z: 0, duration: 0.85, ease: "power3.out" }, 0)
      .to(this.camera.position, { z: 8.2, duration: 0.9, ease: "power2.out" }, 0.08);
  }

  /** Replaces the HRA eye GLB's flat colours with procedural anatomical
   *  materials keyed by mesh name. Only runs for the eye-anatomy model, once
   *  per mesh (guard against cache-hit re-application). Pre-baked GLBs
   *  (`scripts/bake-eye.cjs`) already carry generated UVs and Loop-subdivided
   *  geometry — flagged `mesh.userData.baked` — so those two expensive passes
   *  are skipped at load time. */
  private applyAnatomyMaterials(organ: LoadedOrgan) {
    if (organ.url !== "/models/eye-anatomy.glb") return;
    organ.meshes.forEach((mesh) => {
      if (mesh.userData.anatomyTextured) return;
      const id = partIdForMesh(mesh.name || "");
      if (!id) return;
      if (!mesh.userData.baked) {
        // The GLB ships no UVs — project a fresh set by geometry kind so the
        // procedural pattern maps sensibly onto the surface. Choroid/retina
        // converge their vessel tree at the posterior pole (−Z, the optic disc).
        generatePartUVs(mesh, uvKindForPart(id), id === "choroid" || id === "retina");
        // One Loop-subdivision pass removes the polygonal faceting on the curved
        // shells so textures render smooth (4× faces, uvSmooth keeps UVs intact).
        smoothPartGeometry(mesh, id);
      }
      const previous = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const material = partMaterial(id);
      mesh.material = material;
      // Swap in photoreal external textures (sclera) when they finish loading.
      loadExternalTexture(id, material);
      previous.forEach((mat) => {
        Object.values(mat).forEach((value) => {
          if (value instanceof THREE.Texture) value.dispose();
        });
        mat.dispose();
      });
      mesh.userData.anatomyTextured = true;
    });
    this.dirty = true;
  }

  private materials(organ: LoadedOrgan) {
    const list: THREE.Material[] = [];
    organ.meshes.forEach((mesh) => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => list.includes(material) || list.push(material));
    });
    return list;
  }

  /**
   * Generates the 28 collector channels as fine lines leaving Schlemm's canal
   * (r = 1.00, the limbus inner edge) radially through the sclera to its
   * surface (r ≈ 1.55). Runtime-only: gltf-transform's draco pass drops Line
   * primitives, so baking would lose them. Distribution follows the
   * literature — 28 total, nasal-dominant (inferonasal densest).
   */
  private buildCollectorChannels(organ: LoadedOrgan) {
    if (organ.url !== "/models/eye-anatomy.glb") return;
    if (organ.meshes.some((m) => m.userData.layer === "VH_M_collector_channel_L")) return;
    const SC_R = 1.0;
    const END_R = 1.55;
    const Z = 1.22;
    // Deterministic tiny jitter so no two channels are perfectly aligned.
    const jitter = (seed: number) => ((seed * 37) % 11) - 5;
    const positions: number[] = [];
    const addLine = (thetaDeg: number, j: number) => {
      const a = THREE.MathUtils.degToRad(thetaDeg + j);
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(Math.cos(a) * SC_R, Math.sin(a) * SC_R, Z),
        new THREE.Vector3(Math.cos(a + 0.05) * (SC_R + 0.28), Math.sin(a + 0.05) * (SC_R + 0.28), Z + 0.03),
        new THREE.Vector3(Math.cos(a + 0.015) * END_R, Math.sin(a + 0.015) * END_R, Z + 0.015),
      ]);
      curve.getPoints(7).forEach((p) => positions.push(p.x, p.y, p.z));
    };
    // 0° = +X (nasal for the left eye), 90° = +Y, 180° = -X, 270° = -Y
    const pick = (start: number, end: number, n: number, base: number) => {
      for (let i = 0; i < n; i += 1) {
        addLine(start + ((i + 0.5) / n) * (end - start), jitter(base + i));
      }
    };
    pick(278, 352, 9, 1); // inferonasal: 10
    addLine(355, jitter(10)); // +1 near +X
    pick(12, 78, 6, 21);   // superonasal: 6
    pick(192, 258, 6, 41); // inferotemporal: 6
    pick(102, 168, 6, 61); // superotemporal: 6
    // getPoints(n) returns n+1 points (inclusive of both ends).
    if (positions.length / 3 !== 28 * 8) throw new Error("CC line count mismatch");
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd9c27a, transparent: true, opacity: 0.9 }));
    line.name = "VH_M_collector_channel_L";
    line.userData.layer = "VH_M_collector_channel_L";
    organ.pivot.add(line);
    organ.meshes.push(line as unknown as THREE.Mesh);
    this.dirty = true;
  }

  /**
   * Fades an organ in. Depth writing stays ON throughout: these are solid,
   * closed meshes, and letting them blend in draw order instead of depth order
   * makes the far side and interior show through the front for the length of
   * the tween. A depth prepass keeps the result identical to the opaque pass —
   * only the nearest surface is ever shaded.
   */
  private fade(organ: LoadedOrgan, to: number, duration: number) {
    const materials = this.materials(organ);
    const state = { value: to >= 1 ? 0 : 1 };
    materials.forEach((material) => {
      material.transparent = true;
      material.opacity = state.value;
      material.depthWrite = true;
    });
    this.setDepthPrepass(organ, true);
    this.busy(duration + 0.1);
    this.fadeTween = gsap.to(state, {
      value: to,
      duration,
      ease: "power2.out",
      onUpdate: () => {
        materials.forEach((material) => (material.opacity = state.value));
        this.dirty = true;
      },
      onComplete: () => {
        if (to >= 1) {
          materials.forEach((material) => {
            if (material.userData.proceduralTransparent) {
              // Transparent anatomy returns to its translucent default after
              // the intro fade (cornea 0.55, lens/vitreous/aqueous 0.5, ...).
              material.transparent = true;
              material.opacity = material.userData.defaultOpacity ?? 0.5;
            } else {
              material.transparent = false;
              material.opacity = 1;
            }
            material.depthWrite = material.userData.proceduralTransparent ? false : true;
          });
        }
        this.setDepthPrepass(organ, false);
        this.fadeTween = null;
        this.dirty = true;
      },
    });
  }

  /**
   * Lays down depth for the organ before it is shaded, so a partly transparent
   * mesh still resolves to a single nearest surface per pixel. The proxy is
   * parented to the mesh it mirrors, so it inherits the intro animation for
   * free. Opaque, therefore drawn before anything transparent. Alive only while
   * an organ fades; it costs one depth-only pass over ~120k triangles.
   */
  private setDepthPrepass(organ: LoadedOrgan, enabled: boolean) {
    organ.meshes.forEach((mesh) => {
      const existing = mesh.children.find((child) => child.name === DEPTH_PREPASS);
      if (!enabled) {
        existing?.removeFromParent();
        return;
      }
      if (existing) return;
      const proxy = new THREE.Mesh(mesh.geometry, this.depthMaterial);
      proxy.name = DEPTH_PREPASS;
      proxy.frustumCulled = mesh.frustumCulled;
      mesh.add(proxy);
    });
  }

  // ---------------------------------------------------------------- loop

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    if (!this.isVisible || !this.isPageVisible) return;

    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();

    this.applyAutoRotate(now);
    if (this.controls.update(delta)) this.dirty = true;
    if (this.assets.hasAnimation) {
      this.assets.update(delta);
      this.dirty = true;
    }
    if (this.flowActive) this.updateAqueousFlow(delta);
    if (this.hoverProbe) this.resolveHover();
    if (!this.dirty && now >= this.busyUntil) return;

    if (!this.hotspots.update(this.camera, delta, this.selectedId, this.hoveredId)) this.dirty = true;
    else this.dirty = false;
    if (now < this.busyUntil) this.dirty = true;

    this.positionCallout();
    this.renderer.render(this.scene, this.camera);
  };

  private busy(seconds: number) {
    this.busyUntil = Math.max(this.busyUntil, performance.now() + seconds * 1000);
    this.dirty = true;
  }

  private tween(target: object, vars: gsap.TweenVars) {
    this.busy((vars.duration as number) ?? 0.5);
    return gsap.to(target, { ...vars, onUpdate: () => (this.dirty = true) });
  }

  private applyAutoRotate(now: number) {
    this.controls.autoRotate = this.autoRotateWanted && !this.quizActive && !this.tourActive && !this.selectedId && now >= this.interactionUntil;
  }

  private onVisibilityChange = () => {
    this.isPageVisible = !document.hidden;
    if (this.isPageVisible) {
      this.clock.start();
      this.dirty = true;
    }
  };

  private resize() {
    this.width = Math.max(this.container.clientWidth, 1);
    this.height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.hotspots.setPixelSize(DOT_PIXELS, this.height, CAMERA_FOV);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- input

  private onControlStart = () => {
    this.interactionUntil = performance.now() + 3000;
    this.dirty = true;
  };

  private onPointerDown = (event: PointerEvent) => {
    this.pointerId = event.pointerId;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    this.dragged = false;
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.pointerId !== null) {
      if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) this.dragged = true;
      return;
    }
    this.hoverProbe = { x: event.offsetX, y: event.offsetY };
    this.dirty = true;
  };

  private onPointerUp = (event: PointerEvent) => {
    const wasDragging = this.dragged;
    this.pointerId = null;
    this.dragged = false;
    if (wasDragging) return;
    if (this.quizActive) {
      // Quiz mode: the click picks a structure mesh, not a hotspot dot.
      const layerId = this.pickLayerAt(event.offsetX, event.offsetY);
      this.onQuizPick?.(layerId);
      return;
    }
    if (this.tourActive) return; // Tour owns the scene; plain clicks do nothing.
    const marker = this.hotspots.pick(event.offsetX, event.offsetY, this.camera, this.width, this.height);
    this.select(marker && marker.hotspot.id !== this.selectedId ? marker.hotspot.id : null);
  };

  private onPointerLeave = () => {
    this.pointerId = null;
    this.hoverProbe = null;
    if (this.hoveredId) {
      this.hoveredId = null;
      this.dirty = true;
    }
  };

  private resolveHover() {
    if (this.quizActive || this.tourActive) return;
    const probe = this.hoverProbe;
    this.hoverProbe = null;
    if (!probe) return;
    const marker = this.hotspots.pick(probe.x, probe.y, this.camera, this.width, this.height);
    const id = marker?.hotspot.id ?? null;
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "";
    this.dirty = true;
  }

  private select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.busy(0.4);
    const marker = this.hotspots.list.find((item) => item.hotspot.id === id);
    this.callbacks.onSelect(marker?.hotspot ?? null);
  }

  clearSelection() {
    this.select(null);
  }

  /** The callout is positioned imperatively so tracking a spinning model never
   *  triggers a React render. */
  attachCallout(element: HTMLElement | null) {
    this.calloutEl = element;
    this.positionCallout();
    this.dirty = true;
  }

  private positionCallout() {
    if (!this.calloutEl || !this.selectedId) return;
    const point = this.hotspots.screenPosition(this.selectedId, this.camera, this.width, this.height);
    if (!point) return;
    this.calloutEl.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
    this.calloutEl.dataset.side = point.x > this.width * 0.6 ? "left" : "right";
    this.calloutEl.dataset.behind = point.opacity < 0.3 ? "true" : "false";
  }

  private onKeyDown = (event: KeyboardEvent) => {
    const pivot = this.organ?.pivot;
    if (event.key === "ArrowLeft" && pivot) pivot.rotation.y -= 0.08;
    if (event.key === "ArrowRight" && pivot) pivot.rotation.y += 0.08;
    if (event.key === "+") this.camera.position.z = Math.max(4.8, this.camera.position.z - 0.35);
    if (event.key === "-") this.camera.position.z = Math.min(12, this.camera.position.z + 0.35);
    if (event.key === "Escape") this.select(null);
    this.dirty = true;
  };

  // ---------------------------------------------------------------- tools

  setAutoRotate(enabled: boolean) {
    this.autoRotateWanted = enabled;
    if (enabled) this.interactionUntil = 0;
    this.dirty = true;
  }

  reset() {
    this.select(null);
    this.tween(this.camera.position, { ...HOME_CAMERA, duration: 0.8, ease: "power3.out" });
    this.tween(this.controls.target, { ...HOME_TARGET, duration: 0.8, ease: "power3.out" });
    if (this.organ) this.tween(this.organ.pivot.rotation, { x: 0.05, y: -0.28, z: 0, duration: 0.8, ease: "power3.out" });
  }

  zoom(direction: 1 | -1) {
    this.tween(this.camera.position, {
      z: THREE.MathUtils.clamp(this.camera.position.z + direction * 1.2, 4.8, 12),
      duration: 0.5,
      ease: "power2.out",
    });
  }

  toggleIsolate() {
    this.isolated = !this.isolated;
    const plinth = this.plinth.material as THREE.MeshStandardMaterial;
    plinth.transparent = true;
    this.tween(plinth, { opacity: this.isolated ? 0.15 : 1, duration: 0.45 });
    this.tween(this.contactShadow.material, { opacity: this.isolated ? 0.08 : 0.55, duration: 0.45 });
    return this.isolated;
  }

  toggleCrossSection() {
    this.crossSection = !this.crossSection;
    this.applyClipping(this.crossSection);
    gsap.fromTo(
      this.clipPlane,
      { constant: -1.8 },
      {
        constant: this.crossSection ? 0 : -1.8,
        duration: 0.85,
        ease: "power2.inOut",
        onUpdate: () => (this.dirty = true),
      },
    );
    this.busy(0.95);
    return this.crossSection;
  }

  private applyClipping(enabled: boolean) {
    if (!this.organ) return;
    const planes = enabled ? [this.clipPlane] : null;
    [...this.materials(this.organ), this.depthMaterial].forEach((material) => {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    });
    this.dirty = true;
  }

  /** Drags the active cross-section plane along the view axis. Range roughly
   *  ±2.4 world units (the eye spans ±1.9), so the cut can sweep through the
   *  whole specimen. */
  setCrossSectionDepth(offset: number) {
    if (!this.crossSection) return;
    this.clipPlane.constant = THREE.MathUtils.clamp(offset, -2.4, 2.4);
    this.dirty = true;
  }

  /** Tilts the active cross-section plane around the vertical (Y) axis, so the
   *  cut can be swept from the sagittal plane through oblique to frontal. */
  setCrossSectionAngle(degrees: number) {
    if (!this.crossSection) return;
    const rad = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(degrees, -85, 85));
    // Base normal is (-1, 0, 0); rotate it around Y for an adjustable cut angle.
    this.clipPlane.normal.set(-Math.cos(rad), 0, Math.sin(rad)).normalize();
    this.dirty = true;
  }

  toggleLayers() {
    if (!this.organ) return false;
    let enabled = false;
    this.materials(this.organ).forEach((material) => {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.wireframe = !material.wireframe;
        enabled = material.wireframe;
      }
    });
    this.dirty = true;
    return enabled;
  }

  /** Shows or hides one named layer of a procedural organ (e.g. the eye's
   *  sclera). GLB organs match by exact mesh name so the HRA anatomy model's
   *  per-structure meshes can be peeled apart too. */
  setLayerVisible(layerId: string, visible: boolean) {
    if (this.quizActive || this.tourActive) return;
    if (!this.organ) return;
    this.organ.meshes.forEach((mesh) => {
      if (mesh.userData.layer === layerId || (mesh.name || "") === layerId) {
        mesh.visible = visible;
      }
    });
    this.dirty = true;
  }

  /** Sets the opacity of one structure's material (0–1). Transparent anatomy
   *  keeps its transparency flag; the slider drives the actual opacity. */
  setLayerOpacity(layerId: string, opacity: number) {
    if (this.quizActive || this.tourActive) return;
    if (!this.organ) return;
    const value = THREE.MathUtils.clamp(opacity, 0, 1);
    this.organ.meshes.forEach((mesh) => {
      if (mesh.userData.layer !== layerId && (mesh.name || "") !== layerId) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!material) return;
      material.opacity = value;
      // Only genuinely translucent structures stay in the transparent pass.
      // Opaque layers must return to transparent=false once the slider is at
      // 100% — otherwise every layer renders blended and the whole eye goes
      // hazy-grey.
      if (value >= 1 && !material.userData.proceduralTransparent) {
        material.transparent = false;
      } else {
        material.transparent = true;
      }
      material.needsUpdate = true;
      // A fully-transparent layer is effectively hidden — keep visible true so
      // the slider can bring it back smoothly.
      mesh.visible = true;
    });
    this.dirty = true;
  }

  /** Hides every mesh except those whose layer id / name is in `visibleIds`.
   *  Used by the anterior-segment mode to focus the HRA model on the outflow
   *  pathway structures. */
  setOnlyLayersVisible(visibleIds: string[]) {
    if (this.quizActive || this.tourActive) return;
    if (!this.organ) return;
    const keep = new Set(visibleIds);
    this.organ.meshes.forEach((mesh) => {
      const id = mesh.userData.layer || mesh.name || "";
      mesh.visible = keep.has(id);
    });
    this.dirty = true;
  }

  private highlightedLayer: string | null = null;

  // ---------------------------------------------------------------- tour
  /** True while the guided tour owns the scene: rail tools and hotspot clicks
   *  blocked, auto-rotate paused, highlight state driven by tourStep. */
  private tourActive = false;

  /** Puts the viewer into guided-tour mode: clears any selection and highlight
   *  so the tour owns the scene. Dots stay visible — they help the learner
   *  locate each narrated structure. */
  beginTour() {
    if (this.tourActive || !this.organ) return;
    this.stopAqueousFlow();
    this.tourActive = true;
    this.applyClearHighlight();
    this.select(null);
    this.dirty = true;
  }

  /** Leaves guided-tour mode and restores normal interactions. */
  endTour() {
    if (!this.tourActive) return;
    this.tourActive = false;
    this.applyClearHighlight();
    this.dirty = true;
  }

  /** Moves the tour to one structure: dims the rest of the eye around it and
   *  swings the camera so the structure fills the frame. */
  tourStep(layerId: string) {
    if (!this.tourActive || !this.organ) return;
    this.applyHighlight(layerId, 1);
    this.focusLayer(layerId);
  }

  // ---------------------------------------------------------------- conditions
  /** Geometry-level deformations for conditions that change shape, not just
   *  material. Each entry names the mesh to deform; positions are restored
   *  verbatim on clearCondition. */
  private static readonly CONDITION_GEOMETRY: Record<string, { meshName: string; deform: (mesh: THREE.Mesh) => void }[]> = {
    detachment: [{ meshName: "VH_M_retina_L", deform: deformRetinaDetachment }],
    glaucoma: [{ meshName: "VH_M_optic_disc_L", deform: deformOpticCup }],
    cataract: [{ meshName: "VH_M_lens_L", deform: deformLensSwelling }],
  };

  /** Material-level simulation of a clinical condition. Effects are teaching
   *  approximations: colour/opacity shifts on the affected structures. */
  private static readonly CONDITION_EFFECTS: Record<string, { layers: Record<string, { opacity?: number; color?: number; emissive?: number; emissiveIntensity?: number }> }> = {
    cataract: {
      // The lens turns from transparent to milky and loses transparency.
      layers: { VH_M_lens_L: { opacity: 0.18, color: 0xded7c8, emissive: 0xffffff, emissiveIntensity: 0.07 } },
    },
    glaucoma: {
      // Elevated pressure: the optic disc cup deepens and pales.
      layers: {
        VH_M_optic_disc_L: { color: 0x2c2722, emissive: 0x000000 },
        VH_M_retina_L: { color: 0xcfc3b6, opacity: 0.9 },
      },
    },
    amd: {
      // Drusen + atrophy: the macula and fovea dull and yellow.
      layers: {
        VH_M_macula_lutea_L: { color: 0x948a6e },
        VH_M_fovea_L: { color: 0x6a6452 },
        VH_M_optic_choroid_L: { color: 0x4e1620 },
      },
    },
    detachment: {
      // The neurosensory retina lifts: it pales and turns translucent.
      layers: {
        VH_M_retina_L: { opacity: 0.5, color: 0xcbc2b8, emissive: 0x8a8179, emissiveIntensity: 0.16 },
        VH_M_optic_choroid_L: { color: 0x3d0f18 },
      },
    },
  };

  private conditionActive = false;
  private conditionSnapshot: {
    mesh: THREE.Mesh; color: THREE.Color | null; opacity: number; transparent: boolean;
    emissive: THREE.Color | null; emissiveIntensity: number;
  }[] = [];
  /** Original vertex arrays of meshes deformed by a condition, for restore. */
  private conditionGeomSnapshot: { mesh: THREE.Mesh; positions: Float32Array | null }[] = [];
  /** Camera state captured when a condition is applied, restored on clear so
   *  the user returns to the pre-condition view. */
  private conditionCamera: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;

  /** Applies a condition's material simulation (switches if another is on).
   *  Returns true when the condition became active. */
  applyCondition(conditionId: string): boolean {
    if (!this.organ || this.quizActive || this.tourActive) return false;
    const effect = AnatomyViewer.CONDITION_EFFECTS[conditionId];
    if (!effect) return false;
    if (this.conditionActive) {
      // Switching conditions: restore without flying the camera, so the saved
      // camera below stays the original pre-condition view.
      this.conditionActive = false;
      this.restoreConditionState();
    }
    // Remember where the user was looking so clearing returns them there.
    if (!this.conditionCamera) {
      this.conditionCamera = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
      };
    }
    this.conditionActive = true;
    const layerIds = new Set(Object.keys(effect.layers));
    this.conditionSnapshot = this.organ.meshes
      .filter((mesh) => layerIds.has(mesh.userData.layer) || layerIds.has(mesh.name || ""))
      .map((mesh) => {
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        return {
          mesh,
          color: material && "color" in material ? (material as THREE.MeshStandardMaterial).color.clone() : null,
          opacity: material?.opacity ?? 1,
          transparent: material?.transparent ?? false,
          emissive: material && "emissive" in material ? (material as THREE.MeshStandardMaterial).emissive.clone() : null,
          emissiveIntensity: material && "emissive" in material ? (material as THREE.MeshStandardMaterial).emissiveIntensity : 0,
        };
      });
    this.conditionSnapshot.forEach((snap) => {
      const material = Array.isArray(snap.mesh.material) ? snap.mesh.material[0] : snap.mesh.material;
      if (!material) return;
      const layerId = snap.mesh.userData.layer || snap.mesh.name || "";
      const def = effect.layers[layerId];
      if (!def) return;
      if (def.opacity !== undefined) { material.opacity = def.opacity; material.transparent = true; }
      if (def.color !== undefined && "color" in material) (material as THREE.MeshStandardMaterial).color.setHex(def.color);
      if (def.emissive !== undefined && "emissive" in material) {
        (material as THREE.MeshStandardMaterial).emissive.setHex(def.emissive);
        (material as THREE.MeshStandardMaterial).emissiveIntensity = def.emissiveIntensity ?? 0.5;
      }
      material.needsUpdate = true;
    });
    // Geometry-level deformation (retina lift, optic cup, lens swelling).
    const geometryJobs = AnatomyViewer.CONDITION_GEOMETRY[conditionId] ?? [];
    this.conditionGeomSnapshot = [];
    for (const job of geometryJobs) {
      const mesh = this.organ.meshes.find(
        (m) => (m.name || "") === job.meshName || (m.userData.layer || "") === job.meshName,
      );
      if (!mesh) continue;
      const attribute = mesh.geometry.getAttribute("position");
      if (!attribute) continue;
      this.conditionGeomSnapshot.push({ mesh, positions: (attribute.array as Float32Array).slice() });
      job.deform(mesh);
    }
    this.dirty = true;
    return true;
  }

  /** Restores the pre-condition material + geometry state, without touching
   *  the camera. Used both by clearCondition and when switching to another
   *  condition (so the camera snapshot stays meaningful). */
  private restoreConditionState() {
    this.conditionSnapshot.forEach((snap) => {
      const material = Array.isArray(snap.mesh.material) ? snap.mesh.material[0] : snap.mesh.material;
      if (!material) return;
      if (snap.color && "color" in material) (material as THREE.MeshStandardMaterial).color.copy(snap.color);
      material.opacity = snap.opacity;
      material.transparent = snap.transparent;
      if (snap.emissive && "emissive" in material) {
        (material as THREE.MeshStandardMaterial).emissive.copy(snap.emissive);
        (material as THREE.MeshStandardMaterial).emissiveIntensity = snap.emissiveIntensity;
      }
      material.needsUpdate = true;
    });
    this.conditionSnapshot = [];
    // Restore any deformed geometry.
    this.conditionGeomSnapshot.forEach(({ mesh, positions }) => {
      if (!positions) return;
      const attribute = mesh.geometry.getAttribute("position");
      if (attribute) {
        (attribute.array as Float32Array).set(positions);
        attribute.needsUpdate = true;
      }
      mesh.geometry.computeVertexNormals();
    });
    this.conditionGeomSnapshot = [];
  }

  /** Restores the pre-condition state and flies the camera back to where the
   *  user was looking before the condition was applied. */
  clearCondition() {
    if (!this.conditionActive) return;
    this.conditionActive = false;
    this.restoreConditionState();
    // Return to the pre-condition view.
    if (this.conditionCamera) {
      const saved = this.conditionCamera;
      this.conditionCamera = null;
      this.tween(this.camera.position, {
        x: saved.position.x, y: saved.position.y, z: saved.position.z,
        duration: 0.7, ease: "power2.out",
      });
      this.tween(this.controls.target, {
        x: saved.target.x, y: saved.target.y, z: saved.target.z,
        duration: 0.7, ease: "power2.out",
      });
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- aqueous flow
  /** Aqueous humour flow animation: tiny points travel from the ciliary body,
   *  through the pupil, into the anterior chamber, and around Schlemm's canal
   *  — the real production→drainage path of the aqueous humour. */
  private flowActive = false;
  private flowPoints: THREE.Points | null = null;
  private flowCurve: THREE.CatmullRomCurve3 | null = null;
  private flowOffsets: number[] = [];
  private flowTime = 0;

  toggleAqueousFlow(): boolean {
    if (!this.organ || this.quizActive || this.tourActive) return false;
    if (this.flowActive) {
      this.stopAqueousFlow();
      return false;
    }
    this.flowActive = true;
    // Aqueous path, in the model's actual FIT_SIZE coordinates:
    // +Z = front (cornea at z≈1.9), -Z = back (retina at z≈-1.78);
    // ciliary body [0.85,0,0.92] produces → posterior chamber → pupil
    // [0,0,1.1] → anterior chamber → iridocorneal angle → trabecular
    // meshwork [0,-0.855,0] → Schlemm's canal [0,-0.285,0] (both below).
    this.flowCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.7, 0.2, 0.8),    // ciliary body (production site)
      new THREE.Vector3(0.35, 0.1, 0.95),  // posterior chamber (behind iris)
      new THREE.Vector3(0.0, 0.0, 1.12),   // through the pupil
      new THREE.Vector3(0.15, -0.1, 1.4),  // anterior chamber (in front of iris)
      new THREE.Vector3(0.3, -0.5, 0.85),  // iridocorneal angle (down)
      new THREE.Vector3(0.1, -0.8, 0.35),  // trabecular meshwork
      new THREE.Vector3(0.0, -0.55, 0.05), // Schlemm's canal (circumferential)
    ]);
    const count = 40;
    this.flowOffsets = Array.from({ length: count }, (_, i) => i / count);
    const positions = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x4aa8d8,
      size: 0.17,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      // Teaching glyph: keep the flow visible through the eye's outer shells.
      depthTest: false,
    });
    this.flowPoints = new THREE.Points(geometry, material);
    this.flowPoints.frustumCulled = false;
    this.scene.add(this.flowPoints);
    this.flowTime = 0;
    this.updateAqueousFlow(0);
    this.dirty = true;
    return true;
  }

  private stopAqueousFlow() {
    this.flowActive = false;
    if (this.flowPoints) {
      this.scene.remove(this.flowPoints);
      this.flowPoints.geometry.dispose();
      (this.flowPoints.material as THREE.Material).dispose();
      this.flowPoints = null;
    }
    this.flowCurve = null;
    this.dirty = true;
  }

  private updateAqueousFlow(delta: number) {
    if (!this.flowPoints || !this.flowCurve) return;
    this.flowTime = (this.flowTime + delta * 0.13) % 1; // full loop ≈ 7.7s
    const positions = this.flowPoints.geometry.attributes.position.array as Float32Array;
    const point = new THREE.Vector3();
    for (let i = 0; i < this.flowOffsets.length; i += 1) {
      const t = (this.flowOffsets[i] + this.flowTime) % 1;
      this.flowCurve.getPoint(t, point);
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;
    }
    this.flowPoints.geometry.attributes.position.needsUpdate = true;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- x-ray
  /** True while X-Ray mode dims every layer so the inner structures show. */
  private xrayActive = false;
  private xraySnapshot: { mesh: THREE.Mesh; opacity: number; transparent: boolean }[] = [];

  /** X-Ray mode: drops every layer to ~12% opacity so the inner eye reads
   *  through the outer shells. Snapshot restores on toggle-off. */
  toggleXRay(): boolean {
    if (!this.organ || this.quizActive || this.tourActive) return false;
    if (!this.xrayActive) {
      this.xrayActive = true;
      this.applyClearHighlight();
      this.select(null);
      this.xraySnapshot = this.organ.meshes.map((mesh) => {
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        return { mesh, opacity: material?.opacity ?? 1, transparent: material?.transparent ?? false };
      });
      this.xraySnapshot.forEach(({ mesh }) => {
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!material) return;
        material.opacity = 0.12;
        material.transparent = true;
        material.needsUpdate = true;
      });
    } else {
      this.xrayActive = false;
      this.xraySnapshot.forEach((snap) => {
        const material = Array.isArray(snap.mesh.material) ? snap.mesh.material[0] : snap.mesh.material;
        if (!material) return;
        material.opacity = snap.opacity;
        material.transparent = snap.transparent;
        material.needsUpdate = true;
      });
      this.xraySnapshot = [];
    }
    this.dirty = true;
    return this.xrayActive;
  }

  // ---------------------------------------------------------------- quiz
  /** True while the interactive 3D quiz owns the scene: dots hidden, every
   *  layer visible, raycast picking on pointer up, rail tools blocked. */
  private quizActive = false;
  /** Fired after a pointer-up raycast while the quiz is active. Receives the
   *  clicked layer id (or null when the click missed every mesh). */
  onQuizPick: ((layerId: string | null) => void) | null = null;
  private raycaster = new THREE.Raycaster();
  /** Material/mesh state captured on beginQuiz, restored on endQuiz. */
  private quizSnapshot: { mesh: THREE.Mesh; visible: boolean; opacity: number; transparent: boolean; emissive: THREE.Color; emissiveIntensity: number }[] = [];
  private quizCamera: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private quizFlashTweens: gsap.core.Tween[] = [];
  private readonly quizFlashColor = { correct: 0x3ddc84, wrong: 0xff5d5d } as const;

  /** Puts the viewer into quiz mode: hides the answer-dot layer, forces every
   *  layer visible, pauses auto-rotate, and captures state for restore. */
  beginQuiz() {
    if (this.quizActive || !this.organ) return;
    this.stopAqueousFlow();
    this.quizActive = true;
    this.quizSnapshot = this.organ.meshes.map((mesh) => {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      return {
        mesh,
        visible: mesh.visible,
        opacity: material?.opacity ?? 1,
        transparent: material?.transparent ?? false,
        emissive: new THREE.Color(material && "emissive" in material ? (material as THREE.MeshStandardMaterial).emissive : 0x000000),
        emissiveIntensity: material && "emissive" in material ? (material as THREE.MeshStandardMaterial).emissiveIntensity : 0,
      };
    });
    this.quizCamera = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    this.quizSnapshot.forEach(({ mesh }) => (mesh.visible = true));
    this.applyClearHighlight();
    this.select(null);
    this.hotspots.setVisible(false);
    this.dirty = true;
  }

  /** Leaves quiz mode and restores the captured scene state. */
  endQuiz() {
    if (!this.quizActive) return;
    this.quizActive = false;
    this.onQuizPick = null;
    this.quizFlashTweens.forEach((tween) => tween.kill());
    this.quizFlashTweens = [];
    this.quizSnapshot.forEach((snap) => {
      snap.mesh.visible = snap.visible;
      const material = Array.isArray(snap.mesh.material) ? snap.mesh.material[0] : snap.mesh.material;
      if (!material) return;
      material.opacity = snap.opacity;
      material.transparent = snap.transparent;
      if ("emissive" in material) {
        (material as THREE.MeshStandardMaterial).emissive.copy(snap.emissive);
        (material as THREE.MeshStandardMaterial).emissiveIntensity = snap.emissiveIntensity;
      }
      material.needsUpdate = true;
    });
    this.quizSnapshot = [];
    this.hotspots.setVisible(true);
    if (this.quizCamera) {
      this.tween(this.camera.position, { x: this.quizCamera.position.x, y: this.quizCamera.position.y, z: this.quizCamera.position.z, duration: 0.7, ease: "power2.out" });
      this.tween(this.controls.target, { x: this.quizCamera.target.x, y: this.quizCamera.target.y, z: this.quizCamera.target.z, duration: 0.7, ease: "power2.out" });
      this.quizCamera = null;
    }
    this.dirty = true;
  }

  /** Applies the current question's visual state: identify highlights the
   *  target structure, find leaves the model neutral. Both frame the structure
   *  so it is easy to locate. */
  quizSetQuestion(targetLayerId: string, mode: QuizMode) {
    if (!this.quizActive) return;
    this.applyClearHighlight();
    if (mode === "identify") this.applyHighlight(targetLayerId, 1);
    this.focusLayer(targetLayerId);
  }

  /** Gently swings the camera so the given structure fills the frame. */
  focusLayer(layerId: string) {
    if (!this.organ) return;
    const box = new THREE.Box3();
    let found = false;
    this.organ.meshes.forEach((mesh) => {
      if (mesh.userData.layer !== layerId && (mesh.name || "") !== layerId) return;
      if (!mesh.visible) return;
      box.expandByObject(mesh);
      found = true;
    });
    if (!found) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.15);
    const direction = center.lengthSq() > 1e-4 ? center.clone().normalize() : new THREE.Vector3(0, 0, 1);
    const distance = THREE.MathUtils.clamp(radius * 3.4 + 1.6, 4.8, 10.5);
    const target = center.clone();
    this.tween(this.controls.target, { x: target.x, y: target.y, z: target.z, duration: 0.7, ease: "power2.out" });
    this.tween(this.camera.position, {
      x: target.x + direction.x * distance,
      y: target.y + direction.y * distance,
      z: target.z + direction.z * distance,
      duration: 0.7,
      ease: "power2.out",
    });
  }

  /** Raycasts the organ meshes under a canvas point and returns the layer id
   *  of the nearest hit (mesh name for GLB anatomy models). */
  pickLayerAt(x: number, y: number): string | null {
    if (!this.organ) return null;
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.organ.meshes, false);
    for (const hit of hits) {
      const mesh = hit.object as THREE.Mesh;
      if (!mesh.visible) continue;
      const id = mesh.userData.layer || mesh.name || "";
      if (id) return id;
    }
    return null;
  }

  /** Flashes every mesh of a layer green (correct) or red (wrong), fading
   *  back over about a second. */
  quizFlashLayer(layerId: string, kind: "correct" | "wrong") {
    if (!this.organ) return;
    const color = new THREE.Color(this.quizFlashColor[kind]);
    this.organ.meshes.forEach((mesh) => {
      if (mesh.userData.layer !== layerId && (mesh.name || "") !== layerId) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!material || !("emissive" in material)) return;
      const standard = material as THREE.MeshStandardMaterial;
      standard.emissive.copy(color);
      standard.emissiveIntensity = 0.85;
      material.needsUpdate = true;
      const state = { intensity: 0.85 };
      const tween = gsap.to(state, {
        intensity: 0,
        duration: 1.05,
        ease: "power2.out",
        onUpdate: () => {
          standard.emissiveIntensity = state.intensity;
          this.dirty = true;
        },
      });
      this.quizFlashTweens.push(tween);
    });
    this.dirty = true;
  }

  /** Emphasises one structure (from the left rail): it stays at its natural
   *  opacity (transparent structures stay see-through) while the rest of the
   *  eye dims, so the selected layer reads instantly. Blocked during the quiz,
   *  which owns the highlight state. */
  highlightLayer(layerId: string, selectedOpacity = 1) {
    if (this.quizActive || this.tourActive) return;
    // Rail selection dims the rest of the eye harder (0.05) and only adds a
    // faint glow, so dark layers (e.g. the choroid) keep their true colour
    // instead of washing out to pink under a white emissive.
    this.applyHighlight(layerId, selectedOpacity, 0.05, 0.05);
  }

  private applyHighlight(layerId: string, selectedOpacity: number, dimOpacity = 0.18, glow = 0.22) {
    if (!this.organ) return;
    this.highlightedLayer = layerId;
    this.organ.meshes.forEach((mesh) => {
      const id = mesh.userData.layer || mesh.name || "";
      const target = id === layerId;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!material) return;
      // Dim the background, but keep the selected layer at its own opacity.
      material.opacity = target ? selectedOpacity : dimOpacity;
      material.transparent = true;
      // A dimmed layer must not keep writing depth: it would occlude the
      // highlighted layer sitting behind it (e.g. the choroid behind the
      // iris). Remember the original value so the clear path can restore it.
      if (!target) {
        material.userData.dimDepthWrite ??= material.depthWrite;
        material.depthWrite = false;
      } else {
        material.depthWrite = material.userData.dimDepthWrite ?? material.depthWrite;
      }
      material.needsUpdate = true;
      if (target && "emissive" in material) {
        (material as THREE.MeshStandardMaterial).emissive.set(0xffffff);
        (material as THREE.MeshStandardMaterial).emissiveIntensity = glow;
      }
    });
    this.dirty = true;
  }

  /** Restores full opacity after the structure rail selection clears. */
  clearLayerHighlight() {
    if (this.quizActive || this.tourActive) return;
    this.applyClearHighlight();
  }

  private applyClearHighlight() {
    if (!this.organ || !this.highlightedLayer) return;
    this.highlightedLayer = null;
    this.organ.meshes.forEach((mesh) => {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!material) return;
      // Transparent anatomy returns to its translucent default; opaque layers
      // go fully opaque.
      material.opacity = material.userData.proceduralTransparent
        ? (material.userData.defaultOpacity ?? 0.5)
        : 1;
      material.transparent = material.userData.proceduralTransparent || material.opacity < 1;
      if (material.userData.dimDepthWrite !== undefined) {
        material.depthWrite = material.userData.dimDepthWrite;
        delete material.userData.dimDepthWrite;
      }
      material.needsUpdate = true;
      if ("emissive" in material) {
        (material as THREE.MeshStandardMaterial).emissive.set(0x000000);
        (material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
      }
    });
    this.dirty = true;
  }

  dispose() {
    this.disposed = true;
    this.loadRequest += 1;
    this.stopAqueousFlow();
    this.quizFlashTweens.forEach((tween) => tween.kill());
    this.quizFlashTweens = [];
    cancelAnimationFrame(this.frame);
    gsap.killTweensOf(this.camera.position);
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.dispose();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("keydown", this.onKeyDown);

    this.hotspots.dispose();
    this.depthMaterial.dispose();
    if (this.organ && this.procedural) {
      this.organ.pivot.removeFromParent();
      disposeObject(this.organ.pivot);
      this.organ = null;
    }
    this.assets.dispose();
    this.scene.environment?.dispose();
    (this.contactShadow.material as THREE.MeshBasicMaterial).map?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}

function contactShadowTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size * 0.5);
  gradient.addColorStop(0, "rgba(94, 62, 42, 0.62)");
  gradient.addColorStop(0.45, "rgba(94, 62, 42, 0.26)");
  gradient.addColorStop(1, "rgba(94, 62, 42, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
