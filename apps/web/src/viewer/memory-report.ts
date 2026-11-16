import type { BufferMemory } from "@brr/client";

export interface MemoryReport extends BufferMemory {
  readonly jsHeapBytes: number | null;
}

function chromeJsHeapBytes(): number | null {
  const memory: unknown = Reflect.get(performance, "memory");
  if (typeof memory !== "object" || memory === null) return null;
  const used: unknown = Reflect.get(memory, "usedJSHeapSize");
  return typeof used === "number" ? used : null;
}

export function memoryReport(buffers: BufferMemory): MemoryReport {
  return { ...buffers, jsHeapBytes: chromeJsHeapBytes() };
}
