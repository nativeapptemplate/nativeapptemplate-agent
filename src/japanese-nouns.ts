import type { RenamePair } from "./agents/types.js";

// The substrate's Japanese for each renameable token, as config/locales/ja.yml
// spells it. rename.rb's English patterns can't reach these, so a planned
// toJa is applied to them as plain substrings (Japanese nouns don't inflect:
// 店舗名 → 医院名). Shopkeeper is ユーザー there, which fits any domain.
export const SUBSTRATE_JAPANESE_NOUNS: Readonly<Record<string, string>> = {
  Shop: "店舗",
  ItemTag: "アイテムタグ",
};

export function japaneseRenamePairs(plan: readonly RenamePair[]): RenamePair[] {
  return plan.flatMap((p) => {
    const from = SUBSTRATE_JAPANESE_NOUNS[p.from];
    return from && p.toJa && p.toJa !== from ? [{ from, to: p.toJa }] : [];
  });
}

export function renamedTokens(plan: readonly RenamePair[]): string[] {
  return [...plan.map((p) => p.from), ...japaneseRenamePairs(plan).map((p) => p.from)];
}
