import type {BrokerToolResult} from './turn-broker';

const swiftObserverTools=new Map([
  ['mcp__computer_use_swift__desktop_observe','desktop.observe'],
  ['mcp__computer_use_swift__game_observe','game.observe'],
  ['mcp__computer_use_swift__desktop_execute_and_observe','desktop.execute_and_observe'],
  ['mcp__computer_use_swift__game_execute_and_observe','game.execute_and_observe'],
]);

/**
 * An existing Swift receipt may be useful even when the new observer has not
 * passed a real Web-model acceptance test. Publish only compatibility status
 * in that case: tool registration or native capture alone proves no replacement.
 * This is an annotation of the completed broker receipt, never a tool reroute.
 */
export function appendUnverifiedObserverCompatibility(
  wireName:string,response:BrokerToolResult,
):BrokerToolResult {
  const called_tool=swiftObserverTools.get(wireName);
  if(!called_tool||response.isError===true||!Array.isArray(response.content))return response;
  const source=response.structuredContent;
  if(!source||typeof source!=='object'||Array.isArray(source))return response;
  const envelope=source as Record<string,unknown>;
  if(envelope.ok!==true||envelope.observation_routing!==undefined)return response;
  const compound=called_tool.endsWith('.execute_and_observe');
  const data=envelope.data;
  const payload=data&&typeof data==='object'&&!Array.isArray(data)?data as Record<string,unknown>:undefined;
  const notice={version:1 as const,status:'LEGACY_COMPATIBILITY_ACTIVE' as const,
    severity:'advisory' as const,called_tool,replacement_available:false as const,
    image_delivery_status:'UNAVAILABLE' as const,reason:'observer_unavailable_or_unverified' as const,
    action_execution:(!compound?'none':payload?.status==='completed'?'completed':'unknown') as 'none'|'completed'|'unknown',
    ...(compound?{do_not_replay_action:true as const}:{})};
  return {...response,structuredContent:{...envelope,observation_routing:notice},
    content:[...response.content,{type:'text',text:JSON.stringify({observation_routing:notice})}]};
}
