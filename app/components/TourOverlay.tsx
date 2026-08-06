"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Map, X } from "lucide-react";
import type { Organ, TourStep } from "../lib/anatomy-data";
import type { AnatomyViewer } from "../lib/three/viewer";

type Props = {
  organ: Organ;
  viewerRef: React.RefObject<AnatomyViewer | null>;
  onClose: () => void;
};

/** Guided anatomy tour: steps through `organ.tour`, focusing the camera on
 *  each structure, dimming the rest of the eye, and narrating what the
 *  learner is looking at. */
export function TourOverlay({ organ, viewerRef, onClose }: Props) {
  const steps = organ.tour ?? [];
  const [index, setIndex] = useState(0);
  const step: TourStep | undefined = steps[index];

  // Enter tour mode once, when the panel mounts.
  useEffect(() => {
    const viewerInstance = viewerRef.current;
    viewerInstance?.beginTour();
    return () => {
      viewerInstance?.endTour();
    };
  }, [viewerRef]);

  // Frame + highlight the current step whenever it changes.
  useEffect(() => {
    if (step) viewerRef.current?.tourStep(step.layerId);
  }, [index, step, viewerRef]);

  // Expose the current index so a keyboard handler could read it without
  // re-binding; harmless to keep even if unused for now.
  const indexRef = useRef(index);
  indexRef.current = index;

  if (!steps.length) return null;

  const isLast = index === steps.length - 1;

  return (
    <div className="tour-overlay" aria-label="Guided anatomy tour">
      <section className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <header className="tour-head">
          <span className="tour-badge"><Map size={14} /> Guided tour</span>
          <em>
            {index + 1} / {steps.length}
          </em>
          <button className="tour-close" type="button" onClick={onClose} aria-label="Close tour">
            <X size={15} />
          </button>
        </header>

        <h3 id="tour-title">{step!.title}</h3>
        <p className="tour-body">{step!.body}</p>

        <div className="tour-progress" aria-hidden="true">
          <i style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
        </div>

        <div className="tour-actions">
          <button
            type="button"
            className="tour-prev"
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
            disabled={index === 0}
            aria-label="Previous structure"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="tour-step-name">{step!.title}</span>
          <button
            type="button"
            className="tour-next"
            onClick={() => (isLast ? onClose() : setIndex((value) => value + 1))}
            autoFocus
          >
            {isLast ? "Finish" : "Next"} <ArrowRight size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}
