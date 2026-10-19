import {expect, test} from 'bun:test';
import {NativePixelAnswerError, parseNativePixelAnswer} from '../scripts/native-pixel-answer';

const answer={top_left:'red',top_right:'green',bottom_left:'blue',bottom_right:'yellow',center_shape:'circle'} as const;
const json=JSON.stringify(answer);

test('parses exact five-field JSON with reordered and Unicode-escaped keys and values',()=>{
  const input='{"center_shape":"s\\u0071uare","bottom_right":"cyan","top_right":"green","bottom_left":"blue","top\\u005fleft":"red"}';
  expect(parseNativePixelAnswer(input)).toEqual({kind:'answer',answer:{
    top_left:'red',top_right:'green',bottom_left:'blue',bottom_right:'cyan',center_shape:'square',
  }});
});

test('accepts one whole plain or JSON-fenced object',()=>{
  expect(parseNativePixelAnswer(json)).toEqual({kind:'answer',answer});
  expect(parseNativePixelAnswer(`\`\`\`json\n${json}\n\`\`\``)).toEqual({kind:'answer',answer});
  expect(parseNativePixelAnswer(`\`\`\`\n${json}\n\`\`\``)).toEqual({kind:'answer',answer});
});

test('recognizes only the exact unavailable marker, escaped underscores, or one Markdown wrapper',()=>{
  for(const input of [
    'IMAGE_RELAY_UNAVAILABLE',
    String.raw`IMAGE\_RELAY\_UNAVAILABLE`,
    String.raw`**IMAGE\_RELAY\_UNAVAILABLE**`,
    '*IMAGE_RELAY_UNAVAILABLE*',
    '`IMAGE_RELAY_UNAVAILABLE`',
  ])expect(parseNativePixelAnswer(input)).toEqual({kind:'unavailable'});
});

test('rejects duplicate keys including Unicode-escaped aliases',()=>{
  for(const input of [
    '{"top_left":"red","top_left":"blue","top_right":"green","bottom_left":"blue","bottom_right":"yellow","center_shape":"circle"}',
    '{"top_left":"red","top\\u005fleft":"blue","top_right":"green","bottom_left":"blue","bottom_right":"yellow","center_shape":"circle"}',
  ])expect(()=>parseNativePixelAnswer(input)).toThrow(NativePixelAnswerError);
});

test('rejects extra, missing, nested, malformed, wrong-valued, or mixed answers with a typed error',()=>{
  const invalid=[
    '',
    'Answer: '+json,
    json+' IMAGE_RELAY_UNAVAILABLE',
    json.replace(',"center_shape":"circle"',''),
    json.replace('}',',"extra":"red"}'),
    json.replace('"top_left":"red"','"top_left":{"color":"red"}'),
    '['+json+']',
    json.replace('"center_shape":"circle"','"center_shape":1'),
    json.replace('"top_left":"red"','"top_left":"orange"'),
    json.replace('"center_shape":"circle"','"center_shape":"triangle"'),
    '```json\n'+json+'\n``` trailing text',
    'prefix ```json\n'+json+'\n```',
    '**'+json+'**',
    'IMAGE_RELAY_UNAVAILABLE '+json,
    'IMAGE_RELAY_UNAVAILABLE\n'+json,
  ];
  for(const input of invalid)expect(()=>parseNativePixelAnswer(input)).toThrow(NativePixelAnswerError);
});

test('accepts exactly 4096 UTF-8 bytes and rejects Unicode overflow before parsing',()=>{
  const padded=json+' '.repeat(4096-new TextEncoder().encode(json).length);
  expect(new TextEncoder().encode(padded).length).toBe(4096);
  expect(parseNativePixelAnswer(padded)).toEqual({kind:'answer',answer});

  const multibyte='é'.repeat(2049);
  expect(multibyte.length).toBeLessThan(4096);
  expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(4096);
  try {parseNativePixelAnswer(multibyte);throw new Error('expected size rejection');}
  catch(error) {
    expect(error).toBeInstanceOf(NativePixelAnswerError);
    expect((error as NativePixelAnswerError).code).toBe('NATIVE_PIXEL_ANSWER_TOO_LARGE');
  }
});

test('rejects every color outside the exact six-color vocabulary',()=>{
  for(const color of ['orange','purple','Red',' red','blue ']) {
    const input=json.replace('"top_left":"red"',`"top_left":${JSON.stringify(color)}`);
    expect(()=>parseNativePixelAnswer(input)).toThrow(NativePixelAnswerError);
  }
});

test('accepts all six exact color names in every pixel field',()=>{
  for(const color of ['red','green','blue','yellow','magenta','cyan'] as const) {
    const input=json.replace('"top_left":"red"',`"top_left":${JSON.stringify(color)}`);
    expect(parseNativePixelAnswer(input)).toEqual({kind:'answer',answer:{...answer,top_left:color}});
  }
});
