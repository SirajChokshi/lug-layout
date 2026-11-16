import { handleRequest, type CatalogEnv } from "./catalog-api.ts";

export default {
  fetch(request: Request, env: CatalogEnv, context: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, context, caches.default);
  },
} satisfies ExportedHandler<CatalogEnv>;
