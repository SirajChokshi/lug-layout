import { CONTENT_HASH_HEX_DIGITS } from "../content-hash.ts";

const REFERENCED_FILE = new RegExp(
  String.raw`^(?:[^\s"/]+/)*[^\s"/]+\.([0-9a-f]{${CONTENT_HASH_HEX_DIGITS}})(\.[a-z0-9]+)$`,
  "u",
);

function collect(value: unknown, extensions: ReadonlySet<string>, names: Set<string>): void {
  if (typeof value === "string") {
    const extension = REFERENCED_FILE.exec(value)?.[2];
    if (extension !== undefined && extensions.has(extension)) names.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, extensions, names);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collect(item, extensions, names);
  }
}

export function referencedNames(value: unknown, extensions: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  collect(value, extensions, names);
  return names;
}

export function referencedDigest(name: string): string {
  const digest = REFERENCED_FILE.exec(name)?.[1];
  if (digest === undefined) throw new Error(`${name} is not content-addressed`);
  return digest;
}
