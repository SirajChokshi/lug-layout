export interface IClock {
  now(): number;
}

export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
}
