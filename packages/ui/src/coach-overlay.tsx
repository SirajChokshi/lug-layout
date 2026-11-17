import type { CoachSnapshot, EditorSnapshot, ICoach, ToastView, TourView } from "@brr/client";
import { useEffect, useSyncExternalStore } from "react";

const TOAST_MS = 5_500;
const CELEBRATE_MS = 7_000;
const CONFETTI_PIECES = 36;
const CONFETTI_COLOURS: ReadonlyArray<string> = [
  "#c91a09",
  "#f2cd37",
  "#0055bf",
  "#237841",
  "#fe8a18",
  "#ffffff",
];
const CONFETTI_SPREAD_PERCENT = 100;
const CONFETTI_STEP_PERCENT = 37;
const CONFETTI_DELAY_STEP_MS = 23;
const CONFETTI_DELAY_CYCLE_MS = 420;
const CONFETTI_FALLS: ReadonlyArray<string> = [
  "confetti-fall-left",
  "confetti-fall",
  "confetti-fall-right",
];

export function useCoachSnapshot(coach: ICoach): CoachSnapshot {
  return useSyncExternalStore(
    (listener) => coach.subscribe(listener),
    () => coach.snapshot(),
  );
}

function Toast({ coach, toast }: { readonly coach: ICoach; readonly toast: ToastView }) {
  useEffect(() => {
    const timer = setTimeout(
      () => coach.dismissToast(toast.id),
      toast.kind === "celebrate" ? CELEBRATE_MS : TOAST_MS,
    );
    return () => clearTimeout(timer);
  }, [coach, toast]);
  return (
    <li className={`toast toast-${toast.kind}`} data-toast={toast.kind}>
      <button
        type="button"
        className="toast-body"
        aria-label={`${toast.title}. Dismiss`}
        onClick={() => coach.dismissToast(toast.id)}
      >
        <strong>{toast.title}</strong>
        <span>{toast.detail}</span>
      </button>
    </li>
  );
}

function Confetti({ burst }: { readonly burst: number }) {
  return (
    <div className="confetti" aria-hidden="true" key={burst}>
      {Array.from({ length: CONFETTI_PIECES }, (_unused, i) => (
        <span
          key={i}
          style={{
            left: `${(i * CONFETTI_STEP_PERCENT) % CONFETTI_SPREAD_PERCENT}%`,
            background: CONFETTI_COLOURS[i % CONFETTI_COLOURS.length],
            animationName: CONFETTI_FALLS[i % CONFETTI_FALLS.length],
            animationDelay: `${(i * CONFETTI_DELAY_STEP_MS) % CONFETTI_DELAY_CYCLE_MS}ms`,
          }}
        />
      ))}
    </div>
  );
}

function TourCard({ coach, tour }: { readonly coach: ICoach; readonly tour: TourView }) {
  const step = tour.steps[tour.step];
  if (tour.state !== "running" || !step) return null;
  return (
    <section className="tour" aria-label="Tour" aria-live="polite" data-tour-step={step.id}>
      <div className="tour-head">
        <span className="tour-count">
          Tour · {tour.step + 1} of {tour.steps.length}
        </span>
        <button type="button" className="tour-skip" onClick={() => coach.endTour()}>
          Skip
        </button>
      </div>
      <h2>{step.title}</h2>
      <p>{step.hint}</p>
      <div className="tour-foot">
        <span className="tour-keys">
          {step.keys.map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </span>
        <ol className="tour-dots" aria-hidden="true">
          {tour.steps.map((s, i) => (
            <li
              key={s.id}
              className={i < tour.step ? "done" : i === tour.step ? "current" : undefined}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}

interface CoachOverlayProps {
  readonly coach: ICoach;
  readonly snapshot: EditorSnapshot;
}

export function CoachOverlay({ coach, snapshot }: CoachOverlayProps) {
  const { tour, toasts } = useCoachSnapshot(coach);
  const celebration = toasts.findLast((toast) => toast.kind === "celebrate");
  return (
    <>
      {snapshot.status === "ready" && tour.state !== "running" && (
        <button type="button" className="tour-start" onClick={() => coach.startTour()}>
          <span aria-hidden="true">?</span> Tour
        </button>
      )}
      <TourCard coach={coach} tour={tour} />
      <ol className="toasts" role="status">
        {toasts.map((toast) => (
          <Toast key={toast.id} coach={coach} toast={toast} />
        ))}
      </ol>
      {celebration && <Confetti burst={celebration.id} />}
    </>
  );
}
