export type OrganId = "eyeball";

export type Hotspot = {
  id: string;
  label: string;
  detail: string;
  position: [number, number, number];
  color: string;
};

export type OrganLayer = {
  id: string;
  label: string;
  color: string;
  /** True when the structure is naturally translucent (cornea, lens, aqueous,
   *  vitreous, zonules). Shown with a ◐ badge in the structure rail. */
  transparent?: boolean;
  /** Default opacity for translucent structures (0–1). Opaque layers default
   *  to 1. The user can override this per layer with the opacity slider. */
  defaultOpacity?: number;
};

/** A named group of peelable layers (e.g. "Anterior segment"), rendered as a
 *  section header above its layer chips. */
export type OrganLayerGroup = {
  group: string;
  layers: OrganLayer[];
};

/** How a 3D quiz question is answered:
 *  - "identify": the structure is highlighted in the model and the learner
 *    clicks it to confirm what it is (guided name↔location association).
 *  - "find": only the name is given; the learner locates and clicks the
 *    structure among all the visible layers (knowledge test). */
export type QuizMode = "identify" | "find";

export type QuizQuestion = {
  id: string;
  mode: QuizMode;
  /** The correct answer, as a peelable layer id (`VH_M_...`). */
  answerLayerId: string;
  /** Shown while the learner is answering. Written as a clue, not the answer. */
  prompt: string;
  /** Educational explanation revealed after answering. */
  explain: string;
};

/** One stop on the guided anatomy tour. The viewer swings the camera to
 *  `layerId`, dims the rest of the eye, and narrates `body`. */
export type TourStep = {
  id: string;
  /** The structure this stop focuses, as a peelable layer id (`VH_M_...`). */
  layerId: string;
  /** Short heading for the step, e.g. "Cornea". */
  title: string;
  /** Narration shown beside the highlighted structure. */
  body: string;
};

export type Organ = {
  id: OrganId;
  name: string;
  scientificName: string;
  system: string;
  model: string;
  /** When set, the 3D viewer builds the organ procedurally (`"eye"` for the
   *  layered eyeball) instead of loading `model`. */
  procedural?: "eye";
  /** Optional fine anatomical GLB model (e.g. BodyParts3D cross-section),
   *  loaded in the "anatomy" viewer mode. */
  anatomyModel?: string;
  /** Optional procedural factory marker for the anterior-segment outflow
   *  pathway, shown as a third viewer mode. */
  anteriorSegment?: boolean;
  /** Optional real-mesh GLB for the anterior outflow pathway. Retained for
   *  future use (e.g. a complete COMSOL mesh once available); the current
   *  anterior mode renders `anatomyModel` with `anteriorLayerIds` only. */
  anteriorModel?: string;
  /** Hotspots used in the anterior-segment (outflow) viewer mode, when the
   *  procedural geometry differs from the main organ hotspots. */
  anteriorHotspots?: Hotspot[];
  /** Layer ids to keep visible in the anterior-segment (outflow) viewer mode;
   *  all other layers are hidden. When set, the anterior mode renders the
   *  `anatomyModel` with only these structures shown. */
  anteriorLayerIds?: string[];
  /** Peelable layers, shown as toggles when the viewer is procedural. */
  layers?: OrganLayer[];
  /** Optional grouping of `layers` by anatomical system, rendered as section
   *  headers in the layer panel (flat `layers` is used when absent). */
  layerGroups?: OrganLayerGroup[];
  /** Interactive 3D quiz questions (Identify/Find), answered by clicking the
   *  structure in the viewer. */
  quiz?: QuizQuestion[];
  /** Guided anatomy tour: a preset journey of structures, each step focusing
   *  the camera and narrating what the learner is looking at. */
  tour?: TourStep[];
  icon: string;
  accent: string;
  description: string;
  poetic: string;
  size: string;
  weight: string;
  location: string;
  function: string;
  dailyFact: string;
  medical: string;
  bloodSupply: string;
  /** A single memorable line, surfaced as the "Did you know" note. */
  funFact: string;
  tissue: string;
  comparison: string;
  conditions: string[];
  hotspots: Hotspot[];
  /** Whether `/anatomy/<id>/*.webp` illustrations exist. Organs without them
   *  fall back to the accent glyph rather than a broken image. */
  illustrated: boolean;
};

