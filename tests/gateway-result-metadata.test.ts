import {expect,test} from 'bun:test';
import {restoreGatewayResultMetadata,gatewayMetadataProgram} from '../src/adapters/chatgpt-web/gateway-result-metadata';
const marker='codex-tool-result:owned-invocation:';
const frame=(value:unknown,prefix=marker)=>({type:'text',text:prefix+JSON.stringify(value)});

test('only this invocation metadata frame can restore nested result fields',()=>{
 const image={type:'image',mimeType:'image/png',data:'opaque-pixels'};
 const foreign=frame({version:1,mcp:true,isError:false},'codex-tool-result:foreign:');
 const result=restoreGatewayResultMetadata({content:[foreign,image,frame({version:1,mcp:true,isError:false,
   structuredContent:{frame_id:'fixture'},_meta:{source:'nested'}})]},marker);
 expect(result.content).toEqual([foreign,image]);expect(result.content[1]).toBe(image);
 expect(result).toMatchObject({isError:false,structuredContent:{frame_id:'fixture'},_meta:{source:'nested'}});
});
test('missing or repeated gateway metadata never invents a successful nested result',()=>{
 expect(()=>restoreGatewayResultMetadata({content:[]},marker)).toThrow(/missing/);
 const receipt=frame({version:1,mcp:true,isError:false});
 expect(()=>restoreGatewayResultMetadata({content:[receipt,receipt]},marker)).toThrow(/ambiguous/);
 expect(()=>restoreGatewayResultMetadata({content:[frame({version:1,mcp:true,isError:'false'})]},marker)).toThrow(/invalid/);
});
test('nested success cannot clear an actual outer gateway error',()=>{
 expect(restoreGatewayResultMetadata({isError:true,content:[frame({version:1,mcp:true,isError:false})]},marker).isError).toBe(true);
});
test('plain native wait results keep their structured status after the metadata control frame',()=>{
 const result={statuses:{fixture:'running'}},content:Array<{type:'text';text:string}>=[{type:'text',text:JSON.stringify(result)}];
 const emit=new Function('result','text',gatewayMetadataProgram(marker).join('\n'));
 emit(result,(text:string)=>content.push({type:'text',text}));
 expect(restoreGatewayResultMetadata({content},marker).structuredContent).toEqual(result);
});
