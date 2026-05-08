# Substrate rename-safety contract

Conventions that the substrate repos (`nativeapptemplateapi`, `NativeAppTemplate-Free-iOS`, `NativeAppTemplate-Free-Android`) must follow so that the [`nativeapptemplate-agent`](https://github.com/nativeapptemplate/nativeapptemplate-agent) rename pipeline produces grammatically and structurally correct output, regardless of which target words a user picks for `Shop`, `Shopkeeper`, and `ItemTag`.

These rules are derived from how `scripts/ruby/rename.rb` actually works (read it for the full case-form coverage) and from real bugs we've hit. Substrate maintainers should read this before merging anything that touches user-facing strings or domain identifiers.

---

## Why this exists

The agent customizes the substrate by mechanically substituting domain tokens — `Shop` → `Clinic`, `Shopkeeper` → `Vet`, `ItemTag` → `Patient`, etc. — across all case forms (PascalCase, snake_case, camelCase, flat lowercase, UPPER_SNAKE, humanized lower / title / sentence × singular / plural). The substitution is text-only; it does not understand English grammar. So if the substrate writes:

```
"Swipe an item tag to change its status."
```

…and a user picks `ItemTag → Patient`, the agent will produce:

```
"Swipe an patient to change its status."
```

The article disagrees with the new noun's first letter. That kind of leak makes the generated app look broken, which kills the agent's "spec to coherent app" pitch. The fix isn't to make the rename pipeline article-aware (that gets edge-case-fragile fast — `an HTTP`, `an SQL`, `an honest`) — the fix is to write substrate strings that survive any rename target. That's what this contract specifies.

---

## Rules

### 1. UI strings: drop articles, or use self-contained phrasings

**Bad** — article-coupled to a renameable noun:

```swift
// breaks for any consonant-starting target word
let instruction = "Swipe an item tag to change its status."
```

**Good** — article-free:

```swift
let instruction = "Swipe to change status."
```

**Also good** — preserve some context without the article:

```swift
let instruction = "Swipe to change item tag status."
```

The same rule applies to Android `strings.xml` and Rails `config/locales/*.yml`. If you must use an article, use it in front of a non-renameable word — never in front of `Shop`, `Shopkeeper`, `ItemTag`, or any humanized form of those.

### 2. Casing: stick to standard conventions

The rename pipeline knows these case forms for each domain word:

| Form | `ItemTag` example | When it appears |
|---|---|---|
| PascalCase | `ItemTag` | class names, type names |
| snake_case | `item_tag` | filenames, table names, locale keys |
| camelCase | `itemTag` | method names, Swift/Kotlin field names |
| flat lowercase | `itemtag` | URL slugs, package fragments, email addresses |
| UPPER_SNAKE | `ITEM_TAG` | constants |
| humanized lower | `item tag` | UI prose |
| humanized title | `Item Tag` | headings, button labels |
| humanized sentence | `Item tag` | sentence starts, error messages |

Each humanized form has a plural variant (`item tags` / `Item Tags` / `Item tags`).

**Don't write the domain word in non-canonical casing**: `ITEMtag`, `Item_Tag`, `itemtag` mid-sentence in prose, etc. The renamer won't recognize these as instances and will leave them as substrate-original tokens — Layer 1 (ripgrep) will fail.

### 3. Plurals: stick to regular English forms when picking domain words

The renamer's pluralizer handles regular cases:
- `y` after a consonant → `ies` (`patient` → `patients` is regular; `puppy` → `puppies`)
- `s`, `sh`, `ch`, `x`, `z` → add `es` (`box` → `boxes`)
- everything else → add `s` (`shop` → `shops`)

**Irregular plurals will produce wrong forms.** If a user picks `ItemTag → Mouse`, the renamer will write `Mouses` everywhere a substrate string used `ItemTags`. The substrate can't prevent users from picking irregular-plural targets — but **substrate strings should not depend on the plural's correctness**. Prefer:

```
// safe — user can pick any rename target, plural form doesn't matter for meaning
"5 item tags pending"        →   "5 patients pending"   ✓ regular
                             →   "5 mouses pending"     ✗ irregular but agent's responsibility, not substrate's
```

When in doubt, write strings that work for both forms (e.g. count + word, where the wrong plural is awkward but parseable), not strings where grammatical correctness is load-bearing.

### 4. Test descriptors: drop articles in test names

Same rule as UI strings, applied to test names:

```ruby
# Bad — "an" disagrees if ItemTag is renamed to a consonant-starting word
test "show returns an item tag detail" do

# Good
test "show returns item tag detail" do
```

Test descriptors are rendered in CI output and IDE test runners. Substrate-original "an item tag" survives rename and shows in test logs as "an patient" — same leak as UI strings, just narrower audience.

### 5. Don't use domain words for non-domain meanings

If `Shop` is a domain entity, don't have a variable named `shop_count` that means "number of items in shopping cart" or some unrelated counter. The renamer can't tell the difference and will rename both, producing `clinic_count` for what is actually a generic counter — confusing for the user reading the generated code.

Keep domain words *only* in domain contexts. Use generic names (`count`, `total`, `entries`) for non-domain counters and collections.

### 6. Comments and docstrings: same rules

Comments are scanned by the rename pipeline and treated like any other text. If a comment says "an item tag," it'll become "an patient" the same way a UI string does. Apply rule 1 to comments too:

```ruby
# Bad
# Try to create an item tag with a blank name to trigger validation error

# Good
# Try to create item tag with a blank name to trigger validation error
```

### 7. Avoid English-language assumptions in templates

Don't write template strings that depend on English grammar agreement:

```
"You have #{count} #{count == 1 ? "shop" : "shops"} in your account"
```

This is correct English for `Shop`, but doesn't work cleanly if the user picks an irregular plural. **Instead, use phrasings that work uniformly** (`"Shops in account: #{count}"`) or accept that string templates with grammatical-agreement logic are substrate-internal and won't be customized cleanly. Document the latter explicitly so future maintainers know.

---

## Verifying a substrate change is rename-safe

Before merging a substrate PR that touches user-facing strings or test descriptors, run the agent locally against a clinic-queue spec (or any spec with a consonant-starting target for `ItemTag`) and grep the output for substrate-original tokens or grammatical artifacts:

```bash
cd $NATIVEAPPTEMPLATE_AGENT  # the agent repo
NATIVEAPPTEMPLATE_VISUAL=1 npm run dev -- "a walk-in clinic queue for small veterinary practices"

# Layer 1 already runs ripgrep for substrate-original tokens — that's
# the catch-all. But also spot-check for article disagreement in the
# specific strings you changed:
rg "an patient|an Patient|an clinic|an Clinic" out/vet-clinic-queue/

# Visual confirmation (Layer 3 with VISUAL=1) — open the captured
# screenshots in tmp/screenshots/ and read the rendered UI text:
open tmp/screenshots/ios-home.png tmp/screenshots/android-home.png
```

If Layer 1 passes and the rendered UI text reads naturally for a consonant-starting target, the change is rename-safe.

---

## When to update this contract

Add a new rule whenever a real rename leak surfaces that wasn't covered. The article-disagreement rule (rule 1) was added after the v0.1.2 launch surfaced "Swipe an patient" in the YouTube thumbnail. Each rule should cite a concrete bug it prevents — abstract advice without a real failure to point at gets ignored by future contributors.

This document is the canonical source. Substrate repos may link here from their `CONTRIBUTING.md` or `README` rather than maintaining their own copies.
