import {createHash} from 'node:crypto';

export type ArchiveReadProof={
  context_head_sha256:string;context_tail_sha256:string;image_count:number;skill_count:number;
};
export const ARCHIVE_READ_CONTROL_WIRE_NAME='codex_context_archive_ack';
export function createArchiveReadProof(contextText:string,imageCount:number,skillCount:number):ArchiveReadProof {
  const bytes=Buffer.from(contextText,'utf8');
  const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
  return {context_head_sha256:hash(bytes.subarray(0,256)),context_tail_sha256:hash(bytes.subarray(-256)),
    image_count:imageCount,skill_count:skillCount};
}
export function assertArchiveReadProof(value:unknown):asserts value is ArchiveReadProof {
  const proof=value as Partial<ArchiveReadProof>|null;
  if(!proof||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).length!==4
    ||typeof proof.context_head_sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.context_head_sha256)
    ||typeof proof.context_tail_sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.context_tail_sha256)
    ||!Number.isSafeInteger(proof.image_count)||proof.image_count!<0||proof.image_count!>1024
    ||!Number.isSafeInteger(proof.skill_count)||proof.skill_count!<0||proof.skill_count!>1024)
    throw new Error('Context archive read proof is invalid');
}
