import {expect,test} from 'bun:test';
import {resolveNativeCommandDescriptor,nativeCommandDescriptorGuard} from '../src/adapters/chatgpt-web/native-command-schema';

function description(name:string,body:string){return 'Native tool.\n```ts\ndeclare const tools: { '+name+'(args: {\n'+body+'\n}): Promise<unknown>; };\n```';}
const exec=()=>({name:'exec_command',description:description('exec_command','cmd: string;\nworkdir?: string;\nyield_time_ms?: number;\nmax_output_tokens?: number;\ntty?: boolean;\nsandbox_permissions?: "use_default" | "require_escalated";')});
test('native registry declaration supplies exact supported command option types',()=>{
 const tool=resolveNativeCommandDescriptor([exec()]);
 expect(tool.name).toBe('exec_command');
 expect(tool.parameters).toEqual({type:'object',properties:{cmd:{type:'string'},workdir:{type:'string'},yield_time_ms:{type:'number'},max_output_tokens:{type:'number'},tty:{type:'boolean'}},required:['cmd']});
 expect(tool.description).toBe(exec().description);
});
test('exec is preferred over legacy shell but duplicate preferred interfaces are ambiguous',()=>{
 const shell={name:'shell_command',description:description('shell_command','command: string; timeout_ms?: number;')};
 expect(resolveNativeCommandDescriptor([shell,exec()]).name).toBe('exec_command');
 expect(()=>resolveNativeCommandDescriptor([exec(),exec(),shell])).toThrow('ambiguous');
 expect(resolveNativeCommandDescriptor([shell]).parameters.properties).toEqual({command:{type:'string'}});
});
test.each(['plain prose','```ts\ncmd: string;\n```',description('other','cmd: string;'),description('exec_command','cmd: string;')+'\n'+description('exec_command','cmd: string;')])('missing or ambiguous declarations cannot create command authority: %s',value=>{
 expect(()=>resolveNativeCommandDescriptor([{name:'exec_command',description:value}])).toThrow();
});
test.each(['cmd: number;','cmd: string; justification: string;','cmd: string; yield_time_ms?: string;','cmd: string; cmd: string;','cmd: string; options?: {mode: string};'])('unsupported or ambiguous input schema fails closed: %s',body=>{
 expect(()=>resolveNativeCommandDescriptor([{name:'exec_command',description:description('exec_command',body)}])).toThrow();
});
test('comments cannot introduce fake supported fields or change command type',()=>{
 const desc=description('exec_command','// cmd: number;\ncmd: string;\n/* yield_time_ms?: number; */\nworkdir?: string;');
 expect(resolveNativeCommandDescriptor([{name:'exec_command',description:desc}]).parameters.properties).toEqual({cmd:{type:'string'},workdir:{type:'string'}});
});
test('an unsupported second declaration cannot hide behind a valid declaration',()=>{
 const desc=description('exec_command','cmd: string;')+'\n'+description('exec_command','cmd: string; required: {mode: string};');
 expect(()=>resolveNativeCommandDescriptor([{name:'exec_command',description:desc}])).toThrow('ambiguous');
});
test('non-command tools and non-string or oversized descriptors cannot authorize a schema',()=>{
 expect(()=>resolveNativeCommandDescriptor([{name:'mcp__exec_command',description:exec().description}])).toThrow();
 expect(()=>resolveNativeCommandDescriptor([{name:'exec_command',description:null} as never])).toThrow();
 expect(()=>resolveNativeCommandDescriptor([{name:'exec_command',description:'x'.repeat(100001)}])).toThrow();
});
test.each(['changed','missing','duplicate'] as const)('each native invocation checks current descriptor before a command: %s',change=>{
 const descriptor=exec(),tool=resolveNativeCommandDescriptor([descriptor]);
 const registry=change==='missing'?[]:change==='duplicate'?[descriptor,descriptor]:[{...descriptor,description:descriptor.description+' rotated'}];
 let calls=0;
 const run=new Function('ALL_TOOLS','tools',nativeCommandDescriptorGuard(tool)+'\ntools.exec_command({cmd:"Get-Content -LiteralPath fixture.txt"});');
 expect(()=>run(registry,{exec_command:()=>{calls++;}})).toThrow();expect(calls).toBe(0);
});
