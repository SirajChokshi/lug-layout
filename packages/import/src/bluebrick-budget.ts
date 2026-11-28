import type { BricklinkPartCandidates } from "@brr/catalog";
import type { BomLine } from "@brr/domain";
import type { BlueBrickBudgetRead } from "@brr/schema/bluebrick";
import {
  BlueBrickPartMapper,
  MirrorPartResolver,
  type BlueBrickBudgetMapping,
} from "./bluebrick-mapping.ts";
import type { BrickCompiler } from "./brick-compiler.ts";
import type { LdrawMirror } from "./ldraw-mirror.ts";
import { bundlePartId } from "./model-import.ts";
import { BricklinkPartsCrosswalk } from "./studio-mapping.ts";

export interface BlueBrickBudgetInput {
  readonly bytes: Uint8Array;
  readonly bricklinkParts: BricklinkPartCandidates;
  readonly ldconfigCodes: ReadonlyArray<number>;
  readonly omrModels: ReadonlyArray<string>;
}

export type BlueBrickBudgetImport =
  | {
      readonly status: "read";
      readonly lines: ReadonlyArray<BomLine>;
      readonly unread: ReadonlyArray<BlueBrickBudgetMapping>;
    }
  | Extract<BlueBrickBudgetRead, { readonly status: "rejected" }>;

export async function importBlueBrickBudget(
  compiler: Pick<BrickCompiler, "readBlueBrickBudget" | "readModel">,
  mirror: Pick<LdrawMirror, "file">,
  input: BlueBrickBudgetInput,
): Promise<BlueBrickBudgetImport> {
  const read = compiler.readBlueBrickBudget(input.bytes);
  if (read.status === "rejected") return read;
  const mapper = new BlueBrickPartMapper(
    new MirrorPartResolver(compiler, mirror),
    new BricklinkPartsCrosswalk(input.bricklinkParts),
    new Set(input.ldconfigCodes),
    new Set(input.omrModels),
  );
  const brought = (await mapper.mapBudget(read.budget)).filter((entry) => entry.count > 0);
  return {
    status: "read",
    lines: brought.flatMap(({ count, outcome }) =>
      outcome.kind === "part"
        ? [{ part: bundlePartId(outcome.part), ldrawColor: outcome.color, quantity: count }]
        : [],
    ),
    unread: brought.filter((entry) => entry.outcome.kind !== "part"),
  };
}
