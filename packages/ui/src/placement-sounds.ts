import type { EditorSnapshot, GhostFeedbackView, LatencySample } from "@brr/client";
import { useEffect, useRef, useState } from "react";

const SOUND_KEY = "brr.sound";
const NOISE_SECONDS = 0.05;
const VIBRATE_MS = 8;
const SNAP_TICK_GAP_MS = 400;

interface Blip {
  readonly type: OscillatorType;
  readonly fromHz: number;
  readonly toHz: number;
  readonly seconds: number;
  readonly gain: number;
}

const SNAP_TICK: Blip = { type: "sine", fromHz: 2400, toHz: 2900, seconds: 0.035, gain: 0.07 };
const CLACK_TONE: Blip = { type: "triangle", fromHz: 1700, toHz: 700, seconds: 0.06, gain: 0.16 };
const POP: Blip = { type: "sine", fromHz: 700, toHz: 260, seconds: 0.09, gain: 0.14 };
const BONK: Blip = { type: "triangle", fromHz: 210, toHz: 120, seconds: 0.16, gain: 0.22 };
const CLACK_BAND_HZ = 2600;
const CLACK_NOISE_GAIN = 0.35;

class PlacementSounds {
  private context: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  private ready(): AudioContext | null {
    if (typeof AudioContext === "undefined") return null;
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }

  private blip(context: AudioContext, blip: Blip, delaySeconds = 0): void {
    const start = context.currentTime + delaySeconds;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = blip.type;
    oscillator.frequency.setValueAtTime(blip.fromHz, start);
    oscillator.frequency.exponentialRampToValueAtTime(blip.toHz, start + blip.seconds);
    gain.gain.setValueAtTime(blip.gain, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + blip.seconds);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + blip.seconds);
  }

  private noiseBuffer(context: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const length = Math.ceil(context.sampleRate * NOISE_SECONDS);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    this.noise = buffer;
    return buffer;
  }

  clack(): void {
    const context = this.ready();
    if (!context) return;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer(context);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = CLACK_BAND_HZ;
    const gain = context.createGain();
    gain.gain.value = CLACK_NOISE_GAIN;
    source.connect(band).connect(gain).connect(context.destination);
    source.start();
    this.blip(context, CLACK_TONE);
    if ("vibrate" in navigator) navigator.vibrate(VIBRATE_MS);
  }

  tick(): void {
    const context = this.ready();
    if (context) this.blip(context, SNAP_TICK);
  }

  pop(): void {
    const context = this.ready();
    if (context) this.blip(context, POP);
  }

  bonk(): void {
    const context = this.ready();
    if (!context) return;
    this.blip(context, BONK);
    this.blip(context, BONK, BONK.seconds * 0.8);
  }
}

function playEdit(sounds: PlacementSounds, sample: LatencySample): void {
  if (sample.step !== "do") {
    sounds.tick();
    return;
  }
  switch (sample.action) {
    case "place":
    case "track":
    case "road":
      sounds.clack();
      return;
    case "remove":
    case "erase":
      sounds.pop();
      return;
    case "rotate":
      sounds.tick();
      return;
    default: {
      const unhandled: never = sample.action;
      throw new Error(`unhandled edit ${String(unhandled)}`);
    }
  }
}

function readSoundPreference(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

export function useSoundPreference(): readonly [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readSoundPreference);
  const set = (next: boolean): void => {
    setOn(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      return;
    }
  };
  return [on, set];
}

export function usePlacementSounds(snapshot: EditorSnapshot, enabled: boolean): void {
  const sounds = useRef<PlacementSounds | null>(null);
  const lastSample = useRef<LatencySample | null>(snapshot.lastLatency);
  const refused = useRef(snapshot.refusedClicks);
  const trackRefusals = useRef(snapshot.track?.refusals ?? 0);
  const lastTickMs = useRef(Number.NEGATIVE_INFINITY);
  const feedback = useRef<GhostFeedbackView | null>(snapshot.ghostFeedback);

  useEffect(() => {
    sounds.current ??= new PlacementSounds();
    const player = sounds.current;
    const sample = snapshot.lastLatency;
    const newSample = sample !== null && sample !== lastSample.current;
    const newRefusal = snapshot.refusedClicks > refused.current;
    const newTrackRefusal = (snapshot.track?.refusals ?? 0) > trackRefusals.current;
    const snapped =
      snapshot.ghostFeedback?.tone === "snapped" && feedback.current?.tone !== "snapped";
    lastSample.current = sample;
    refused.current = snapshot.refusedClicks;
    trackRefusals.current = snapshot.track?.refusals ?? 0;
    feedback.current = snapshot.ghostFeedback;
    if (!enabled) return;
    if (newRefusal || newTrackRefusal) player.bonk();
    else if (newSample) playEdit(player, sample);
    else if (snapped && performance.now() - lastTickMs.current > SNAP_TICK_GAP_MS) {
      lastTickMs.current = performance.now();
      player.tick();
    }
  }, [snapshot, enabled]);
}
