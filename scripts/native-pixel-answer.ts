export type NativePixelAnswerErrorCode='NATIVE_PIXEL_ANSWER_INVALID'|'NATIVE_PIXEL_ANSWER_TOO_LARGE';
export class NativePixelAnswerError extends Error {
  constructor(readonly code:NativePixelAnswerErrorCode) {super(code);this.name='NativePixelAnswerError';}
}

export type NativePixelColor='red'|'green'|'blue'|'yellow'|'magenta'|'cyan';
export interface NativePixelAnswer {
  top_left:NativePixelColor;
  top_right:NativePixelColor;
  bottom_left:NativePixelColor;
  bottom_right:NativePixelColor;
  center_shape:'circle'|'square';
}
export type NativePixelAnswerResult={kind:'unavailable'}|{kind:'answer';answer:NativePixelAnswer};

const MAX_UTF8_BYTES=4096;
const COLORS=new Set<NativePixelColor>(['red','green','blue','yellow','magenta','cyan']);
const ANSWER_KEYS=['top_left','top_right','bottom_left','bottom_right','center_shape'] as const;
const UNAVAILABLE='IMAGE_RELAY_UNAVAILABLE';
const MARKDOWN_WRAPPERS:readonly (readonly [string,string])[]=[['**','**'],['__','__'],['*','*'],['_','_'],['`','`']];

function invalid():never {throw new NativePixelAnswerError('NATIVE_PIXEL_ANSWER_INVALID')}
function tooLarge():never {throw new NativePixelAnswerError('NATIVE_PIXEL_ANSWER_TOO_LARGE')}

function isUnavailable(text:string):boolean {
  let candidate=text.trim();
  for(const [opening,closing] of MARKDOWN_WRAPPERS) {
    if(candidate.startsWith(opening)&&candidate.endsWith(closing)&&candidate.length>=opening.length+closing.length) {
      candidate=candidate.slice(opening.length,candidate.length-closing.length).trim();
      break;
    }
  }
  return candidate===UNAVAILABLE||candidate===String.raw`IMAGE\_RELAY\_UNAVAILABLE`;
}

function jsonBody(text:string):string {
  const candidate=text.trim();
  if(!candidate.startsWith('```')&&!candidate.endsWith('```'))return candidate;
  const match=/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(candidate);
  if(!match)invalid();
  return match[1]!;
}

interface Cursor {text:string;index:number}
function whitespace(cursor:Cursor):void {
  while(cursor.index<cursor.text.length) {
    const char=cursor.text[cursor.index];
    if(char===' '||char==='\t'||char==='\r'||char==='\n')cursor.index++;
    else break;
  }
}

function jsonString(cursor:Cursor):string {
  const start=cursor.index;
  if(cursor.text[cursor.index]!=='"')invalid();
  cursor.index++;
  while(cursor.index<cursor.text.length) {
    const code=cursor.text.charCodeAt(cursor.index),char=cursor.text[cursor.index]!;
    if(char==='"') {
      cursor.index++;
      try {
        const parsed:unknown=JSON.parse(cursor.text.slice(start,cursor.index));
        if(typeof parsed!=='string')invalid();
        return parsed;
      } catch {invalid();}
    }
    if(char==='\\') {
      cursor.index++;
      const escape=cursor.text[cursor.index];
      if(escape==='u') {
        const digits=cursor.text.slice(cursor.index+1,cursor.index+5);
        if(!/^[0-9a-fA-F]{4}$/.test(digits))invalid();
        cursor.index+=5;
      } else if(escape!==undefined&&'"\\/bfnrt'.includes(escape))cursor.index++;
      else invalid();
    } else {
      if(code<0x20)invalid();
      cursor.index++;
    }
  }
  return invalid();
}

function flatJsonObject(text:string):Map<string,string> {
  const cursor:Cursor={text,index:0},fields=new Map<string,string>();
  whitespace(cursor);
  if(cursor.text[cursor.index++]!=='{')invalid();
  whitespace(cursor);
  if(cursor.text[cursor.index]==='}')cursor.index++;
  else for(;;) {
    whitespace(cursor);
    const key=jsonString(cursor);
    if(fields.has(key))invalid();
    whitespace(cursor);
    if(cursor.text[cursor.index++]!==':')invalid();
    whitespace(cursor);
    const value=jsonString(cursor);
    fields.set(key,value);
    whitespace(cursor);
    const delimiter=cursor.text[cursor.index++];
    if(delimiter==='}')break;
    if(delimiter!==',')invalid();
  }
  whitespace(cursor);
  if(cursor.index!==cursor.text.length)invalid();
  return fields;
}

export function parseNativePixelAnswer(text:string):NativePixelAnswerResult {
  if(typeof text!=='string')invalid();
  if(new TextEncoder().encode(text).byteLength>MAX_UTF8_BYTES)tooLarge();
  if(isUnavailable(text))return {kind:'unavailable'};

  const fields=flatJsonObject(jsonBody(text));
  if(fields.size!==ANSWER_KEYS.length||ANSWER_KEYS.some(key=>!fields.has(key)))invalid();
  const topLeft=fields.get('top_left')!,topRight=fields.get('top_right')!,bottomLeft=fields.get('bottom_left')!,
    bottomRight=fields.get('bottom_right')!,centerShape=fields.get('center_shape')!;
  if(!COLORS.has(topLeft as NativePixelColor)||!COLORS.has(topRight as NativePixelColor)||
    !COLORS.has(bottomLeft as NativePixelColor)||!COLORS.has(bottomRight as NativePixelColor)||
    (centerShape!=='circle'&&centerShape!=='square'))invalid();
  return {kind:'answer',answer:{top_left:topLeft as NativePixelColor,top_right:topRight as NativePixelColor,
    bottom_left:bottomLeft as NativePixelColor,bottom_right:bottomRight as NativePixelColor,center_shape:centerShape}};
}
