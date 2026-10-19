/** A browser-owner budget for awaiting history proof, separate from the Stop timer. */
export class RecoveryHistoryWait {
  private startedAt?:number;
  constructor(private readonly now:()=>number) {}
  pending():'waiting'|'expired' {
    const observedAt=this.now();
    this.startedAt??=observedAt;
    return observedAt<this.startedAt||observedAt-this.startedAt>=180_000?'expired':'waiting';
  }
  ready():void {this.startedAt=undefined;}
}
