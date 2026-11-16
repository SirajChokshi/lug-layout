---
name: add-service
description: Add an Inversify-wired application service (interface, typed symbol token, implementation, ContainerModule binding, tests) and optionally a worker-backed remote implementation over rpc. Use when adding or moving a service in client, an L2 adapter, a worker, or apps/web.
---

# Add a service

1. **Interface.** Write `I<Name>` in the package that owns the concept. Client services go in `packages/client/src/<area>/`, adapters in `storage`, `render`, `catalog` or `rpc`. An engine that runs in a worker gets its interface in the engine package (`sim`, `import`) so `client` can `import type` it.
2. **Token.** Add it to the owning package's `tokens.ts`:
   ```ts
   export const <NAME>: ServiceIdentifier<I<Name>> = Symbol.for("brr.<package>.<Name>");
   ```
3. **Implementation.**
   - In an Inversify-enabled package (client, storage, render, catalog, rpc, workers, web): `@injectable()` with `@inject(TOKEN)` on every constructor parameter. Depend on interfaces, never on concrete classes.
   - Plain class from a pure package (math, schema, domain, sim): no decorators. Bind it with `toDynamicValue(ctx => new X(ctx.get(A), ctx.get(B)))`.
   - Keep hot loops out of the service. Delegate to a pure engine that works on typed arrays.
4. **Bind** it in the package's `ContainerModule` with `.inSingletonScope()` unless there's a written reason not to. Load the module in each composition root that needs it (`apps/web/src/main.tsx`, `workers/*/src/entry.ts`).
5. **Remote variant** (the engine lives in a worker):
   - In `rpc`, add versioned request and response union members. Bulk data travels as transferable typed arrays.
   - The worker entry binds the real engine and serves it with the rpc server helper.
   - The main thread binds the same token to a `<Name>WorkerProxy` that implements `I<Name>`.
6. **Expose it to the UI** through view models or hooks in `client`. `ui` only ever sees the interface and the token.
7. **Tests** (pass the `.cursor/skills/test-audit` gate):
   - Test engine behavior directly.
   - Test service wiring by loading the real modules, overriding boundary tokens with fakes, and resolving by token.
   - If there's a proxy, add one round-trip test over an in-process `MessageChannel`. Don't repeat the engine's assertions at the proxy layer.
8. `pnpm check` is green.
