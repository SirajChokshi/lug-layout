export class RequestOrder {
  private adopted: Promise<void> = Promise.resolve();

  adopt<T, R>(fetching: Promise<T>, adoption: (fetched: T) => R): Promise<R> {
    const previous = this.adopted;
    const adopting = Promise.all([previous, fetching]).then(([, fetched]) => adoption(fetched));
    this.adopted = Promise.all([previous, adopting.catch(() => undefined)]).then(() => undefined);
    return adopting;
  }
}
