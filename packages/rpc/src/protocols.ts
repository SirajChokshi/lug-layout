import type { RpcProtocol } from "./rpc-endpoint.ts";

export const SIM_PROTOCOL: RpcProtocol = { name: "brr.sim", version: 3 };
export const IMPORT_PROTOCOL: RpcProtocol = { name: "brr.import", version: 1 };
export const BAKE_HELPER_PROTOCOL: RpcProtocol = { name: "brr.bakeHelper", version: 1 };
export const LINK_PROGRESS_PROTOCOL: RpcProtocol = { name: "brr.linkProgress", version: 1 };

export type BakeHelperHandoff =
  | { readonly kind: "useBakeHelpers"; readonly ports: ReadonlyArray<MessagePort> }
  | { readonly kind: "serveBakes"; readonly port: MessagePort };
