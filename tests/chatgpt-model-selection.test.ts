import { expect, test } from "bun:test";
import { assertChatGptModelFamily, chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true], ["6", true],
    ["GPT-5.6 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test("family confirmation verifies the exact Sol or Pro version, including the old Latest picker", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Medium, 2 of 3.", "Medium"], "6", "medium")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6.1 High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
});


test("model verification accepts Unicode announcement punctuation without weakening identity", () => {
  for (const separator of ["、", "，", "،", "؛", "：", "—", "。", ",", ";"]) {
    expect(chatGptModelFamilyMatches([`6 Pro${separator}5 件中 5 番目。`], "6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`GPT-5.6 Sol Pro${separator}translated position`], "5.6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`6.1 Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Sol Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Pro${separator}position`, "5.6 Pro"], "6", "max")).toBeFalse();
  }
  expect(chatGptModelFamilyMatches(["\u2068６ Pro\u2069、position"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Pro for better answers"], "6", "max")).toBeFalse();
});

test("Android Temporary Chat split model 6 and High labels require an exact checked radio", () => {
  // The user-provided Android screenshot has High selected on a 0..3 slider;
  // the advanced model picker renders the separate, abbreviated name "6".
  expect(chatGptModelFamilyMatches(["6", "High"], "6", "high", true)).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6", "High"], "6", "high", true)).toBe(true);
  expect(chatGptModelFamilyMatches(["High, 3 of 4.", "GPT-6"], "6", "high", true)).toBe(true);
  expect(chatGptModelFamilyMatches(["High, 3 of 4.", "6"], "6", "high", true)).toBe(true);
  expect(chatGptModelFamilyMatches(["High"], "6", "high", true)).toBe(true);
  // The same visible High label without selected-model radio proof is unsafe.
  expect(chatGptModelFamilyMatches(["6", "High"], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["GPT-6", "High"], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["High"], "6", "high")).toBe(false);
  for (const mismatch of [
    ["5.6", "High"], ["6.1", "High"], ["7", "High"],
    ["6", "Medium"], ["6", "Extra High"], ["6", "Pro"],
    ["GPT-6.1", "High"], ["GPT-5.6 Sol", "High"], ["GPT-6 Pro", "High"],
    ["6 Medium, 2 of 4.", "High"],
  ]) expect(chatGptModelFamilyMatches(mismatch, "6", "high", true)).toBe(false);
  expect(chatGptModelFamilyMatches([], "6", "high", true)).toBe(false);
  expect(chatGptModelFamilyMatches(["High"], "5.6", "high", true)).toBe(false);
});

test("Android compact GPT-6 radio plus owned High slider passes confirmation without a model-name shortcut", async () => {
  const makeMenu = (selected: string, effortLabel = "High") => ({
    menu: {
      getByRole: (_role: string, options: {name: RegExp}) => ({
        count: async () => options.name.test(selected) ? 1 : 0,
        getAttribute: async (name: string) => name === "aria-checked" ? "true" : null,
      }),
    },
    slider: {
      getAttribute: async (name: string) => ({
        "aria-valuemin": "0", "aria-valuemax": "3", "aria-valuenow": "2",
      } as Record<string, string>)[name] ?? null,
      evaluate: async () => [effortLabel],
    },
  }) as unknown as Parameters<typeof assertChatGptModelFamily>[0];

  await expect(assertChatGptModelFamily(makeMenu("6"), "6", "high", 2)).resolves.toBeUndefined();
  // Live issue #864 screenshot: a checked GPT-6 radio and a separately
  // selected High slider in the Android-UA Temporary Chat frontend.
  await expect(assertChatGptModelFamily(makeMenu("GPT-6"), "6", "high", 2)).resolves.toBeUndefined();
  await expect(assertChatGptModelFamily(makeMenu("Latest"), "6", "high", 2))
    .rejects.toThrow("could not be selected and verified");
  await expect(assertChatGptModelFamily(makeMenu("6", "Medium"), "6", "high", 2))
    .rejects.toThrow("could not be selected and verified");
  await expect(assertChatGptModelFamily(makeMenu("5.6"), "6", "high", 2))
    .rejects.toThrow("could not be selected and verified");
  for (const wrong of ["GPT-5.6 Sol", "GPT-6.1", "GPT-7", "GPT-6 Pro"]) {
    await expect(assertChatGptModelFamily(makeMenu(wrong), "6", "high", 2))
      .rejects.toThrow("could not be selected and verified");
  }
});