export const organs: Organ[] = [
  {
    id: "eyeball",
    name: "Eye",
    scientificName: "Oculus",
    system: "Sensory System",
    model: "/models/eyeball.glb",
    procedural: "eye",
    anatomyModel: "/models/eye-anatomy.glb",
    anteriorSegment: true,
    layers: [
      { id: "VH_M_cornea_L", label: "Cornea", color: "#d8ecf2", transparent: true, defaultOpacity: 0.55 },
      { id: "VH_M_corneo_scleral_junction_L", label: "Corneoscleral Junction", color: "#b9c8cc" },
      { id: "VH_M_iris_L", label: "Iris", color: "#a57a3c" },
      { id: "VH_M_pupil_L", label: "Pupil", color: "#101418" },
      { id: "VH_M_lens_L", label: "Lens", color: "#dbe9ee", transparent: true, defaultOpacity: 0.5 },
      { id: "VH_M_suspensory_ligament_of_lens_L", label: "Zonular Fibres", color: "#c4d2d6", transparent: true, defaultOpacity: 0.85 },
      { id: "VH_M_aqueous_humor_L", label: "Aqueous Humor", color: "#b3d4e6", transparent: true, defaultOpacity: 0.5 },
      { id: "VH_M_ciliary_body_L", label: "Ciliary Body", color: "#8c5940" },
      { id: "VH_M_ciliary_muscle_L", label: "Ciliary Muscle", color: "#99664a" },
      { id: "VH_M_ciliary_processes_L", label: "Ciliary Processes", color: "#854d38" },
      { id: "VH_M_trabecular_meshwork_L", label: "Trabecular Meshwork", color: "#c7a059" },
      { id: "VH_M_schlemms_canal_L", label: "Schlemm's Canal", color: "#669980" },
      { id: "VH_M_palpebral_conjunctiva_of_upper_eyelid_L", label: "Palpebral Conjunctiva (Upper)", color: "#d9a69a" },
      { id: "VH_M_palpebral_conjunctiva_of_lower_eyelid_L", label: "Palpebral Conjunctiva (Lower)", color: "#d9a69a" },
      { id: "VH_M_bulbar_conjunctiva_L", label: "Bulbar Conjunctiva", color: "#ccb2a6" },
      { id: "VH_M_sclera_L", label: "Sclera", color: "#f2eee3" },
      { id: "VH_M_optic_choroid_L", label: "Choroid", color: "#732633" },
      { id: "VH_M_retina_L", label: "Retina", color: "#995a61" },
      { id: "VH_M_fovea_L", label: "Fovea", color: "#d9994d" },
      { id: "VH_M_macula_lutea_L", label: "Macula Lutea", color: "#cca640" },
      { id: "VH_M_optic_disc_L", label: "Optic Disc", color: "#8c8073" },
      { id: "VH_M_ora_serrata_of_retina_L", label: "Ora Serrata", color: "#8c666b" },
      { id: "VH_M_vitreous_humor_L", label: "Vitreous Humor", color: "#99b3cc", transparent: true, defaultOpacity: 0.5 },
      { id: "VH_M_collector_channel_L", label: "Collector Channels", color: "#d9c27a", transparent: true, defaultOpacity: 0.85 },
    ],
    layerGroups: [
      {
        group: "Anterior segment",
        layers: [
          { id: "VH_M_cornea_L", label: "Cornea", color: "#d8ecf2", transparent: true, defaultOpacity: 0.55 },
          { id: "VH_M_corneo_scleral_junction_L", label: "Corneoscleral Junction", color: "#b9c8cc" },
          { id: "VH_M_iris_L", label: "Iris", color: "#a57a3c" },
          { id: "VH_M_pupil_L", label: "Pupil", color: "#101418" },
          { id: "VH_M_lens_L", label: "Lens", color: "#dbe9ee", transparent: true, defaultOpacity: 0.5 },
          { id: "VH_M_suspensory_ligament_of_lens_L", label: "Zonular Fibres", color: "#c4d2d6", transparent: true, defaultOpacity: 0.85 },
          { id: "VH_M_aqueous_humor_L", label: "Aqueous Humor", color: "#b3d4e6", transparent: true, defaultOpacity: 0.5 },
          { id: "VH_M_ciliary_body_L", label: "Ciliary Body", color: "#8c5940" },
          { id: "VH_M_ciliary_muscle_L", label: "Ciliary Muscle", color: "#99664a" },
          { id: "VH_M_ciliary_processes_L", label: "Ciliary Processes", color: "#854d38" },
          { id: "VH_M_trabecular_meshwork_L", label: "Trabecular Meshwork", color: "#c7a059" },
      { id: "VH_M_schlemms_canal_L", label: "Schlemm's Canal", color: "#669980" },
      { id: "VH_M_collector_channel_L", label: "Collector Channels", color: "#d9c27a", transparent: true, defaultOpacity: 0.85 },
      { id: "VH_M_palpebral_conjunctiva_of_upper_eyelid_L", label: "Palpebral Conj. (Upper)", color: "#d9a69a" },
          { id: "VH_M_palpebral_conjunctiva_of_lower_eyelid_L", label: "Palpebral Conj. (Lower)", color: "#d9a69a" },
          { id: "VH_M_bulbar_conjunctiva_L", label: "Bulbar Conjunctiva", color: "#ccb2a6" },
        ],
      },
      {
        group: "Middle / vascular",
        layers: [
          { id: "VH_M_sclera_L", label: "Sclera", color: "#f2eee3" },
          { id: "VH_M_optic_choroid_L", label: "Choroid", color: "#732633" },
        ],
      },
      {
        group: "Posterior segment",
        layers: [
          { id: "VH_M_retina_L", label: "Retina", color: "#995a61" },
          { id: "VH_M_fovea_L", label: "Fovea", color: "#d9994d" },
          { id: "VH_M_macula_lutea_L", label: "Macula Lutea", color: "#cca640" },
          { id: "VH_M_optic_disc_L", label: "Optic Disc", color: "#8c8073" },
          { id: "VH_M_ora_serrata_of_retina_L", label: "Ora Serrata", color: "#8c666b" },
          { id: "VH_M_vitreous_humor_L", label: "Vitreous Humor", color: "#99b3cc", transparent: true, defaultOpacity: 0.5 },
        ],
      },
    ],
    icon: "⊙",
    accent: "#7294b9",
    description: "A precision sensory organ that converts focused light into neural signals interpreted as vision.",
    poetic: "A window made of light",
    size: "About 24 mm across",
    weight: "Around 7.5 g",
    location: "Within the bony orbit",
    function: "Captures and focuses light",
    dailyFact: "Makes thousands of tiny movements",
    medical: "The retina is an extension of the central nervous system.",
    bloodSupply: "Ophthalmic artery",
    funFact: "The cornea carries no blood vessels at all; it takes oxygen directly from the air.",
    tissue: "Retinal layers",
    comparison: "Eye vs. brain",
    conditions: ["Myopia", "Cataract", "Glaucoma", "Macular degeneration", "Retinal detachment", "Dry eye disease", "Astigmatism", "Conjunctivitis"],
    illustrated: true,
    hotspots: [
      { id: "cornea", label: "Cornea", detail: "Clear focusing surface", position: [0, 0, 1.9], color: "#6393d8" },
      { id: "sclera", label: "Sclera", detail: "White protective outer coat", position: [0, 1.9, 0], color: "#f3eee4" },
      { id: "iris", label: "Iris", detail: "Controls light entry", position: [0.65, 0, 1.12], color: "#f2a33b" },
      { id: "pupil", label: "Pupil", detail: "The dark aperture", position: [0, 0, 1.1], color: "#101418" },
      { id: "lens", label: "Lens", detail: "Focuses light onto the retina", position: [0, 0, 0.68], color: "#d89bc4" },
      { id: "ciliary", label: "Ciliary Body", detail: "Holds and shapes the lens", position: [0.85, 0, 0.92], color: "#8a5a3a" },
      { id: "choroid", label: "Choroid", detail: "Vascular layer beneath the retina", position: [0, 1.84, 0], color: "#6b2230" },
      { id: "retina", label: "Retina", detail: "Light-sensitive inner lining", position: [0, 0, -1.78], color: "#d996a1" },
      { id: "vitreous", label: "Vitreous Humor", detail: "Jelly filling the posterior chamber", position: [0.5, 0, 0], color: "#7fa88a" },
      { id: "optic", label: "Optic Nerve", detail: "Carries visual signals", position: [0, 0, -2.5], color: "#d89bc4" },
    ],
    anteriorHotspots: [
      { id: "tm", label: "Trabecular Meshwork", detail: "Primary outflow resistance", position: [0.95, 0, 1.21], color: "#c9a86a" },
      { id: "jct", label: "Juxtacanalicular Tissue", detail: "Innermost TM layer", position: [1.0, 0, 1.22], color: "#e8c39a" },
      { id: "sc", label: "Schlemm's Canal", detail: "Circumferential drainage channel", position: [1.04, 0, 1.23], color: "#7fa88a" },
      { id: "cc", label: "Collector Channel", detail: "Drains to aqueous veins", position: [1.3, 0, 1.22], color: "#6393d8" },
    ],
    anteriorLayerIds: [
      "VH_M_cornea_L",
      "VH_M_corneo_scleral_junction_L",
      "VH_M_iris_L",
      "VH_M_pupil_L",
      "VH_M_lens_L",
      "VH_M_suspensory_ligament_of_lens_L",
      "VH_M_aqueous_humor_L",
      "VH_M_ciliary_body_L",
      "VH_M_ciliary_muscle_L",
      "VH_M_ciliary_processes_L",
      "VH_M_trabecular_meshwork_L",
      "VH_M_schlemms_canal_L",
      "VH_M_collector_channel_L",
    ],
    quiz: [
      {
        id: "q1",
        mode: "identify",
        answerLayerId: "VH_M_cornea_L",
        prompt: "This crystal-clear dome bends light into the eye — click the highlighted structure.",
        explain: "The cornea is avascular — it has no blood vessels at all — and supplies about two-thirds of the eye's focusing power.",
      },
      {
        id: "q2",
        mode: "find",
        answerLayerId: "VH_M_lens_L",
        prompt: "Click the lens — the biconvex structure that fine-focuses light onto the retina.",
        explain: "The lens changes shape as the ciliary muscle pulls on the zonular fibres — this is accommodation.",
      },
      {
        id: "q3",
        mode: "identify",
        answerLayerId: "VH_M_iris_L",
        prompt: "This coloured diaphragm controls how much light reaches the retina — click it.",
        explain: "The iris's radial and circular muscles widen and narrow the pupil, adapting the eye to light levels.",
      },
      {
        id: "q4",
        mode: "find",
        answerLayerId: "VH_M_retina_L",
        prompt: "Click the retina — the light-sensitive lining at the back of the eye.",
        explain: "The retina is an extension of the central nervous system; its photoreceptors convert light into neural signals.",
      },
      {
        id: "q5",
        mode: "identify",
        answerLayerId: "VH_M_sclera_L",
        prompt: "This tough white outer coat protects the eyeball and anchors the muscles that move it — click it.",
        explain: "The sclera is the dense connective-tissue shell of the eye; the extraocular muscles insert onto its surface.",
      },
      {
        id: "q6",
        mode: "find",
        answerLayerId: "VH_M_optic_disc_L",
        prompt: "Click the optic disc — the pale spot where the optic nerve leaves the eye.",
        explain: "Because it holds no photoreceptors, the optic disc is the eye's natural blind spot.",
      },
      {
        id: "q7",
        mode: "identify",
        answerLayerId: "VH_M_optic_choroid_L",
        prompt: "This dark, richly vascular layer nourishes the outer retina — click it.",
        explain: "The choroid sits between the sclera and retina; its dense vessel bed supplies oxygen to the photoreceptors.",
      },
      {
        id: "q8",
        mode: "find",
        answerLayerId: "VH_M_ciliary_body_L",
        prompt: "Click the ciliary body — the ring of muscle that shapes the lens.",
        explain: "Besides focusing, the ciliary body's processes secrete the aqueous humour that fills the front of the eye.",
      },
      {
        id: "q9",
        mode: "identify",
        answerLayerId: "VH_M_vitreous_humor_L",
        prompt: "This transparent jelly fills the large chamber behind the lens — click it.",
        explain: "The vitreous humour gives the eye its shape and holds the retina in place against the choroid.",
      },
      {
        id: "q10",
        mode: "find",
        answerLayerId: "VH_M_fovea_L",
        prompt: "Click the fovea — the tiny pit that gives you sharp central vision.",
        explain: "The fovea is packed with cone photoreceptors and is where visual acuity is highest.",
      },
    ],
    tour: [
      {
        id: "t1",
        layerId: "VH_M_cornea_L",
        title: "Cornea",
        body: "Light enters through this transparent dome. It bends (refracts) the rays sharply — the cornea does roughly two-thirds of the eye's focusing.",
      },
      {
        id: "t2",
        layerId: "VH_M_iris_L",
        title: "Iris",
        body: "This coloured diaphragm sits just behind the cornea. Its radial and circular muscles control how much light passes through to the retina.",
      },
      {
        id: "t3",
        layerId: "VH_M_pupil_L",
        title: "Pupil",
        body: "The dark aperture at the centre of the iris. In bright light the pupil narrows; in dim light it widens — exactly like a camera's aperture.",
      },
      {
        id: "t4",
        layerId: "VH_M_lens_L",
        title: "Lens",
        body: "A biconvex lens that fine-focuses the light onto the retina. The ciliary muscle pulls on zonular fibres to change its shape — accommodation.",
      },
      {
        id: "t5",
        layerId: "VH_M_vitreous_humor_L",
        title: "Vitreous Humor",
        body: "This transparent jelly fills the large chamber behind the lens. It holds the eyeball's shape and keeps the retina pressed against the choroid.",
      },
      {
        id: "t6",
        layerId: "VH_M_retina_L",
        title: "Retina",
        body: "The light-sensitive lining at the back of the eye. Photoreceptors convert light into electrical signals — the retina is an extension of the brain.",
      },
      {
        id: "t7",
        layerId: "VH_M_fovea_L",
        title: "Fovea",
        body: "A tiny pit in the centre of the macula, packed with cones. When you read, you are aiming light at this spot — your sharpest point of vision.",
      },
      {
        id: "t8",
        layerId: "VH_M_optic_disc_L",
        title: "Optic Disc",
        body: "Where the optic nerve leaves the eye. It has no photoreceptors, so every eye carries a natural blind spot here.",
      },
      {
        id: "t9",
        layerId: "VH_M_optic_choroid_L",
        title: "Choroid",
        body: "A dark, richly vascular layer between the sclera and retina. Its dense vessel bed supplies oxygen to the demanding photoreceptors.",
      },
      {
        id: "t10",
        layerId: "VH_M_sclera_L",
        title: "Sclera",
        body: "The tough white outer coat. It gives the eye its shape, protects the delicate inner layers, and anchors the six muscles that move the eyeball.",
      },
    ],
  },
];

