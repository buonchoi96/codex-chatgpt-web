import { expect, test } from 'bun:test';
import { WEB_CONTEXT_TARGET_TOKENS, WEB_CONTEXT_COMPACT_TARGET_TOKENS, WEB_CONTEXT_CATALOG_POLICY, classifyWebContextUsage } from '../src/web-context-policy';
import { availableChatGptWebModelRoutes, chatGptWebRouteEfforts, resolveChatGptWebContextLimits, resolveChatGptWebMessageTokenBudget } from '../src/chatgpt-web-models';
import { defaultConfig } from '../src/config';
import { augmentNativeModelCatalog } from '../src/model-catalog';
import { assertChatGptWebMultipartInputWithinLimits } from '../src/adapters/chatgpt-web/browser-worker';

test('unified context exact boundaries distinguish 90% clamp from requested onset', () => {
  expect(WEB_CONTEXT_TARGET_TOKENS).toBe(272000);
  expect(WEB_CONTEXT_COMPACT_TARGET_TOKENS).toBe(258400);
  expect(Math.floor(WEB_CONTEXT_CATALOG_POLICY.contextWindow * WEB_CONTEXT_CATALOG_POLICY.effectiveContextWindowPercent / 100)).toBe(272000);
  expect(Math.floor(WEB_CONTEXT_CATALOG_POLICY.contextWindow * .9)).toBeGreaterThanOrEqual(258400);
  for (const tokens of [244799,244800,258399,258400,258401,271999,272000]) {
    expect(classifyWebContextUsage(tokens)).toEqual({ compact: tokens >= 258400, atCapacity: tokens >= 272000 });
  }
});

test('every eligible routed profile keeps one catalog policy regardless of Bigger Context', () => {
  for (const proAvailable of [false,true]) for (const experimentalBiggerContext of [false,true]) {
    const config = { ...defaultConfig('browser-only'), proAvailable, experimentalBiggerContext };
    for (const route of availableChatGptWebModelRoutes(config, true)) {
      for (const effort of chatGptWebRouteEfforts(route, config)) {
        const selected = route.supportedCodexEfforts ? effort : route.adapterEffort;
        if (selected === 'ultra') continue;
        expect(resolveChatGptWebContextLimits(route.backendModel, selected, config, route.interactionMode === 'automatic' ? route.modelFamily : undefined))
          .toEqual({ contextWindow: 272000, effectiveContextWindowPercent: 100, autoCompactTokenLimit: 258400 });
      }
    }
  }
});

test('catalog policy never changes native rows or the measured ordinary browser budget', () => {
  const config = defaultConfig('browser-only');
  config.subagentProtocol = 'native';
  const native = { slug: 'native-fixture', visibility: 'list', supported_reasoning_levels: [{effort:'high'}], context_window: 400000, auto_compact_token_limit: 360000 };
  expect((augmentNativeModelCatalog({models:[native]}, config).models as unknown[])[0]).toEqual(native);
  expect(resolveChatGptWebMessageTokenBudget('gpt-5.6-sol', 'low', config)).toBe(32807);
  expect(resolveChatGptWebMessageTokenBudget('gpt-5.6-sol', 'high', config)).toBe(81807);
});

test('Bigger Context transport cannot exceed the unified effective window',()=>{
  const capabilities={solAvailable:true,localToolsEnabled:false,proAvailable:true,extraHighAvailable:true};
  expect(()=>assertChatGptWebMultipartInputWithinLimits(271999,40000,'gpt-5.6-sol','high',capabilities,200000,6,undefined,'5.6')).not.toThrow();
  expect(()=>assertChatGptWebMultipartInputWithinLimits(272000,40000,'gpt-5.6-sol','high',capabilities,200000,6,undefined,'5.6')).toThrow('272,000');
});
