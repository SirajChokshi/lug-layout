import type { EditorSnapshot } from "@brr/client";
import { useEffect, useMemo, useState } from "react";

const PENDING_CUE_DELAY_MS = 150;
const STEADY_SPEECH_MS = 400;

interface Moment {
  readonly text: string;
}

function useAfter(text: string | null, delayMs: number): string | null {
  const moment = useMemo<Moment | null>(() => (text === null ? null : { text }), [text]);
  const [reached, setReached] = useState<Moment | null>(null);
  useEffect(() => {
    if (moment === null) return undefined;
    const timer = window.setTimeout(() => setReached(moment), delayMs);
    return () => window.clearTimeout(timer);
  }, [moment, delayMs]);
  return moment !== null && reached === moment ? moment.text : null;
}

export function pendingSearch(snapshot: EditorSnapshot): string | null {
  const pose = snapshot.hover?.placement?.pose;
  if (!pose) return null;
  return `${snapshot.activeItem ?? ""} ${pose.x} ${pose.z} ${pose.yPlates} ${pose.rot}`;
}

export function useLateCue(search: string | null): boolean {
  return useAfter(search, PENDING_CUE_DELAY_MS) !== null;
}

export function useSteadySpeech(text: string | null): string {
  return useAfter(text, STEADY_SPEECH_MS) ?? "";
}
