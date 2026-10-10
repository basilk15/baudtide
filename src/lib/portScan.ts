/** Scans may update the list, but cannot undo a choice or outlive the dialog. */
export class PortScanGuard {
  private generation = 0;
  private chosen = false;
  reset() { this.generation += 1; this.chosen = false; }
  choose() { this.chosen = true; }
  begin() { return ++this.generation; }
  isCurrent(scan: number) { return scan === this.generation; }
  canSelect(scan: number) { return this.isCurrent(scan) && !this.chosen; }
}
