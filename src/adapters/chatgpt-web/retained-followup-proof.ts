import { createHash } from 'node:crypto';
import type { CodexMessage, CodexParsedRequest } from '../../types';
import { WEB_CONTEXT_POLICY_VERSION } from '../../web-context-policy';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messagesHash = (messages: CodexMessage[]) => hash(messages.map(({timestamp: _timestamp, ...message}) => message));
const policyHash = (parsed: CodexParsedRequest) => hash({model:parsed.modelId, options:parsed.options,
  family:parsed._chatgptModelFamily, system:parsed.context.systemPrompt, tools:parsed.context.tools, policy:WEB_CONTEXT_POLICY_VERSION});
const normalizedAnswer = (answer: string) => answer.replaceAll('\r\n','\n').trimEnd();
type Proof = {prefixLength:number;prefixHash:string;policyHash:string;answerHash:string;at:number};
export type RetainedReuseReason = 'verified'|'proof_missing'|'proof_expired'|'policy_changed'|'ancestry_changed'|'answer_boundary_changed'|'answer_changed';

/** Process-local optimization: a restart safely requires canonical rebootstrap. Launcher still proves tab ownership. */
export class RetainedConversationProofStore {
  private readonly proofs=new Map<string,Proof>();
  constructor(private readonly now:()=>number=Date.now) {}
  commit(key:string, parsed:CodexParsedRequest, answer:string):void {
    this.proofs.delete(key);
    this.proofs.set(key,{prefixLength:parsed.context.messages.length,prefixHash:messagesHash(parsed.context.messages),
      policyHash:policyHash(parsed),answerHash:hash(normalizedAnswer(answer)),at:this.now()});
    while(this.proofs.size>512) this.proofs.delete(this.proofs.keys().next().value!);
  }
  invalidate(key:string):void {this.proofs.delete(key);}
  check(key:string, parsed:CodexParsedRequest):{reason:RetainedReuseReason;parsed?:CodexParsedRequest} {
    const proof=this.proofs.get(key);
    if(!proof) return {reason:'proof_missing'};
    if(this.now()<proof.at||this.now()-proof.at>30*60000){this.proofs.delete(key);return {reason:'proof_expired'};}
    if(policyHash(parsed)!==proof.policyHash) return {reason:'policy_changed'};
    const messages=parsed.context.messages;
    if(messages.length<=proof.prefixLength||messagesHash(messages.slice(0,proof.prefixLength))!==proof.prefixHash) return {reason:'ancestry_changed'};
    const boundary=messages.findLastIndex(message=>message.role==='assistant');
    if(boundary!==proof.prefixLength||boundary===messages.length-1) return {reason:'answer_boundary_changed'};
    const terminal=messages[boundary]!;
    if(terminal.role!=='assistant'||terminal.content.some(part=>part.type==='toolCall')) return {reason:'answer_boundary_changed'};
    const answer=terminal.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('');
    if(!answer||hash(normalizedAnswer(answer))!==proof.answerHash) return {reason:'answer_changed'};
    return {reason:'verified',parsed:{...parsed,context:{...parsed.context,messages:messages.slice(boundary+1)}}};
  }
}

export const retainedConversationProofs=new RetainedConversationProofStore();
