export interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly args?: {
    readonly name?: string;
    readonly data?: { readonly type?: string };
  };
}

export interface Distribution {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface FrameTimes {
  readonly frames: number;
  readonly fps: number;
  readonly intervalMs: Distribution;
  readonly mainThreadJsMs: Distribution;
}

interface Thread {
  readonly pid: number;
  readonly tid: number;
}

const US_PER_MS = 1000;
const MS_PER_SECOND = 1000;
const P50 = 0.5;
const P95 = 0.95;
const RENDERER_MAIN = "CrRendererMain";
const FRAME_START = "FireAnimationFrame";
const JS_EVENTS: ReadonlySet<string> = new Set([
  "FunctionCall",
  "EventDispatch",
  "FireAnimationFrame",
  "TimerFire",
  "FireIdleCallback",
  "EvaluateScript",
  "RunMicrotasks",
  "v8.run",
  "v8.callFunction",
]);

export function distribution(values: ReadonlyArray<number>): Distribution {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
  return { count: sorted.length, p50: at(P50), p95: at(P95), max: sorted.at(-1) ?? 0 };
}

function isComplete(event: TraceEvent): event is TraceEvent & { readonly dur: number } {
  return event.ph === "X" && typeof event.dur === "number";
}

function onThread(event: TraceEvent, thread: Thread): boolean {
  return event.pid === thread.pid && event.tid === thread.tid;
}

export function rendererMain(events: ReadonlyArray<TraceEvent>): Thread {
  const mains = events.filter(
    (event) =>
      event.ph === "M" && event.name === "thread_name" && event.args?.name === RENDERER_MAIN,
  );
  let best: Thread | null = null;
  let bestFrames = -1;
  for (const main of mains) {
    const frames = events.filter(
      (event) => event.name === FRAME_START && onThread(event, main),
    ).length;
    if (frames > bestFrames) {
      best = { pid: main.pid, tid: main.tid };
      bestFrames = frames;
    }
  }
  if (best === null) throw new Error("the trace has no renderer main thread");
  return best;
}

function unionWithin(
  intervals: ReadonlyArray<readonly [number, number]>,
  from: number,
  to: number,
): number {
  let total = 0;
  let reach = from;
  for (const [start, end] of intervals) {
    const clippedStart = Math.max(start, reach);
    const clippedEnd = Math.min(end, to);
    if (clippedEnd > clippedStart) total += clippedEnd - clippedStart;
    reach = Math.max(reach, Math.min(end, to));
    if (start >= to) break;
  }
  return total;
}

export function frameTimes(events: ReadonlyArray<TraceEvent>): FrameTimes {
  const main = rendererMain(events);
  const starts = events
    .filter((event) => event.name === FRAME_START && isComplete(event) && onThread(event, main))
    .map((event) => event.ts)
    .toSorted((a, b) => a - b);
  const js = events
    .filter((event) => JS_EVENTS.has(event.name) && isComplete(event) && onThread(event, main))
    .map((event): readonly [number, number] => [event.ts, event.ts + (event.dur ?? 0)])
    .toSorted((a, b) => a[0] - b[0]);
  const intervals: number[] = [];
  const perFrame: number[] = [];
  for (let frame = 0; frame + 1 < starts.length; frame++) {
    const from = starts[frame] ?? 0;
    const to = starts[frame + 1] ?? from;
    intervals.push((to - from) / US_PER_MS);
    const firstJs = js.findIndex(([, end]) => end > from);
    perFrame.push(firstJs < 0 ? 0 : unionWithin(js.slice(firstJs), from, to) / US_PER_MS);
  }
  const spanMs = ((starts.at(-1) ?? 0) - (starts[0] ?? 0)) / US_PER_MS;
  return {
    frames: intervals.length,
    fps: spanMs > 0 ? (intervals.length * MS_PER_SECOND) / spanMs : 0,
    intervalMs: distribution(intervals),
    mainThreadJsMs: distribution(perFrame),
  };
}

export function dispatchMs(events: ReadonlyArray<TraceEvent>, type: string): Distribution {
  const main = rendererMain(events);
  return distribution(
    events
      .filter(
        (event) =>
          event.name === "EventDispatch" &&
          isComplete(event) &&
          onThread(event, main) &&
          event.args?.data?.type === type,
      )
      .map((event) => (event.dur ?? 0) / US_PER_MS),
  );
}
