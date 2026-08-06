"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CircleHelp, RotateCcw, X } from "lucide-react";
import type { Organ, QuizQuestion } from "../lib/anatomy-data";
import { layerLabel } from "../lib/anatomy-data";
import type { AnatomyViewer } from "../lib/three/viewer";

type Props = {
  organ: Organ;
  viewerRef: React.RefObject<AnatomyViewer | null>;
  onClose: () => void;
};

type Phase = "answering" | "correct" | "revealed" | "finished";

/** Number of wrong attempts before the answer is revealed. */
const MAX_ATTEMPTS = 2;

export function QuizOverlay({ organ, viewerRef, onClose }: Props) {
  const questions = organ.quiz ?? [];
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("answering");
  const [score, setScore] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [missed, setMissed] = useState(0);

  const question: QuizQuestion | undefined = questions[index];
  /** Id of the last wrongly clicked structure, for the retry hint. */
  const lastWrongRef = useRef<string | null>(null);

  /** Applies a question's 3D state: highlight for identify, neutral for find,
   *  camera framed on the answer structure. */
  const showQuestion = useCallback(
    (i: number) => {
      const q = questions[i];
      if (!q) return;
      setIndex(i);
      setPhase("answering");
      setAttempts(0);
      viewerRef.current?.quizSetQuestion(q.answerLayerId, q.mode);
    },
    [questions, viewerRef],
  );

  // Enter quiz mode once, when the panel mounts.
  useEffect(() => {
    const viewerInstance = viewerRef.current;
    viewerInstance?.beginQuiz();
    return () => {
      viewerInstance?.endQuiz();
    };
  }, [viewerRef]);

  // Keeps the pick handler in sync with the latest state, so a canvas click
  // never reads stale phase/score values.
  const phaseRef = useRef(phase);
  const attemptsRef = useRef(attempts);
  phaseRef.current = phase;
  attemptsRef.current = attempts;

  const handlePick = useCallback(
    (layerId: string | null) => {
      const current = questions[indexRef.current];
      const viewerInstance = viewerRef.current;
      if (!current || !viewerInstance) return;
      if (phaseRef.current !== "answering") return;

      if (layerId === current.answerLayerId) {
        viewerInstance.quizFlashLayer(current.answerLayerId, "correct");
        setScore((value) => value + 1);
        setPhase("correct");
        return;
      }

      const nextAttempts = attemptsRef.current + 1;
      if (layerId) {
        viewerInstance.quizFlashLayer(layerId, "wrong");
        lastWrongRef.current = layerId;
      }
      if (nextAttempts >= MAX_ATTEMPTS) {
        // Reveal: flash the answer structure and explain.
        viewerInstance.quizFlashLayer(current.answerLayerId, "correct");
        setMissed((value) => value + 1);
        setPhase("revealed");
        return;
      }
      setAttempts(nextAttempts);
    },
    [questions, viewerRef],
  );

  // indexRef so handlePick can read the question without re-binding.
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const viewerInstance = viewerRef.current;
    if (viewerInstance) viewerInstance.onQuizPick = handlePick;
  });

  const next = () => {
    if (index + 1 < questions.length) showQuestion(index + 1);
    else setPhase("finished");
  };

  const restart = () => {
    setScore(0);
    setMissed(0);
    showQuestion(0);
  };

  if (!questions.length) return null;

  const total = questions.length;
  const answered = phase === "correct" || phase === "revealed";

  return (
    <div className="quiz-overlay" aria-label="Interactive 3D quiz">
      <section className="quiz-card" role="dialog" aria-modal="true" aria-labelledby="quiz-title">
        <header className="quiz-head">
          <span className="quiz-badge"><CircleHelp size={14} /> Quiz</span>
          <strong id="quiz-title">3D structure quiz</strong>
          <em>
            {phase === "finished" ? total : index + 1} / {total}
          </em>
          <button className="quiz-close" type="button" onClick={onClose} aria-label="Close quiz">
            <X size={15} />
          </button>
        </header>

        {phase === "finished" ? (
          <div className="quiz-summary">
            <span className={`quiz-score-ring ${score / total >= 0.8 ? "good" : score / total >= 0.5 ? "ok" : "poor"}`}>
              <b>{score}</b>
              <i>of {total}</i>
            </span>
            <h3>
              {score === total
                ? "Perfect — you know this eye inside out!"
                : score / total >= 0.8
                  ? "Excellent — almost flawless."
                  : score / total >= 0.5
                    ? "Solid — a quick review will make it stick."
                    : "A good start — replay the tour, then try again."}
            </h3>
            <p>
              You identified <b>{score}</b> of {total} structures
              {missed > 0 ? ` and revealed ${missed}` : ""} directly in the 3D model.
            </p>
            <div className="quiz-actions">
              <button type="button" className="quiz-primary" onClick={restart}>
                <RotateCcw size={14} /> Try again
              </button>
              <button type="button" className="quiz-secondary" onClick={onClose}>
                Back to exploring <ArrowRight size={14} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="quiz-prompt">
              <span className="quiz-mode-tag">{question!.mode === "identify" ? "✨ Highlighted" : "🔎 Find it"}</span>
              {question!.prompt}
            </p>

            <div
              className={`quiz-feedback ${phase === "correct" ? "correct" : phase === "revealed" ? "revealed" : ""}`}
              role="status"
              aria-live="polite"
            >
              {phase === "answering" && attempts === 0 && (
                <span className="quiz-hint">Click the structure in the 3D model to answer.</span>
              )}
              {phase === "answering" && attempts > 0 && (
                <span className="quiz-hint retry">Not quite — that was {layerLabel(organ, lastWrongRef.current ?? "")}. Try again!</span>
              )}
              {phase === "correct" && (
                <>
                  <b><Check size={14} /> Correct!</b>
                  <p>{question!.explain}</p>
                </>
              )}
              {phase === "revealed" && (
                <>
                  <b className="revealed-label">The answer is the {layerLabel(organ, question!.answerLayerId)}</b>
                  <p>{question!.explain}</p>
                </>
              )}
            </div>

            {phase === "answering" ? (
              <div className="quiz-actions">
                <button type="button" className="quiz-skip" onClick={next}>
                  Skip
                </button>
              </div>
            ) : (
              <div className="quiz-actions">
                <button type="button" className="quiz-primary" onClick={next} autoFocus>
                  {index + 1 < total ? "Next structure" : "See results"} <ArrowRight size={14} />
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
