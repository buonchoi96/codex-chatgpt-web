import type {BrokerToolResult} from './turn-broker';

/** Only the locally generated gateway emits this invocation-specific control frame. */
export function gatewayMetadataProgram(marker:string):string[] {
  return [
    'const mcpResult = result && typeof result === "object" && (Array.isArray(result.content) || Array.isArray(result.content_items));',
    'const relayMetadata = {version:1,mcp:Boolean(mcpResult)};',
    'if(mcpResult){for(const key of ["isError","structuredContent","_meta"])if(Object.hasOwn(result,key))relayMetadata[key]=result[key];}',
    'else if(result && typeof result === "object" && !Array.isArray(result) && !["image","audio"].includes(result.type) && !Object.hasOwn(result,"image_url") && !Object.hasOwn(result,"audio_url"))relayMetadata.structuredContent=result;',
    `text(${JSON.stringify(marker)} + JSON.stringify(relayMetadata));`,
  ];
}

export function restoreGatewayResultMetadata(result:BrokerToolResult,marker:string):BrokerToolResult {
  const frames=result.content.filter((item):item is {type:'text';text:string}=>Boolean(item&&typeof item==='object'
    &&(item as {type?:unknown}).type==='text'&&typeof (item as {text?:unknown}).text==='string'
    &&(item as {text:string}).text.startsWith(marker)));
  if(frames.length!==1)throw new Error('Native nested gateway result metadata was missing or ambiguous');
  const metadata:unknown=JSON.parse(frames[0]!.text.slice(marker.length));
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new Error('Native nested gateway result metadata was invalid');
  const value=metadata as Record<string,unknown>;
  if(value.version!==1||typeof value.mcp!=='boolean'
    ||Object.keys(value).some(key=>!['version','mcp','isError','structuredContent','_meta'].includes(key))
    ||(value.isError!==undefined&&typeof value.isError!=='boolean'))throw new Error('Native nested gateway result metadata was invalid');
  const restored:BrokerToolResult={...result,content:result.content.filter(item=>item!==frames[0])};
  if(value.mcp){
    for(const key of ['structuredContent','_meta'] as const)if(Object.hasOwn(value,key))restored[key]=value[key];
    if(Object.hasOwn(value,'isError'))restored.isError=result.isError===true||value.isError===true;
  }
  else if(Object.hasOwn(value,'structuredContent'))restored.structuredContent=value.structuredContent;
  return restored;
}
