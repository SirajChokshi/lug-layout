import { SystemClock } from "./clock.ts";
import { createLayoutApi, type LayoutEnv } from "./composition.ts";
import type { LayoutApi } from "./layout-api.ts";
import { CryptoRandomSource } from "./random.ts";

const apis = new WeakMap<LayoutEnv, LayoutApi>();

function apiFor(env: LayoutEnv): LayoutApi {
  const existing = apis.get(env);
  if (existing !== undefined) return existing;
  const api = createLayoutApi(env, new SystemClock(), new CryptoRandomSource());
  apis.set(env, api);
  return api;
}

export default {
  fetch(request: Request, env: LayoutEnv): Promise<Response> {
    return apiFor(env).handle(request);
  },
  async scheduled(controller: ScheduledController, env: LayoutEnv): Promise<void> {
    await apiFor(env).maintain(controller.scheduledTime);
  },
} satisfies ExportedHandler<LayoutEnv>;
