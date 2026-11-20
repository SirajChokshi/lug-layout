import { CONTENT_HASH_HEX_DIGITS } from "../publish.ts";

const REFERENCED_FILE = new RegExp(
  String.raw`^(?:[^\s"/]+/)*[^\s"/]+\.([0-9a-f]{${CONTENT_HASH_HEX_DIGITS}})\.[a-z0-9]+$`,
  "u",
);

function collect(value: unknown, names: Set<string>): void {
  if (typeof value === "string") {
    if (REFERENCED_FILE.test(value)) names.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, names);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collect(item, names);
  }
}

export function referencedNames(value: unknown): Set<string> {
  const names = new Set<string>();
  collect(value, names);
  return names;
}

export function referencedDigest(name: string): string {
  const digest = REFERENCED_FILE.exec(name)?.[1];
  if (digest === undefined) throw new Error(`${name} is not content-addressed`);
  return digest;
}