export const organById = Object.fromEntries(organs.map((organ) => [organ.id, organ])) as Record<OrganId, Organ>;

/** Human-readable label for a peelable layer id, e.g. `VH_M_cornea_L` → "Cornea". */
export function layerLabel(organ: Organ, layerId: string): string {
  return (organ.layers ?? []).find((layer) => layer.id === layerId)?.label ?? layerId;
}

// ---------------------------------------------------------------------------
// Glossary (English ↔ 中文) — every 3D eye structure in the project
// ---------------------------------------------------------------------------

export type GlossaryEntry = {
  /** English term as shown in the app (layer label / hotspot). */
  en: string;
  /** Simplified-Chinese anatomical term. */
  zh: string;
  /** Anatomical segment grouping. */
  group: string;
};

export const GLOSSARY: GlossaryEntry[] = [
  // Anterior segment
  { en: "Cornea", zh: "角膜", group: "Anterior segment" },
  { en: "Corneoscleral Junction", zh: "角巩膜缘", group: "Anterior segment" },
  { en: "Iris", zh: "虹膜", group: "Anterior segment" },
  { en: "Pupil", zh: "瞳孔", group: "Anterior segment" },
  { en: "Lens", zh: "晶状体", group: "Anterior segment" },
  { en: "Zonular Fibres", zh: "睫状小带（悬韧带）", group: "Anterior segment" },
  { en: "Aqueous Humor", zh: "房水", group: "Anterior segment" },
  { en: "Ciliary Body", zh: "睫状体", group: "Anterior segment" },
  { en: "Ciliary Muscle", zh: "睫状肌", group: "Anterior segment" },
  { en: "Ciliary Processes", zh: "睫状突", group: "Anterior segment" },
  { en: "Trabecular Meshwork", zh: "小梁网", group: "Anterior segment" },
  { en: "Schlemm's Canal", zh: "施莱姆管（巩膜静脉窦）", group: "Anterior segment" },
  { en: "Palpebral Conjunctiva (Upper)", zh: "上睑结膜", group: "Anterior segment" },
  { en: "Palpebral Conjunctiva (Lower)", zh: "下睑结膜", group: "Anterior segment" },
  { en: "Bulbar Conjunctiva", zh: "球结膜", group: "Anterior segment" },
  // Middle / vascular
  { en: "Sclera", zh: "巩膜", group: "Middle / vascular" },
  { en: "Choroid", zh: "脉络膜", group: "Middle / vascular" },
  // Posterior segment
  { en: "Retina", zh: "视网膜", group: "Posterior segment" },
  { en: "Fovea", zh: "中央凹", group: "Posterior segment" },
  { en: "Macula Lutea", zh: "黄斑", group: "Posterior segment" },
  { en: "Optic Disc", zh: "视盘（视神经乳头）", group: "Posterior segment" },
  { en: "Ora Serrata", zh: "锯齿缘", group: "Posterior segment" },
  { en: "Vitreous Humor", zh: "玻璃体", group: "Posterior segment" },
  // Extra landmarks
  { en: "Optic Nerve", zh: "视神经", group: "Extra landmarks" },
  { en: "Fovea Centralis", zh: "黄斑中心凹", group: "Extra landmarks" },
];
