import * as v from "valibot";

export type Issue = {
  readonly path: string;
  readonly message: string;
};

export type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ReadonlyArray<Issue> };

export function issueText(issues: ReadonlyArray<Issue>): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

export function decode<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
  root = "$",
): Decoded<v.InferOutput<TSchema>> {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true, value: result.output };
  return {
    ok: false,
    issues: result.issues.map((issue) => {
      const dotPath = v.getDotPath(issue);
      return { path: dotPath === null ? root : `${root}.${dotPath}`, message: issue.message };
    }),
  };
}

export function decodedOrThrow<T>(result: Decoded<T>, label: string): T {
  if (result.ok) return result.value;
  throw new Error(`${label}: ${issueText(result.issues)}`);
}
