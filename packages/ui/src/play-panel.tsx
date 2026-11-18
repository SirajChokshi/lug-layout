import {
  PLAY_THROTTLE_STEP_LDU_PER_S,
  STUD_LDU,
  startPlay,
  type IEditor,
  type IEditorCamera,
  type IRunningGear,
  type ITrainPlay,
  type PlaySnapshot,
} from "@brr/client";
import { useEffect } from "react";
import { shortcutText } from "./keys.tsx";
import { RunningGearPanel } from "./running-gear-panel.tsx";
import { usePlaySnapshot } from "./use-play.ts";

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
  readonly runningGear: IRunningGear;
  readonly ready: boolean;
}

export function PlayPanel({ editor, camera, play, runningGear, ready }: PlayPanelProps) {
  const snapshot = usePlaySnapshot(play);
  useEffect(() => {
    followWith(camera, play, true);
    return () => play.follow(null);
  }, [camera, play]);
  const running = snapshot.status === "running";
  const trains = running ? undefined : editor.playSetup()?.models;
  const busy = snapshot.status === "loading";
  const derailed = snapshot.derailSpeedLduPerS > 0;
  const moving = snapshot.targetLduPerS !== 0 || snapshot.speedLduPerS !== 0;
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
          {trains?.length ? (
            <label>
              Train
              <select
                value={snapshot.trainModel ?? ""}
                disabled={busy}
                onChange={(event) => play.chooseTrain(event.target.value)}
              >
                {trains.map((train) => (
                  <option key={train.name} value={train.name}>
                    {train.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="toolbar-hint">Place a train on the layout to run it.</p>
          )}
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
            Puts the train on the longest run of laid track. Open ends are live: run off one and the
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
              disabled={derailed}
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
            <button type="button" disabled={derailed} onClick={() => play.drive(-max / 2)}>
              Back
            </button>
            <button type="button" disabled={derailed} onClick={() => play.drive(max / 2)}>
              Forward
            </button>
            <button type="button" disabled={derailed || !moving} onClick={() => play.drive(0)}>
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
          <RunningGearPanel gear={runningGear} />
        </div>
      )}
    </section>
  );
}
