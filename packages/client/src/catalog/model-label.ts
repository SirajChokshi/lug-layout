export function modelLabel(entry: {
  readonly name: string;
  readonly set: { readonly name: string; readonly year: number } | null;
}): string {
  return entry.set ? `${entry.name} ${entry.set.name} (${entry.set.year})` : entry.name;
}
