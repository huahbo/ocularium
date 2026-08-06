"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  CircleHelp,
  Eye,
  EyeOff,
  FileText,
  Heart,
  Layers3,
  Map,
  Microscope,
  Play,
  Search,
  Share2,
  Sparkles,
  Stethoscope,
  X,
} from "lucide-react";
import { OrganViewer } from "./OrganViewer";
import { QuizOverlay } from "./QuizOverlay";
import { TourOverlay } from "./TourOverlay";
import { organById, type Organ, type OrganLayerGroup } from "../lib/anatomy-data";
import type { AnatomyViewer } from "../lib/three/viewer";

type Modal = "lesson" | "animation" | "system" | null;

/** Renders an eye illustration asset. */
function EyeArt({
  asset,
  alt,
  size,
}: {
  asset: "organ" | "microscopic" | "compare" | "location";
  alt: string;
  size?: number;
}) {
  return (
    <img
      src={`/anatomy/eyeball/${asset}.webp`}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}

export function AnatomyApp() {
  const organ = organById.eyeball;
  const [autoRotate, setAutoRotate] = useState(true);
  const [compare, setCompare] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [quizOpen, setQuizOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [activeLayer, setActiveLayer] = useState<string | null>(null);
  /** Structure-rail search: filters the layer list by label or layer id. */
  const [searchQuery, setSearchQuery] = useState("");
  /** Clinical condition currently simulated in the 3D viewer (if any). */
  const [activeCondition, setActiveCondition] = useState<string | null>(null);
  /** When true the condition panel is previewing the normal state (A/B
   *  compare): the viewer is temporarily cleared but the mode stays on. */
  const [conditionPreview, setConditionPreview] = useState(false);
  /** Aqueous-humour flow animation running in the viewer (if any). */
  const [flowActive, setFlowActive] = useState(false);
  const [hiddenLayers, setHiddenLayers] = useState<ReadonlySet<string>>(new Set());
  // Per-layer opacity overrides, seeded from each layer's defaultOpacity.
  const [layerOpacities, setLayerOpacities] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    (organ.layers ?? []).forEach((layer) => {
      initial[layer.id] = layer.defaultOpacity ?? 1;
    });
    return initial;
  });
  const contentRef = useRef<HTMLDivElement>(null);
  /** Shares the live viewer with the quiz overlay so it can drive the scene. */
  const viewerApiRef = useRef<AnatomyViewer | null>(null);

  /** Toggles a structure's visibility from the rail's eye button. */
  const toggleLayerVisible = (id: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Updates one layer's opacity from the slider. */
  const setLayerOpacity = (id: string, opacity: number) => {
    setLayerOpacities((prev) => ({ ...prev, [id]: opacity }));
  };

  /** Toggles a 3D-simulatable condition on the viewer. */
  const toggleCondition = (conditionId: string) => {
    if (activeCondition === conditionId) {
      viewerApiRef.current?.clearCondition();
      setActiveCondition(null);
      setConditionPreview(false);
    } else {
      viewerApiRef.current?.applyCondition(conditionId);
      setActiveCondition(conditionId);
      setConditionPreview(false);
      // Fly the camera to the affected structure so the change is visible —
      // the retina/optic disc sit inside the eye and read as "nothing
      // happened" from the default front view.
      const focus = CONDITION_FOCUS[conditionId];
      if (focus && !quizOpen && !tourOpen) viewerApiRef.current?.focusLayer(focus);
    }
  };

  /** A/B compare: temporarily show the normal state without leaving condition
   *  mode, then apply the condition again. */
  const previewCondition = () => {
    if (!activeCondition) return;
    if (conditionPreview) {
      viewerApiRef.current?.applyCondition(activeCondition);
      setConditionPreview(false);
    } else {
      viewerApiRef.current?.clearCondition();
      setConditionPreview(true);
    }
  };

  useEffect(() => {
    if (!contentRef.current) return;
    gsap.fromTo(contentRef.current.querySelectorAll("[data-reveal]"),
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.48, stagger: 0.035, ease: "power2.out", overwrite: true },
    );
  }, [organ.id]);

  const layerGroups: OrganLayerGroup[] = organ.layerGroups ?? [
    { group: "Structures", layers: organ.layers ?? [] },
  ];
  const totalLayers = (organ.layers ?? []).length;

  /** Layers filtered by the search box (label or id, case-insensitive). */
  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return layerGroups;
    return layerGroups
      .map((group) => ({
        ...group,
        layers: group.layers.filter(
          (layer) =>
            layer.label.toLowerCase().includes(query) ||
            layer.id.toLowerCase().includes(query),
        ),
      }))
      .filter((group) => group.layers.length > 0);
  }, [layerGroups, searchQuery]);

  /** Selects a structure from the rail and flies the camera to it. */
  const selectStructure = (layer: { id: string }, selected: boolean) => {
    const next = selected ? null : layer.id;
    setActiveLayer(next);
    // The quiz/tour own the camera while active — don't fight them.
    if (next && !quizOpen && !tourOpen) viewerApiRef.current?.focusLayer(next);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setActiveLayer(null)} aria-label="Ocularium home">
          <strong>Ocularium<sup>✦</sup></strong>
          <em>Anatomy of vision, in 3D</em>
        </button>
        <nav className="main-nav" aria-label="Primary navigation">
          <button className="active"><BrainCircuit size={17} /> Explore</button>
          <button onClick={() => setModal("lesson")}><BookOpen size={17} /> Lessons</button>
          <button><Sparkles size={17} /> Library</button>
        </nav>
        <button className="profile" aria-label="Open learner profile"><span>MA</span></button>
      </header>

      <div className="workspace">
        {/* Left rail: the 23-layer structure tree, grouped by segment. */}
        <aside className="structure-rail" aria-label="Eye structure layers">
          <div className="panel-heading">
            <span><Layers3 size={15} /> Eye layers</span>
            <em>{totalLayers}</em>
          </div>
          <div className="structure-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              placeholder="Find a structure…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search structures"
            />
            {searchQuery && (
              <button
                type="button"
                className="structure-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {filteredGroups.length === 0 && (
            <p className="structure-empty">No structures match “{searchQuery.trim()}”.</p>
          )}
          {filteredGroups.map((group) => (
            <div className="structure-group" key={group.group}>
              <div className="structure-group-heading">{group.group}</div>
              <ul>
                {group.layers.map((layer) => {
                  const hidden = hiddenLayers.has(layer.id);
                  const selected = activeLayer === layer.id;
                  const opacity = layerOpacities[layer.id] ?? layer.defaultOpacity ?? 1;
                  return (
                    <li key={layer.id} className={selected ? "open" : ""}>
                      <button
                        type="button"
                        className={`structure-item ${selected ? "active" : ""} ${hidden ? "hidden" : ""}`}
                        onClick={() => selectStructure(layer, selected)}
                        aria-pressed={selected}
                      >
                        <i style={{ background: layer.color }} />
                        <span className="structure-label">
                          {layer.label}
                          {layer.transparent && (
                            <b className="structure-transparent" title="Translucent structure" aria-label="translucent">◐</b>
                          )}
                        </span>
                        <em
                          className="structure-eye"
                          role="button"
                          tabIndex={0}
                          aria-label={hidden ? `Show ${layer.label}` : `Hide ${layer.label}`}
                          aria-pressed={!hidden}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleLayerVisible(layer.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleLayerVisible(layer.id);
                            }
                          }}
                        >
                          {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                        </em>
                      </button>
                      {selected && (
                        <div className="structure-slider">
                          <span>Opacity</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={Math.round(opacity * 100)}
                            onChange={(event) => setLayerOpacity(layer.id, Number(event.target.value) / 100)}
                            aria-label={`${layer.label} opacity`}
                          />
                          <em>{Math.round(opacity * 100)}%</em>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </aside>

        <div className="viewer-col">
          <OrganViewer
            organ={organ}
            autoRotate={autoRotate}
            onAutoRotate={setAutoRotate}
            compare={compare}
            onCompare={() => setCompare(!compare)}
            activeLayerId={activeLayer}
            hiddenLayerIds={hiddenLayers}
            layerOpacities={layerOpacities}
            viewerRef={viewerApiRef}
            quizMode={quizOpen}
            tourMode={tourOpen}
          />
          {quizOpen && (
            <QuizOverlay organ={organ} viewerRef={viewerApiRef} onClose={() => setQuizOpen(false)} />
          )}
          {tourOpen && (
            <TourOverlay organ={organ} viewerRef={viewerApiRef} onClose={() => setTourOpen(false)} />
          )}
          {activeCondition && (
            <div className="condition-chip" role="status" aria-live="polite">
              <span>⚠</span> {CONDITION_LABEL[activeCondition]}
              {conditionPreview && <em>· previewing normal</em>}
              <button type="button" className="condition-chip-toggle" onClick={previewCondition}>
                {conditionPreview ? "Show condition" : "Show normal"}
              </button>
            </div>
          )}
        </div>

        <aside className="info-panel" ref={contentRef}>
          <div className="info-kicker" data-reveal><Heart size={13} fill="currentColor" /> The {organ.name}</div>
          <div className="info-title-row" data-reveal>
            <div><h1>{organ.name}</h1><em>{organ.poetic}</em></div>
            <span className="specimen-stamp">
              <EyeArt asset="organ" alt={`${organ.name} anatomical illustration`} size={92} />
            </span>
          </div>
          <p className="description" data-reveal>{organ.description}</p>
          <div className="rule" />
          <h2 data-reveal>Key facts</h2>
          <dl className="key-facts">
            <div data-reveal><dt><span>◇</span> Size</dt><dd>{organ.size}</dd></div>
            <div data-reveal><dt><span>♙</span> Weight</dt><dd>{organ.weight}</dd></div>
            <div data-reveal><dt><span>⌁</span> Daily</dt><dd>{organ.dailyFact}</dd></div>
            <div data-reveal><dt><span>⌖</span> Location</dt><dd>{organ.location}</dd></div>
            <div data-reveal><dt><span>❋</span> Blood supply</dt><dd>{organ.bloodSupply}</dd></div>
            <div data-reveal><dt><span>◈</span> Function</dt><dd>{organ.function}</dd></div>
          </dl>
          <div className="medical-note" data-reveal><Stethoscope size={16} /><p><b>Medical importance</b>{organ.medical}</p></div>
          <div className="fun-note" data-reveal><Sparkles size={15} /><p><b>Did you know</b>{organ.funFact}</p></div>
          <button className="lesson-button" data-reveal onClick={() => setModal("lesson")}>View lesson <ArrowRight size={16} /></button>
          <div className="action-grid" data-reveal>
            <button
              onClick={() => setFlowActive(viewerApiRef.current?.toggleAqueousFlow() ?? false)}
              className={flowActive ? "active" : ""}
            >
              <Play size={15} /> Animate
            </button>
            <button onClick={() => { setQuizOpen(true); setTourOpen(false); }}><CircleHelp size={15} /> Quiz</button>
            <button onClick={() => { setTourOpen(true); setQuizOpen(false); }}><Map size={15} /> Tour</button>
            <button onClick={() => setCompare(!compare)} className={compare ? "active" : ""}><Share2 size={15} /> Compare</button>
          </div>
        </aside>
      </div>

      {compare && (
        <section className="compare-strip" aria-label="Anterior vs posterior comparison">
          <div className="compare-organ"><span className="compare-tag">Anterior</span><strong>Outflow pathway</strong><small>Cornea · Iris · TM · Schlemm</small></div>
          <b>vs.</b>
          <div className="compare-organ"><span className="compare-tag">Posterior</span><strong>Neural retina</strong><small>Retina · Fovea · Optic disc</small></div>
          <dl><div><dt>Primary role</dt><dd>{organ.function}</dd></div><div><dt>Scale</dt><dd>{organ.size}</dd></div></dl>
          <button onClick={() => setCompare(false)} aria-label="Close comparison"><X size={16} /></button>
        </section>
      )}

      <section className="learning-cards" aria-label={`${organ.name} learning resources`}>
        <article>
          <header><div><em>Microscopic view</em><h3>{organ.tissue}</h3></div><Microscope size={17} /></header>
          <div className="microscope-visual organ-card-image"><EyeArt asset="microscopic" alt={`${organ.name} microscopic tissue view`} /></div>
          <button onClick={() => setModal("lesson")}>Explore tissue <ArrowRight size={14} /></button>
        </article>
        <article>
          <header><div><em>Segments</em><h3>{organ.comparison}</h3></div><Share2 size={17} /></header>
          <div className="comparison-visual organ-card-image"><EyeArt asset="compare" alt={`${organ.comparison} anatomical comparison`} /></div>
          <button onClick={() => setCompare(true)}>Open comparison <ArrowRight size={14} /></button>
        </article>
        <article>
          <header><div><em>Function animation</em><h3>{organ.function}</h3></div><Play size={17} /></header>
          <button
            type="button"
            className="function-visual organ-card-image"
            onClick={() => setModal("animation")}
            aria-label={`Play the ${organ.name.toLowerCase()} function animation`}
          >
            <EyeArt asset="organ" alt="" />
            <i className="function-pulse" />
            <span className="play-badge"><Play size={18} fill="currentColor" /></span>
          </button>
          <button onClick={() => setModal("animation")}>Play animation <ArrowRight size={14} /></button>
        </article>
        <article>
          <header><div><em>Clinical notes</em><h3>Common conditions</h3></div><FileText size={17} /></header>
          <ul className="condition-list">
            {organ.conditions.map((condition) => {
              const conditionId = CONDITION_3D[condition];
              const active = activeCondition === conditionId;
              return (
                <li key={condition}>
                  {conditionId ? (
                    <>
                      <button
                        type="button"
                        className={active ? "active" : ""}
                        onClick={() => toggleCondition(conditionId)}
                        aria-pressed={active}
                      >
                        {condition}
                        {active && <em>Viewing in 3D</em>}
                      </button>
                      {active && (
                        <button
                          type="button"
                          className="condition-compare"
                          onClick={previewCondition}
                          aria-pressed={conditionPreview}
                        >
                          {conditionPreview ? <Eye size={12} /> : <EyeOff size={12} />}
                          {conditionPreview ? "Show condition" : "Show normal"}
                        </button>
                      )}
                    </>
                  ) : (
                    condition
                  )}
                </li>
              );
            })}
          </ul>
          <button onClick={() => setModal("lesson")}>See all <ArrowRight size={14} /></button>
        </article>
        <article className="system-card">
          <header><div><em>Where it works</em><h3>{organ.system}</h3></div><BrainCircuit size={17} /></header>
          <button
            type="button"
            className="system-visual organ-card-image"
            onClick={() => setModal("system")}
            aria-label={`See where the ${organ.name.toLowerCase()} sits in the body`}
          >
            <EyeArt asset="location" alt="" />
          </button>
          <button onClick={() => setModal("system")}>See the system <ArrowRight size={14} /></button>
        </article>
      </section>

      {modal && <LearningModal type={modal} organ={organ} onClose={() => setModal(null)} />}
    </main>
  );
}

const MODAL_ICON: Record<Exclude<Modal, null>, string> = {
  animation: "▶",
  system: "⌖",
  lesson: "✦",
};

/** Conditions with a 3D material simulation (viewer.applyCondition). */
const CONDITION_3D: Record<string, string> = {
  Cataract: "cataract",
  Glaucoma: "glaucoma",
  "Macular degeneration": "amd",
  "Retinal detachment": "detachment",
};

/** Structure each condition's camera flies to when applied. */
const CONDITION_FOCUS: Record<string, string> = {
  cataract: "VH_M_lens_L",
  glaucoma: "VH_M_optic_disc_L",
  amd: "VH_M_macula_lutea_L",
  detachment: "VH_M_retina_L",
};

/** Condition id → display name for the on-screen status chip. */
const CONDITION_LABEL: Record<string, string> = {
  cataract: "Cataract",
  glaucoma: "Glaucoma",
  amd: "Macular Degeneration",
  detachment: "Retinal Detachment",
};

function LearningModal({ type, organ, onClose }: { type: Exclude<Modal, null>; organ: Organ; onClose: () => void }) {
  const organName = organ.name;
  const title =
    type === "animation" ? `${organName} in motion`
    : type === "system" ? `${organName} in the body`
    : `Inside the ${organName.toLowerCase()}`;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`learning-modal ${type === "system" ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <span className="modal-icon">{MODAL_ICON[type]}</span>
        <em>Guided discovery</em>
        <h2 id="modal-title">{title}</h2>
        {type === "system" ? (
          <>
            <p>{organ.location}. Trace how the {organName.toLowerCase()} connects to the rest of the body.</p>
            <figure className="modal-figure">
              <EyeArt asset="location" alt={`${organName} shown in place within the ${organ.system.toLowerCase()}`} />
            </figure>
            <dl className="modal-facts">
              <div><dt>System</dt><dd>{organ.system}</dd></div>
              <div><dt>Primary role</dt><dd>{organ.function}</dd></div>
              <div><dt>Blood supply</dt><dd>{organ.bloodSupply}</dd></div>
            </dl>
            <button className="lesson-button" onClick={onClose}>Continue exploring <ArrowRight size={16} /></button>
          </>
        ) : (
          <>
            <p>Follow the highlighted structures, rotate the specimen, and connect form with function. This short study moment is designed to build a durable mental model.</p>
            <div className={`modal-demo ${type === "animation" ? "moving" : ""}`}><EyeArt asset="organ" alt={`${organName} illustration`} /></div>
            <button className="lesson-button" onClick={onClose}>Continue exploring <ArrowRight size={16} /></button>
          </>
        )}
      </section>
    </div>
  );
}
