import { bakeTransferables, type BrickCompiler } from "@brr/import";
import { BAKE_HELPER_PROTOCOL, RpcEndpoint } from "@brr/rpc";
import type { BakeHelperReply, BakeHelperRequest, LibraryDelta } from "./bake-helper-protocol.ts";

interface HeldLibrary {
  key: string;
  readonly files: Map<string, string>;
  readonly absent: Set<string>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serveBakes(
  port: MessagePort,
  compilerFor: (url: string) => Promise<BrickCompiler>,
): void {
  const endpoint = new RpcEndpoint<BakeHelperReply, BakeHelperRequest>(port, BAKE_HELPER_PROTOCOL);
  const library: HeldLibrary = { key: "", files: new Map(), absent: new Set() };
  const snapshotWith = (delta: LibraryDelta): HeldLibrary => {
    if (delta.key !== library.key) {
      library.key = delta.key;
      library.files.clear();
      library.absent.clear();
    }
    for (const [path, text] of delta.files) library.files.set(path, text);
    for (const path of delta.absent) library.absent.add(path);
    return { key: library.key, files: new Map(library.files), absent: new Set(library.absent) };
  };
  endpoint.listen((request, id) => {
    const held = snapshotWith(request.library);
    compilerFor(request.compilerUrl)
      .then((compiler) => compiler.bake(request.request, held))
      .then(
        (outcome) =>
          endpoint.reply(
            id,
            { kind: "settled", outcome },
            outcome.status === "baked" ? bakeTransferables(outcome) : [],
          ),
        (error: unknown) => endpoint.reply(id, { kind: "threw", message: messageOf(error) }),
      );
  });
  port.start();
}
