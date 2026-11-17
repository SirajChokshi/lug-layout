import {
  PLAY_THROTTLE_STEP_LDU_PER_S,
  STUD_LDU,
  startPlay,
  type IEditor,
  type IEditorCamera,
  type ITrainPlay,
  type PlaySnapshot,
} from "@brr/client";
import { useEffect, useSyncExternalStore } from "react";
import { shortcutText } from "./keys.tsx";

export function usePlaySnapshot(play: ITrainPlay): PlaySnapshot {
  return useSyncExternalStore(
    (listener) => play.subscribe(listener),
    () => play.snapshot(),
  );
}

function followWith(camera: IEditorCamera, play: ITrainPlay, on: boolean): void {
  play.follow(on ? (x, z) => camera.lookAt(x, z, false) : null);
}

function studsPerSecond(lduPerS: number): string {
  return (Math.abs(lduPerS) / STUD_LDU).toFixed(1);
}

function motionText(snapshot: PlaySnapshot): string {
  if (snapshot.derailSpeedLduPerS > 0) return "derailed";
  if (snapshot.speedLduPerS === 0) return snapshot.targetLduPerS === 0 ? "stopped" : "starting";
  const way = snapshot.direction < 0 ? "backward" : "forward";
  return `${studsPerSecond(snapshot.speedLduPerS)} studs/s ${way}`;
}

interface PlayPanelProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
  readonly play: ITrainPlay;
  readonly ready: boolean;
}

export function PlayPanel({ editor, camera, play, ready }: PlayPanelProps) {
  const snapshot = usePlaySnapshot(play);
  useEffect(() => {
    if (ready) play.offer(editor.playSetup());
  }, [editor, play, ready]);
  useEffect(() => {
    followWith(camera, play, true);
    return () => play.follow(null);
  }, [camera, play]);
  const running = snapshot.status === "running";
  const busy = snapshot.status === "loading";
  const max = snapshot.maxSpeedLduPerS;
  return (
    <section
      className="inspector play-panel"
      aria-label="Play"
      data-play-status={snapshot.status}
      data-speed={snapshot.speedLduPerS.toFixed(1)}
      data-direction={snapshot.direction}
      data-derail-speed={snapshot.derailSpeedLduPerS}
      data-bogies-off={snapshot.bogiesOffTrack}
      data-switches={snapshot.switches.map((s) => (s.diverging ? "d" : "s")).join("")}
      data-tick={snapshot.tick}
    >
      <h2>Play</h2>
      {!running && (
        <div className="play-start">
          <label>
            Train set
            <select
              value={snapshot.setId}
              disabled={busy}
              onChange={(event) => play.chooseSet(event.target.value)}
            >
              {snapshot.sets.map((set) => (
                <option key={set.id} value={set.id} disabled={!set.available}>
                  {set.available ? set.label : `${set.label} (not in the bundle)`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="play-primary"
            data-action="play"
            disabled={!ready || busy}
            onClick={() => startPlay(editor, play)}
          >
            {busy ? "Putting the train on the track…" : `Run a train (${shortcutText("play")})`}
          </button>
          {snapshot.error && <p className="play-error">{snapshot.error}</p>}
          <p className="toolbar-hint">
            Puts the set on the longest run of laid track. Open ends are live: run off one and the
            train derails.
          </p>
        </div>
      )}
      {running && (
        <div className="play-controls">
          <p className="play-motion" aria-live="polite">
            {motionText(snapshot)}
          </p>
          {snapshot.derailSpeedLduPerS > 0 && (
            <div className="play-derailed" role="alert">
              <span>
                Derailed: ran off an open end at {studsPerSecond(snapshot.derailSpeedLduPerS)}{" "}
                studs/s.
              </span>
              <button type="button" data-action="rerail" onClick={() => play.rerail()}>
                Rerail ({shortcutText("rerail")})
              </button>
            </div>
          )}
          <label className="play-throttle">
            <span>Throttle</span>
            <input
              type="range"
              min={-max}
              max={max}
              step={PLAY_THROTTLE_STEP_LDU_PER_S / 2}
              value={snapshot.targetLduPerS}
              onChange={(event) => play.drive(Number(event.target.value))}
            />
          </label>
          <label className="play-follow">
            <input
              type="checkbox"
              checked={snapshot.following}
              onChange={(event) => followWith(camera, play, event.target.checked)}
            />
            Follow the train
          </label>
          <div className="toolbar">
            <button type="button" onClick={() => play.drive(-max / 2)}>
              Back
            </button>
            <button type="button" onClick={() => play.drive(max / 2)}>
              Forward
            </button>
            <button type="button" onClick={() => play.drive(0)}>
              Stop ({shortcutText("stop-train")})
            </button>
            <button type="button" data-action="stop-play" onClick={() => play.stop()}>
              Leave play ({shortcutText("play")})
            </button>
          </div>
          {snapshot.switches.length > 0 && (
            <ul className="play-switches" aria-label="Switches">
              {snapshot.switches.map((view) => (
                <li key={view.index}>
                  <span>{view.label}</span>
                  <button
                    type="button"
                    aria-pressed={view.diverging}
                    onClick={() => play.throwSwitch(view.index)}
                  >
                    {view.diverging ? "diverging" : "straight"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {snapshot.notice && <p className="play-error">{snapshot.notice}</p>}
          <p className="toolbar-hint">
            {shortcutText("throttle-up")}/{shortcutText("throttle-down")} throttle,{" "}
            {shortcutText("stop-train")} stops, {shortcutText("rerail")} rerails. Going the other
            way brakes, stops and reverses. Click a switch on the layout to throw it.
          </p>
        </div>
      )}
    </section>
  );
}
