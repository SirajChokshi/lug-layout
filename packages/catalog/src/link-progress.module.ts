import { ContainerModule, type Bind } from "inversify";
import { LinkProgress } from "./link-progress.ts";
import { LINK_PROGRESS } from "./tokens.ts";

export { reportingFetch, type ILinkProgress, type ILinkProgressShare } from "./link-progress.ts";
export { LINK_PROGRESS, LINK_PROGRESS_SHARE } from "./tokens.ts";

export function bindLinkProgress(bind: Bind): void {
  bind(LINK_PROGRESS).to(LinkProgress).inSingletonScope();
}

export const linkProgressModule = new ContainerModule(({ bind }) => bindLinkProgress(bind));
