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
import { useEditorSnapshot } from "./use-editor.ts";
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
  readonly checkingStuds: boolean;
}

function playButtonText(busy: boolean, checkingStuds: boolean, onRails: number): string {
  if (busy) return "Starting the trains…";
  if (checkingStuds) return "Checking studs";
  return `Run ${onRails > 1 ? `${onRails} trains` : "the train"} (${shortcutText("play")})`;
}

export function PlayPanel({
  editor,
  camera,
  play,
  runningGear,
  ready,
  checkingStuds,
}: PlayPanelProps) {
  const snapshot = usePlaySnapshot(play);
  const { trains } = useEditorSnapshot(editor);
  useEffect(() => {
    followWith(camera, play, true);
    return () => play.follow(null);
  }, [camera, play]);
  const running = snapshot.status === "running";
  const onRails = trains.filter((train) => train.onRails).length;
  const refusal = running ? null : play.refusal();
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
      data-train-x={snapshot.trainXLdu.toFixed(1)}
      data-train-z={snapshot.trainZLdu.toFixed(1)}
      data-switches={snapshot.switches.map((s) => (s.diverging ? "d" : "s")).join("")}
      data-tick={snapshot.tick}
      data-trains={running ? snapshot.trains.length : onRails}
      data-driven={snapshot.driven}
    >
      <h2>Play</h2>
      {!running && (
        <div className="play-start">
          {trains.length > 0 ? (
            <ul className="play-trains" aria-label="Trains on the rails">
              {trains.map((train, index) => (
                <li key={index} data-on-rails={train.onRails}>
                  {train.label}
                  {!train.onRails && (
                    <>
                      <span className="play-error"> — off the rails</span>{" "}
                      <button
                        type="button"
                        onClick={(event) => editor.removeTrain(index, event.timeStamp)}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="toolbar-hint">
              Hold a train over laid track: it sets itself on the rails there. R turns it round.
            </p>
          )}
          <button
            type="button"
            className="play-primary"
            data-action="play"
            disabled={!ready || busy || checkingStuds || refusal !== null}
            onClick={() => startPlay(editor, play)}
          >
            {playButtonText(busy, checkingStuds, onRails)}
          </button>
          {refusal !== null && (
            <p className="toolbar-hint" data-play-refusal="">
              {refusal}
            </p>
          )}
          {snapshot.error && <p className="play-error">{snapshot.error}</p>}
          <p className="toolbar-hint">
            Every train starts where it stands on the rails. Open ends are live: run off one and the
            train derails.
          </p>
        </div>
      )}
      {running && (
        <div className="play-controls">
          {snapshot.trains.length > 1 && (
            <label className="play-driven">
              <span>Drive</span>
              <select
                value={snapshot.driven}
                onChange={(event) => play.chooseDriven(Number(event.target.value))}
              >
                {snapshot.trains.map((train) => (
                  <option key={train.index} value={train.index}>
                    {train.index + 1}. {train.label}
                  </option>
                ))}
              </select>
            </label>
          )}
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
