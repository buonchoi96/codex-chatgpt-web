import {test,expect} from 'bun:test';
import {onlyNativeViewerTools,nativeImageReceipts} from '../scripts/smoke-dev-native-viewer';
test('viewer fixture retains one actual native viewer interface and rejects absence or duplicate declarations',()=>{
 const source=[{type:'namespace',name:'functions',tools:[{type:'function',name:'view_image',parameters:{}},{type:'function',name:'exec_command',parameters:{}}]},
  {type:'custom',name:'exec',format:{type:'text'}}];
 expect(onlyNativeViewerTools(source,'direct')).toEqual([{...source[0],tools:[source[0]!.tools![0]]}]);
 expect(onlyNativeViewerTools(source,'nested')).toEqual([source[1]!]);
 expect(()=>onlyNativeViewerTools([],'direct')).toThrow('unavailable');
 expect(()=>onlyNativeViewerTools([{type:'namespace',name:'functions',tools:[{type:'function',name:'view_image'},{type:'function',name:'view_image'}]}],'direct')).toThrow('ambiguous');
 expect(()=>onlyNativeViewerTools([{type:'namespace',name:'foreign',tools:[{type:'function',name:'view_image'}]}],'direct')).toThrow('unavailable');
});
test('native image tracing accepts only real tool-result data URLs and exports digests instead of pixels',()=>{
 const image={type:'input_image',image_url:'data:image/png;base64,AQID'};
 const receipts=nativeImageReceipts([{type:'message',role:'user',content:[image]},
  {type:'function_call_output',call_id:'inert',output:[image,{type:'input_text',text:'metadata'}]},
  {type:'custom_tool_call_output',call_id:'inert2',output:[{type:'input_image',image_url:'https://example.test/private'}]}]);
 expect(receipts).toEqual([{mime:'image/png',bytes:3,sha256:'039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'}]);
 expect(JSON.stringify(receipts)).not.toContain('AQID');
});
