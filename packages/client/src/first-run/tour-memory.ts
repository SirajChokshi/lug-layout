import { injectable } from "inversify";

export interface ITourMemory {
  visited(): boolean;
  markVisited(): void;
  tourDone(): boolean;
  rememberTourDone(): void;
}

const VISITED_KEY = "brr.firstRun.visited";
const TOUR_DONE_KEY = "brr.firstRun.tourDone";
const STORED_TRUE = "1";

function browserStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

@injectable()
export class LocalStorageTourMemory implements ITourMemory {
  visited(): boolean {
    return browserStorage()?.getItem(VISITED_KEY) === STORED_TRUE;
  }

  markVisited(): void {
    browserStorage()?.setItem(VISITED_KEY, STORED_TRUE);
  }

  tourDone(): boolean {
    return browserStorage()?.getItem(TOUR_DONE_KEY) === STORED_TRUE;
  }

  rememberTourDone(): void {
    browserStorage()?.setItem(TOUR_DONE_KEY, STORED_TRUE);
  }
}
