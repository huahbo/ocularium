"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  CircleDashed,
  Layers3,
  Maximize2,
  RotateCcw,
  ScanEye,
  ScanLine,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type { Hotspot, Organ } from "../lib/anatomy-data";
import type { AnatomyViewer } from "../lib/three/viewer";

type Props = {
  organ: Organ;
  autoRotate: boolean;
  onAutoRotate: (enabled: boolean) => void;
  compare: boolean;
  onCompare: () => void;
  /** Layer id selected in the left structure rail; the viewer highlights the
   *  matching structure. */
  activeLayerId?: string | null;
  /** Layer ids currently hidden by the structure rail's eye toggles. */
  hiddenLayerIds?: ReadonlySet<string>;
  /** Called when the structure rail toggles a layer's visibility. */
  onToggleLayer?: (id: string) => void;
  /** Per-layer opacity overrides (0–1), keyed by layer id. Drives the opacity
   *  slider in the structure rail. */
  layerOpacities?: Readonly<Record<string, number>>;
  /** Receives the live AnatomyViewer instance once created (and null on
   *  teardown), so a sibling quiz panel can drive the 3D scene. */
  viewerRef?: React.RefObject<AnatomyViewer | null>;
  /** While true the viewer chrome that would disturb a quiz (mode switch,
   *  tools, tip) is hidden so attention stays on the question. */
  quizMode?: boolean;
  /** While true the viewer chrome is hidden for the guided tour, which owns
   *  the scene the same way the quiz does. */
  tourMode?: boolean;
};

