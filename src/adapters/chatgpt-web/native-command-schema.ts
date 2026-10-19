import type {CodexTool} from '../../types';

interface Descriptor {name:string;description:string;}
const fieldTypes:Record<string,string>={cmd:'string',command:'string',workdir:'string',yield_time_ms:'number',max_output_tokens:'number',tty:'boolean'};

/** Metadata-only inventory; no command or arbitrary registry entry is invoked. */
export function nativeCommandRegistryProgram(marker:string):string{
 return [
  'if(typeof ALL_TOOLS==="undefined"||!Array.isArray(ALL_TOOLS))throw Error("Native command registry unavailable");',
  'const entries=ALL_TOOLS.filter(t=>t?.name==="exec_command"||t?.name==="shell_command");',
  'if(entries.length>8)throw Error("Native command registry is ambiguous");',
  'const nativeCommandTools=entries.map(t=>({name:t.name,description:typeof t.description==="string"?t.description:""}));',
  `text(${JSON.stringify(marker)}+JSON.stringify({tools:nativeCommandTools,total:nativeCommandTools.length}));`,
 ].join('\n');
}

/** Parse only the native registry's constrained declaration, never execute documentation.
 * A future declaration outside this grammar stays unavailable rather than guessed. */
export function resolveNativeCommandDescriptor(registry:readonly Descriptor[]):CodexTool{
 const preferred=registry.filter(t=>t.name==='exec_command');
 const candidates=preferred.length?preferred:registry.filter(t=>t.name==='shell_command');
 if(candidates.length!==1)throw Error('Native command registry missing or ambiguous');
 const selected=candidates[0]!;
 if(typeof selected.description!=='string'||selected.description.length>100000)throw Error('Native command schema unavailable');
 let candidateCount=0;
 const declarations=[...selected.description.matchAll(/```(?:ts|typescript)\s*\r?\n([\s\S]*?)```/g)].flatMap(block=>{
  const code=block[1]!.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\r\n]*/g,'');
  const prefix='declare\\s+const\\s+tools\\s*:\\s*\\{\\s*'+selected.name+'\\s*\\(';
  candidateCount += [...code.matchAll(new RegExp(prefix,'g'))].length;
  const pattern=new RegExp(prefix+'\\s*args\\s*:\\s*\\{([^{}]*)\\}\\s*\\)\\s*:\\s*Promise\\s*<','g');
  return [...code.matchAll(pattern)].map(match=>match[1]!);
 });
 if(candidateCount!==1||declarations.length!==1)throw Error('Native command schema missing or ambiguous');
 const properties:Record<string,{type:string}>={},required:string[]=[],seen=new Set<string>();
 for(const member of declarations[0]!.split(';').map(s=>s.trim()).filter(Boolean)){
  const match=/^([A-Za-z_$][A-Za-z0-9_$]*)(\?)?\s*:\s*(.+)$/.exec(member);
  if(!match||seen.has(match[1]!))throw Error('Native command schema has ambiguous fields');
  const [,field,optional,type]=match;seen.add(field!);
  const expected=fieldTypes[field!];
  if(!expected){if(!optional)throw Error('Native command schema requires unsupported arguments');continue;}
  if(type!.trim()!==expected)throw Error('Native command schema has unsupported field type');
  properties[field!]={type:expected};if(!optional)required.push(field!);
 }
 const command=selected.name==='exec_command'?'cmd':'command';
 if(properties[command]?.type!=='string')throw Error('Native command schema lacks the required command field');
 return {name:selected.name,description:selected.description,parameters:{type:'object',properties,required}};
}

/** Recheck the exact current descriptor immediately before each native invocation. */
export function nativeCommandDescriptorGuard(tool:CodexTool):string{
 return [
  'if(typeof ALL_TOOLS==="undefined"||!Array.isArray(ALL_TOOLS))throw Error("Native command registry unavailable");',
  `const selectedNativeEntries=ALL_TOOLS.filter(t=>t?.name===${JSON.stringify(tool.name)});`,
  `if(selectedNativeEntries.length!==1||selectedNativeEntries[0].description!==${JSON.stringify(tool.description)})throw Error("Native command schema changed before dispatch; no command invoked");`,
 ].join('\n');
}
