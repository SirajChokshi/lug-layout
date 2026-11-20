const TYPED_ARRAYS = [
  "Float64Array",
  "Float32Array",
  "Int32Array",
  "Uint32Array",
  "Int16Array",
  "Uint16Array",
  "Int8Array",
  "Uint8Array",
] as const;

export async function typedArraysConstructedDuring(
  run: () => void | Promise<void>,
): Promise<number> {
  const global = globalThis as unknown as Record<string, new (...args: never[]) => unknown>;
  const originals = TYPED_ARRAYS.map((name) => global[name]);
  let constructed = 0;
  TYPED_ARRAYS.forEach((name, i) => {
    const Original = originals[i];
    if (!Original) return;
    global[name] = class extends (Original as new (...args: unknown[]) => object) {
      constructor(...args: unknown[]) {
        super(...args);
        constructed++;
      }
    } as unknown as new (...args: never[]) => unknown;
  });
  try {
    await run();
  } finally {
    TYPED_ARRAYS.forEach((name, i) => {
      const Original = originals[i];
      if (Original) global[name] = Original;
    });
  }
  return constructed;
}
