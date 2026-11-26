import { ContainerModule, type Bind } from "inversify";
import { LINK_PROGRESS } from "../tokens.ts";
import { LinkProgress } from "./link-progress.ts";

export function bindLinkProgress(bind: Bind): void {
  bind(LINK_PROGRESS).to(LinkProgress).inSingletonScope();
}

export const linkProgressModule = new ContainerModule(({ bind }) => bindLinkProgress(bind));
