import { decode, decodedOrThrow } from "@brr/schema/decode";
import type * as v from "valibot";

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first(): Promise<unknown>;
  all(): Promise<{ readonly results: ReadonlyArray<unknown> }>;
  run(): Promise<unknown>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch(
    statements: SqlStatement[],
  ): Promise<ReadonlyArray<{ readonly results: ReadonlyArray<unknown> }>>;
}

export function decodedRow<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  row: unknown,
  table: string,
): v.InferOutput<TSchema> {
  return decodedOrThrow(decode(schema, row), `a row of ${table}`);
}

export function decodedRows<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  rows: ReadonlyArray<unknown>,
  table: string,
): Array<v.InferOutput<TSchema>> {
  return rows.map((row) => decodedRow(schema, row, table));
}
