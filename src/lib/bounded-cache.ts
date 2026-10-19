// Reused from archive commit b7ed23d8c89f71a1920a5c81d2dd94c870e249ee.
/** Process-local LRU with independent entry/weight limits and a non-sliding lifetime. */
export class BoundedCache<K,V>{
 private readonly entries=new Map<K,{key:K;value:V;weight:number;expiresAt:number}>();
 private weight=0;
 constructor(private readonly maxEntries:number,private readonly maxWeight:number,
  private readonly lifetimeMs:number,private readonly now=()=>performance.now()){
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||!Number.isSafeInteger(maxWeight)||maxWeight<1
   ||!Number.isFinite(lifetimeMs)||lifetimeMs<=0)throw new Error('Cache limits must be positive and finite');
 }
 get(key:K):V|undefined{
  const entry=this.entries.get(key);if(!entry)return undefined;this.entries.delete(key);
  if(entry.expiresAt<=this.now()){this.weight-=entry.weight;return undefined;}
  // Retain the admitted owned key, not a lookup slice backed by a large request.
  this.entries.set(entry.key,entry);return entry.value;
 }
 set(key:K,value:V,weight:number):void{
  if(!Number.isSafeInteger(weight)||weight<0)throw new Error('Cache weight must be non-negative');
  const previous=this.entries.get(key);if(previous){this.entries.delete(key);this.weight-=previous.weight;}
  if(weight>this.maxWeight)return;const now=this.now();
  for(const [cachedKey,entry] of this.entries)if(entry.expiresAt<=now){this.entries.delete(cachedKey);this.weight-=entry.weight;}
  this.entries.set(key,{key,value,weight,expiresAt:now+this.lifetimeMs});this.weight+=weight;
  while(this.entries.size>this.maxEntries||this.weight>this.maxWeight){
   const oldest=this.entries.entries().next().value;if(!oldest)break;this.entries.delete(oldest[0]);this.weight-=oldest[1].weight;
  }
 }
 clear():void{this.entries.clear();this.weight=0;}
 stats():{entries:number;bytes:number}{return{entries:this.entries.size,bytes:this.weight};}
}
