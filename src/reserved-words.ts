import type { RenamePair } from "./agents/types.js";

// Rename targets that collide with identifiers the substrate already uses.
// A lexical rename into one of these produces duplicate or shadowed types
// (build errors), so the planner is told to avoid them and manual overrides
// into them are rejected (src/rename-overrides.ts).

// The substrate's auth/admin layer.
export const SUBSTRATE_RESERVED: readonly string[] = [
  "Owner", "Account", "Admin", "Personal", "Role", "Permission", "User", "App", "Version",
  "Privacy", "Terms", "Invitation", "Error", "Scan", "Redirect", "Notification", "Session",
];

// The paid templates' RevenueCat billing layer. The first group are the
// templates' own billing type stems (SubscriptionRepository, PaywallView,
// SubscriptionPlan, FreeTrial…; iOS docs/subscription.md "Keeping it safe for
// nativeapptemplate-agent's rename"); the second are RevenueCat / StoreKit /
// Play Billing type names the billing code refers to.
export const BILLING_RESERVED: readonly string[] = [
  "Subscription", "Paywall", "Plan", "Purchase", "Purchases", "Billing", "Entitlement", "Trial", "Customer",
  "Package", "Offering", "Store", "StoreProduct", "Product", "Transaction", "Price", "Period",
];

export const STDLIB_RESERVED: Readonly<Record<string, readonly string[]>> = {
  Swift: [
    "Task", "Actor", "Result", "Error", "View", "Text", "Image", "State", "Binding",
    "Data", "Date", "URL", "UUID", "Set", "Array", "Dictionary", "Optional",
  ],
  Kotlin: [
    "Unit", "Nothing", "Any", "List", "Map", "Set", "Flow", "Sequence", "Result",
    "Continuation", "Deferred", "Context",
  ],
  "Ruby/Rails": [
    "Object", "Module", "Class", "Array", "Hash", "String", "Integer", "Proc",
    "Thread", "Request", "Response", "Session",
  ],
};

// Why `target` can't be a rename target, or null when it can. Case-insensitive:
// rename.rb derives every case form from the target, so `store` and `Store`
// produce the same identifiers.
export function reservedReason(target: string): string | null {
  const t = target.trim().toLowerCase();
  const hit = (words: readonly string[]): string | undefined => words.find((w) => w.toLowerCase() === t);
  const substrate = hit(SUBSTRATE_RESERVED);
  if (substrate) return `"${substrate}" is used by the substrate's auth/admin layer`;
  const billing = hit(BILLING_RESERVED);
  if (billing) return `"${billing}" is used by the substrate's subscription (RevenueCat) layer`;
  for (const [lang, words] of Object.entries(STDLIB_RESERVED)) {
    const w = hit(words);
    if (w) return `"${w}" is a ${lang} standard-library type`;
  }
  return null;
}

export type ReservedTarget = { from: string; to: string; reason: string };

export function reservedTargets(plan: readonly RenamePair[]): ReservedTarget[] {
  return plan.flatMap((p) => {
    const reason = reservedReason(p.to);
    return reason ? [{ from: p.from, to: p.to, reason }] : [];
  });
}
