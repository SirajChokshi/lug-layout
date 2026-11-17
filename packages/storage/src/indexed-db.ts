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

export function openDatabase(
  factory: IDBFactory,
  name: string,
  stores: ReadonlyArray<{ readonly name: string; readonly keyPath?: string }>,
): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.addEventListener("upgradeneeded", () => {
    for (const store of stores) {
      if (request.result.objectStoreNames.contains(store.name)) continue;
      if (store.keyPath === undefined) request.result.createObjectStore(store.name);
      else request.result.createObjectStore(store.name, { keyPath: store.keyPath });
    }
  });
  return requestResult(request);
}

export function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  });
}
