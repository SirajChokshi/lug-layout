import type { BrickCompiler } from "./brick-compiler.ts";
import { lineReference, sectionList, subfileName, type MpdSection } from "./custom-parts.ts";

export interface LayoutPart {
  readonly name: string;
  readonly text: string;
}

const DRAWING_LINE = /^\s*[1-5](?:\s|$)/u;

function reachedSections(
  lines: ReadonlyArray<string>,
  named: ReadonlyMap<string, MpdSection>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending: Array<ReadonlyArray<string>> = [lines];
  for (let from = pending.pop(); from !== undefined; from = pending.pop()) {
    for (const line of from) {
      const reference = lineReference(line);
      const section = reference === null ? undefined : named.get(reference);
      if (reference === null || section === undefined || reached.has(reference)) continue;
      reached.add(reference);
      pending.push(section.lines);
    }
  }
  return reached;
}

export function layoutParts(
  compiler: Pick<BrickCompiler, "readModel">,
  fileName: string,
  text: string,
): ReadonlyArray<LayoutPart> {
  const inlineParts = new Set(compiler.readModel(text).inlineParts.map((part) => part.inline));
  const sections = sectionList(text);
  const [main] = sections;
  if (main === undefined) return [];
  const named = new Map(
    sections.flatMap((section) =>
      section.name === null ? [] : [[section.name, section] as const],
    ),
  );
  const isSubmodel = (line: string): boolean => {
    const reference = lineReference(line);
    return reference !== null && named.has(reference) && !inlineParts.has(reference);
  };
  const piece = (name: string, keep: (line: string, at: number) => boolean): LayoutPart => {
    const kept = main.lines.filter((line, at) => !DRAWING_LINE.test(line) || keep(line, at));
    const reached = reachedSections(kept, named);
    const closure = sections.filter(
      (section) =>
        section !== main &&
        section.name !== null &&
        reached.has(section.name) &&
        named.get(section.name) === section,
    );
    return { name, text: [...kept, ...closure.flatMap((section) => section.lines)].join("\n") };
  };
  const submodels = main.lines.flatMap((line, index) => {
    const name = subfileName(line);
    return name !== null && isSubmodel(line) ? [piece(name, (_, at) => at === index)] : [];
  });
  const loose = main.lines.some((line) => DRAWING_LINE.test(line) && !isSubmodel(line));
  return loose ? [piece(fileName, (line) => !isSubmodel(line)), ...submodels] : submodels;
}