export function OrganViewer({
  organ,
  autoRotate,
  onAutoRotate,
  compare,
  onCompare,
  activeLayerId,
  hiddenLayerIds,
  onToggleLayer,
  layerOpacities,
  viewerRef,
  quizMode = false,
  tourMode = false,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  /** Quiz and tour both own the scene — hide the chrome that would disturb it. */
  const chromeHidden = quizMode || tourMode;
  const viewerInstanceRef = useRef<AnatomyViewer | null>(null);
  const organRef = useRef(organ);
  const autoRotateRef = useRef(autoRotate);
  const [selected, setSelected] = useState<Hotspot | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [slowLoad, setSlowLoad] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [mode, setMode] = useState<"layers" | "anatomy" | "anterior">(() =>
    organ.procedural ? "layers" : "anatomy",
  );
  // The mode the user last picked for the eye, so switching organs and back
  // restores their view instead of defaulting to layers every time.
  const preferredModeRef = useRef<"layers" | "anatomy" | "anterior" | null>(null);

  /** Loads the organ in the given viewer mode. The eye has three modes;
   *  other organs always use their default GLB path. */
  const loadOrgan = useCallback(
    async (current: Organ, nextMode: "layers" | "anatomy" | "anterior") => {
      const viewer = viewerInstanceRef.current;
      if (!viewer) return;
      if (current.procedural === "eye") {
        if (nextMode === "anatomy" && current.anatomyModel) {
          await viewer.setOrgan(current.anatomyModel, current.hotspots, current.accent).catch(() => {
            setLoading(false);
            setProgress(0);
          });
        } else if (nextMode === "anterior" && current.anteriorSegment && current.anatomyModel) {
          // Anterior/outflow mode: render the fine HRA model but keep only the
          // anterior-segment structures visible (TM, SC, cornea, iris, ...).
          const hotspots = current.anteriorHotspots ?? current.hotspots;
          await viewer.setOrgan(current.anatomyModel, hotspots, current.accent).catch(() => {
            setLoading(false);
            setProgress(0);
          });
          if (current.anteriorLayerIds) viewer.setOnlyLayersVisible(current.anteriorLayerIds);
        } else if (nextMode === "layers" && current.anatomyModel) {
          // Layered mode: the fine HRA model is the primary peelable specimen.
          await viewer.setOrgan(current.anatomyModel, current.hotspots, current.accent).catch(() => {
            setLoading(false);
            setProgress(0);
          });
        } else {
          const { buildEye } = await import("../lib/three/eye");
          await viewer.setOrgan(current.model, current.hotspots, current.accent, buildEye).catch(() => {
            setLoading(false);
            setProgress(0);
          });
        }
      } else {
        await viewer.setOrgan(current.model, current.hotspots, current.accent).catch(() => {
          setLoading(false);
          setProgress(0);
        });
      }
    },
    [],
  );

  // A typical organ is ready well inside a second — flashing a loading panel for
  // that reads as jank. It only appears if the fetch is genuinely slow; the flag
  // is cleared by onLoading when the next load starts.
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setSlowLoad(true), 900);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    organRef.current = organ;
  }, [organ]);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    let cancelled = false;
    let viewer: AnatomyViewer | null = null;

    void import("../lib/three/viewer").then(async ({ AnatomyViewer: Viewer }) => {
      if (cancelled || !mountRef.current) return;
      viewer = new Viewer(mountRef.current, {
        onSelect: setSelected,
        onLoading: (isLoading, value) => {
          setLoading(isLoading);
          setProgress(value);
          if (isLoading) setSlowLoad(false);
        },
      });
      viewerInstanceRef.current = viewer;
      if (viewerRef) viewerRef.current = viewer;
      viewer.setAutoRotate(autoRotateRef.current);
      const current = organRef.current;
      const initialMode: "layers" | "anatomy" | "anterior" = current.procedural ? "layers" : "anatomy";
      setMode(initialMode);
      await loadOrgan(current, initialMode);
    });

    return () => {
      cancelled = true;
      viewerInstanceRef.current = null;
      if (viewerRef) viewerRef.current = null;
      viewer?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Restore the mode the user preferred for this organ family, or default.
    const nextMode: "layers" | "anatomy" | "anterior" =
      organ.procedural === "eye" && preferredModeRef.current ? preferredModeRef.current : organ.procedural ? "layers" : "anatomy";
    void import("../lib/three/viewer").then(async ({ AnatomyViewer: Viewer }) => {
      if (cancelled || !viewerInstanceRef.current) return;
      setMode(nextMode);
      await loadOrgan(organ, nextMode);
    });
    return () => {
      cancelled = true;
    };
  }, [organ, loadOrgan]);

  useEffect(() => viewerInstanceRef.current?.setAutoRotate(autoRotate), [autoRotate]);

  // Highlights the layer picked in the left structure rail. Uses a timeout so
  // the GLB has finished loading before we isolate the structure.
  useEffect(() => {
    if (!activeLayerId) {
      viewerInstanceRef.current?.clearLayerHighlight();
      return;
    }
    const timer = window.setTimeout(() => {
      viewerInstanceRef.current?.highlightLayer(activeLayerId, layerOpacities?.[activeLayerId] ?? 1);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [activeLayerId, layerOpacities]);

  // Applies slider opacity overrides to the loaded model whenever they change.
  useEffect(() => {
    if (!layerOpacities) return;
    const timer = window.setTimeout(() => {
      Object.entries(layerOpacities).forEach(([id, opacity]) => {
        viewerInstanceRef.current?.setLayerOpacity(id, opacity);
      });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [layerOpacities, mode]);

  /** Switches the eye between its layered / anatomy / anterior modes. */
  const switchMode = (next: "layers" | "anatomy" | "anterior") => {
    if (next === mode) return;
    preferredModeRef.current = next;
    setMode(next);
    void loadOrgan(organ, next);
  };

  // The viewer drives the callout's position directly, so a spinning model
  // never costs a React render.
  const calloutRef = useCallback((node: HTMLDivElement | null) => {
    viewerInstanceRef.current?.attachCallout(node);
  }, []);

  const handleTool = (tool: string) => {
    const viewer = viewerInstanceRef.current;
    if (!viewer) return;
    if (tool === "rotate") onAutoRotate(!autoRotate);
    if (tool === "zoom") viewer.zoom(-1);
    if (tool === "isolate") setActiveTool(viewer.toggleIsolate() ? tool : null);
    if (tool === "section") setActiveTool(viewer.toggleCrossSection() ? tool : null);
    if (tool === "xray") setActiveTool(viewer.toggleXRay() ? tool : null);
    if (tool === "layers") setActiveTool(viewer.toggleLayers() ? tool : null);
    if (tool === "compare") onCompare();
    if (tool === "reset") {
      (organ.layers ?? []).forEach((layer) => viewerInstanceRef.current?.setLayerVisible(layer.id, true));
      viewer.reset();
      setActiveTool(null);
    }
  };

  // Syncs the structure rail's hidden set to the loaded model: show everything,
  // then re-hide the toggled-off layers. Runs on mode/model changes too.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const viewer = viewerInstanceRef.current;
      if (!viewer) return;
      (organ.layers ?? []).forEach((layer) => viewer.setLayerVisible(layer.id, true));
      hiddenLayerIds?.forEach((id) => viewer.setLayerVisible(id, false));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [hiddenLayerIds, mode, organ]);

  const tools = [
    { id: "rotate", label: "Rotate", icon: RotateCcw },
    { id: "zoom", label: "Zoom", icon: Search },
    { id: "isolate", label: "Isolate", icon: CircleDashed },
    { id: "section", label: "Cross-section", icon: ScanLine },
    { id: "xray", label: "X-Ray", icon: ScanEye },
    { id: "layers", label: "Layers", icon: Layers3 },
    { id: "compare", label: "Compare", icon: Box },
    { id: "reset", label: "Reset", icon: RotateCcw },
  ];

  // The eye renders three ways; other organs have only their default model.
  const hasModes = organ.procedural === "eye" && (Boolean(organ.anatomyModel) || organ.anteriorSegment);
  const allModeOptions: { id: "layers" | "anatomy" | "anterior"; label: string }[] = [
    { id: "layers", label: "Layered" },
    { id: "anatomy", label: "Anatomy" },
    { id: "anterior", label: "Outflow" },
  ];
  const modeOptions = allModeOptions.filter((option) => {
    if (option.id === "anatomy") return Boolean(organ.anatomyModel);
    if (option.id === "anterior") return Boolean(organ.anteriorSegment);
    return true;
  });

  return (
    <section className="viewer-shell" aria-label={`${organ.name} interactive viewer`}>
      <div className="viewer-glow" style={{ "--organ-accent": organ.accent } as React.CSSProperties} />
      <div ref={mountRef} className="three-mount" />

      {!quizMode && hasModes && (
        <div className="mode-switch" role="tablist" aria-label="View mode">
          {modeOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={mode === option.id}
              className={mode === option.id ? "active" : ""}
              onClick={() => switchMode(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {!chromeHidden && (
        <div className="viewer-tools" aria-label="3D viewer tools">
          {tools.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`tool-button ${(activeTool === id || (id === "compare" && compare)) ? "active" : ""}`}
              onClick={() => handleTool(id)}
              aria-pressed={activeTool === id || (id === "compare" && compare)}
              title={label}
            >
              <Icon size={19} strokeWidth={1.65} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}

      {activeTool === "section" && !chromeHidden && (
        <div className="section-control" aria-label="Cross-section depth">
          <span>Cut</span>
          <input
            type="range"
            min={-100}
            max={100}
            defaultValue={0}
            onChange={(event) =>
              viewerInstanceRef.current?.setCrossSectionDepth((Number(event.target.value) / 100) * 2.4)
            }
            aria-label="Cross-section depth"
          />
        </div>
      )}

      {quizMode && (
        <div className="quiz-mode-chip" role="status">
          Interactive quiz — click structures in the 3D model to answer
        </div>
      )}

      {!chromeHidden && (
        <aside className="tip-note" aria-label="Viewer instructions">
          <span><Sparkles size={15} /> Tip</span>
          <p>Drag to rotate<br />Scroll to zoom<br />Click a dot to learn more</p>
        </aside>
      )}

      {selected && (
        <div className="hotspot-callout" ref={calloutRef} data-side="right">
          <div className="callout-body" style={{ "--hotspot-color": selected.color } as React.CSSProperties}>
            <button className="callout-close" type="button" onClick={() => viewerInstanceRef.current?.clearSelection()} aria-label="Close">
              <X size={13} />
            </button>
            <b>{selected.label}</b>
            <small>{selected.detail}</small>
            {(() => {
              // Map the hotspot label back to a peelable layer so "Focus in 3D"
              // can fly the camera to the actual structure and highlight it.
              const layer =
                organ.layers?.find((l) => l.label === selected.label) ??
                organ.layers?.find((l) => selected.label.includes(l.label) || l.label.includes(selected.label));
              if (!layer) return null;
              return (
                <button
                  type="button"
                  className="callout-focus"
                  onClick={() => {
                    viewerInstanceRef.current?.focusLayer(layer.id);
                    viewerInstanceRef.current?.highlightLayer(layer.id);
                  }}
                >
                  <ScanEye size={13} /> Focus in 3D
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {/* Screen-reader equivalent of the dots, which live in the canvas. */}
      <ul className="hotspot-index">
        {(mode === "anterior" && organ.anteriorHotspots ? organ.anteriorHotspots : organ.hotspots).map(
          (hotspot) => (
            <li key={hotspot.id}>{hotspot.label}: {hotspot.detail}</li>
          ),
        )}
      </ul>

      {loading && slowLoad && (
        <div className="model-loader" role="status" aria-live="polite">
          <div className="loader-orbit"><Maximize2 size={20} /></div>
          <strong>Preparing the {organ.name.toLowerCase()}</strong>
          <span>{Math.max(8, Math.round(progress * 100))}%</span>
        </div>
      )}

      <button
        className={`auto-rotate ${chromeHidden ? "quiz-hidden" : ""}`}
        type="button"
        onClick={() => onAutoRotate(!autoRotate)}
        aria-pressed={autoRotate}
      >
        <RotateCcw size={14} /> Auto rotate
        <span className={`switch ${autoRotate ? "on" : ""}`}><i /></span>
      </button>

      <div className="view-caption">
        <span>3D specimen · click a dot to explore</span>
        <strong>{organ.scientificName}</strong>
      </div>
    </section>
  );
}
