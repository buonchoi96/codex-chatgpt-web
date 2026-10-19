import {test,expect} from 'bun:test';
import {defaultConfig} from '../src/config';
import {tunnelWorkerRuntimeChanged} from '../src/setup';

const observer={readerPipe:'\\\\.\\pipe\\fixture_a_observer_v1',grantWireName:'mcp__swift_fixture__swift_observer_reader_grant'};
test('active observer enable, endpoint/grant changes and disable require a tunnel runtime refresh',()=>{
  const disabled=defaultConfig('full');
  const enabled={...disabled,nativeScreenObserver:{...observer}};
  expect(tunnelWorkerRuntimeChanged(disabled,enabled)).toBe(true);
  expect(tunnelWorkerRuntimeChanged(enabled,{...enabled,nativeScreenObserver:{...observer,readerPipe:'\\\\.\\pipe\\fixture_b_observer_v1'}})).toBe(true);
  expect(tunnelWorkerRuntimeChanged(enabled,{...enabled,nativeScreenObserver:{...observer,grantWireName:'mcp__other_fixture__swift_observer_reader_grant'}})).toBe(true);
  expect(tunnelWorkerRuntimeChanged(enabled,disabled)).toBe(true);
});

test('inactive observer changes do not refresh safe/browser-only runtimes or depend on key order',()=>{
  for(const mode of ['browser-only','full'] as const){
    const before=defaultConfig(mode);if(mode==='full')before.browserInteractionMode='manual';
    expect(tunnelWorkerRuntimeChanged(before,{...before,nativeScreenObserver:{...observer}})).toBe(false);
  }
  const before={...defaultConfig('full'),nativeScreenObserver:{...observer}};
  expect(tunnelWorkerRuntimeChanged(before,{...before,nativeScreenObserver:{grantWireName:observer.grantWireName,readerPipe:observer.readerPipe}})).toBe(false);
});
