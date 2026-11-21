export interface PersistentStorage {
  persist(): Promise<boolean>;
}

export function isPersistentStorage(storage: unknown): storage is PersistentStorage {
  return (
    typeof storage === "object" &&
    storage !== null &&
    typeof Reflect.get(storage, "persist") === "function"
  );
}
