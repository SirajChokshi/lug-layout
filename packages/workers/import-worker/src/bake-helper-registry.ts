import type { IBakeHelper } from "@brr/import";
import { injectable } from "inversify";
import { BakeHelperProxy } from "./bake-helper-proxy.ts";

export interface IBakeHelperRegistry {
  use(ports: ReadonlyArray<MessagePort>): void;
  helpers(compilerUrl: string): ReadonlyArray<IBakeHelper>;
}

@injectable()
export class BakeHelperRegistry implements IBakeHelperRegistry {
  private proxies: ReadonlyArray<BakeHelperProxy> = [];

  use(ports: ReadonlyArray<MessagePort>): void {
    this.proxies = ports.map((port) => new BakeHelperProxy(port));
  }

  helpers(compilerUrl: string): ReadonlyArray<IBakeHelper> {
    return this.proxies.map((proxy) => proxy.helper(compilerUrl));
  }
}
