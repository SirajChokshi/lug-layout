export const NO_PROPOSAL_SLOT = -1;

export class ProposalProgress {
  finder = 0;
  turn = 0;
  cell = 0;
  slot = NO_PROPOSAL_SLOT;
  revision = 0;
  started = false;
  resumed = false;

  restart(): void {
    this.finder = 0;
    this.started = false;
    this.restartFinder();
  }

  finishFinder(): void {
    this.finder++;
    this.restartFinder();
  }

  private restartFinder(): void {
    this.turn = 0;
    this.cell = 0;
    this.slot = NO_PROPOSAL_SLOT;
    this.resumed = false;
  }
}
