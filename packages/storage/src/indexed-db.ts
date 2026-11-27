export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", (event) =>
      reject(event.target instanceof IDBRequest ? event.target.error : transaction.error),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
}

export interface StoreSpec {
  readonly name: string;
  readonly keyPath?: string;
  readonly indexes?: ReadonlyArray<string>;
}

export function openDatabase(
  factory: IDBFactory,
  name: string,
  stores: ReadonlyArray<StoreSpec>,
): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.addEventListener("upgradeneeded", () => {
    for (const store of stores) {
      if (request.result.objectStoreNames.contains(store.name)) continue;
      const created =
        store.keyPath === undefined
          ? request.result.createObjectStore(store.name)
          : request.result.createObjectStore(store.name, { keyPath: store.keyPath });
      for (const keyPath of store.indexes ?? []) created.createIndex(keyPath, keyPath);
    }
  });
  return requestResult(request);
}

export async function inStore<T>(
  factory: IDBFactory,
  database: string,
  store: StoreSpec,
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase(factory, database, [store]);
  try {
    const transaction = db.transaction(store.name, mode);
    const [result] = await Promise.all([
      requestResult(use(transaction.objectStore(store.name))),
      transactionDone(transaction),
    ]);
    return result;
  } finally {
    db.close();
  }
}

export function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  });
}
