# Generated-output checklist

What to check on a generated app (`out/<slug>/`) beyond the validation report: that the output still has everything the substrate has, and that nothing from the substrate's own setup leaked into it. It is spec-agnostic: it checks the substrate's features (auth, organizations, forced updates, billing, error monitoring), not the user's domain rules.

The validation report (Layers 1–3) proves the output builds, renders without substrate tokens, and gets through one scripted CRUD walk. It does not run the generated apps' test suites or linters, does not look at config files the rename leaves alone, and does not exercise multi-user or version-gate flows. Each item below exists because a real run passed the report and still failed it; the run is cited where it applies.

[`SUBSTRATE-CONTRACT.md`](./SUBSTRATE-CONTRACT.md) is the other half: rules the substrate follows so the rename produces correct output. This document checks the output after the fact.

Placeholders: `<Product>` is the Pascal project name (`OrangeBaton`), `<PRODUCT>` its upper-case token (`ORANGEBATON`), `<Display Name>` the display name (`Orange Baton`), `<service>` the API service name (`orange_baton_api`). Primary resource / nested resource / user are the renamed `Shop` / `ItemTag` / `Shopkeeper`.

Legend: **[static]** check by reading files, **[cmd]** run a command, **[device]** run the app (simulator/emulator is enough unless marked *real device*), **[paid]** paid edition only.

---

## 1. Rename

| # | Check | How |
|---|---|---|
| 1.1 | No substrate tokens left (`Shop`, `Shopkeeper`, `ItemTag`, `NativeAppTemplate`, all case forms; 店舗, アイテムタグ, 番号タグ) outside CHANGELOGs | [static] Layer 1 covers code; also `rg` the generated `Info.plist` strings, mail views and web views |
| 1.2 | No article disagreement in user-facing strings, including the product name: `an <noun>` / `a <Product>` | [static] `rg -i '\ban (<noun>)s?\b'` and `rg '\ba <Product>'` over `out/<slug>/`. *Orange Baton: Android notification channel "when an baton is completed"; iOS `NSLocalNetworkUsageDescription` "Connects to a OrangeBaton API server"* |
| 1.3 | The display name, not the Pascal name, in user-facing copy (mails, web pages, permission prompts) | [static] [device] read a confirmation mail and an invitation mail. *Orange Baton: mails said "OrangeBaton"* |
| 1.4 | Brand assets replaced: app icons, the logo on the API's web pages (password reset, confirmation result) | [device] open a password-reset link in a browser. *Orange Baton: the reset page still shows the NativeAppTemplate "N"* |
| 1.5 | Non-domain identifiers not renamed (SUBSTRATE-CONTRACT rule 5), e.g. the agent's own name in comments | [static] `rg -i '<slug>-agent'` |

## 2. Substrate setup that must not carry over

| # | Check | How |
|---|---|---|
| 2.1 | No `*.local.xcconfig` except `API.local.xcconfig`; no `.sentryclirc` / `sentry.properties`; no `.env` secrets | [static] `find out/<slug> -name '*.local.xcconfig' -o -name .sentryclirc -o -name sentry.properties` |
| 2.2 | RevenueCat key and Sentry DSN empty: iOS `RevenueCat.xcconfig` / `Sentry.xcconfig`, Android `<PRODUCT>_REVENUECAT_GOOGLE_API_KEY` / `<PRODUCT>_SENTRY_DSN`, API `SENTRY_DSN` | [static] |
| 2.3 | **Firebase config is not the substrate's.** `android/app/google-services.json` from the substrate is copied with only `project_id` renamed, so FCM cannot get a token and the substrate developer's API key ships with the app | [static] compare `project_number` and `api_key` with the substrate's file. [device] logcat shows `FirebaseMessaging: Failed to get FIS auth token`. *Orange Baton* |
| 2.4 | **Store URLs are not the substrate's.** iOS `Constants.appStoreUrl` (forced-update button), API `config/settings.yml` `app_store_url` / `play_store_url` (invitation mail) | [static] `rg -n 'apps.apple.com\|play.google.com' out/<slug>`. *Orange Baton: the iOS update button opened MyTurnTag Creator's App Store page* |
| 2.5 | Production credentials: `config/credentials/production.yml.enc` is the substrate's and its key is not copied; regenerate before deploying | [static] |
| 2.6 | The env bridge mirrored `<PRODUCT>_API_*` into `~/.gradle/gradle.properties`. The managed block holds only the most recent run's product, so an earlier output's Debug build silently falls back to the production host | [static] `grep <PRODUCT>_API ~/.gradle/gradle.properties`; [cmd] check `DOMAIN` in the generated `BuildConfig.java`. *Orange Baton, after a later clinic-queue run* |

## 3. Tests and linters

The agent builds the apps but does not run their test suites or linters. A rename changes identifier lengths and alphabetical order, and can make two distinct substrate words the same word, so run all of them.

| # | Check | How |
|---|---|---|
| 3.1 | API tests and RuboCop | [cmd] `cd rails && bin/rails test && bin/rubocop`. *Orange Baton: `Layout/HashAlignment` after `shopkeeper_auth` → `teammate_auth`* |
| 3.2 | iOS tests, SwiftLint, SwiftFormat | [cmd] `cd ios && xcodebuild test -scheme <Product> -destination '<simulator>' && make lint`. *Orange Baton: `JSONAPIDocumentTest/unknownTypeHasNoEntityType` — the substrate's "unknown type" `itemTag` became `baton`, a real type* |
| 3.3 | Android unit tests, Spotless, Android Lint | [cmd] `cd android && ./gradlew --no-daemon testDebugUnitTest`, then `spotlessCheck`, then `lintDebug` (one at a time; run together the Gradle daemon died on a 64 GB Mac). *Orange Baton: import order in 4 files after `ShopkeeperLocaleUpdate` → `TeammateLocaleUpdate`* |

## 4. Auth and account

Run the API with `bin/dev` (it loads `.env`, including `SOLID_QUEUE_IN_PUMA`); with `bin/rails server` alone mail jobs are never processed. Mails land in `rails/tmp/mailbin/`.

| # | Check | API | iOS | Android |
|---|---|---|---|---|
| 4.1 | Sign up → confirmation mail (in the device language) → link confirms | [device] | [device] | [device] |
| 4.2 | Wrong password shows `[<PRODUCT>-2001] …` without a status suffix | — | [device] | [device] |
| 4.3 | A failed attempt's error is gone after a successful one | — | [device] | [device] |
| 4.4 | Forgot password → mail → reset page → sign in with the new password | [device] | [device] | [device] |
| 4.5 | Change password; edit profile; sign out → sign in keeps data | — | [device] | [device] |
| 4.6 | Reinstall does not keep the session (iOS Keychain cleanup) | — | [device] | [device] |
| 4.7 | Hidden validation messages are not read by VoiceOver / TalkBack: fill a field, swipe right from it, and the hidden error is skipped. Use the screen reader, not a UI-tree dump — mobilecli (WDA) lists elements hidden with `.accessibilityHidden` too | — | *real device, VoiceOver* | *real device, TalkBack* |

## 5. Primary and nested resources

| # | Check | iOS | Android |
|---|---|---|---|
| 5.1 | Sign-up creates the sample primary resource with its sample nested resource | [device] | [device] |
| 5.2 | Create / edit / delete the primary resource | [device] | [device] |
| 5.3 | Create / edit / delete the nested resource; the detail screen shows the edit after going back | [device] | [device] |
| 5.4 | State toggle from the list (swipe) and from the detail screen, both directions | [device] | [device] |
| 5.5 | After a toggle the app makes a handful of requests, not a reload loop (watch the Rails log for ~10 s) | [device] | [device] |

## 6. Organizations [paid]

Two accounts, one per device. With billing off, anyone can create organizations and invite.

| # | Check |
|---|---|
| 6.1 | Create an organization; it becomes current; projects list follows the current organization. ("You are in personal organization." showing on every launch while in the personal organization is by design) |
| 6.2 | Invite (name, email, role) → invitation mail with a code → the other device joins with the code and switches to it |
| 6.3 | A `member` sees no Edit / Invite on the organization; changing them to `admin` shows Edit after an app restart |
| 6.4 | Removing the member: their app switches to the personal organization and says so |
| 6.5 | Deleting the organization (owner, from another current organization): the member's app says "This organization no longer exists…", not a 404 error; the notice sits above the tab bar and the tabs stay tappable |
| 6.6 | Invitation edit, resend, cancel |

## 7. Forced updates

Add rows in `rails runner` (or `/madmin`), relaunch both apps, then restore.

| # | Check |
|---|---|
| 7.1 | `PrivacyVersion` with a higher `version`, `current_type: :current` → both apps ask to accept; `confirmed_privacy_version` updates |
| 7.2 | Same with `TermsVersion` |
| 7.3 | `AppVersion` per platform with a `version` above the build number, `forced_update` → both apps block with "Update the app"; the button opens **this** app's store page (see 2.4) |

## 8. Admin

| # | Check |
|---|---|
| 8.1 | `/madmin` signs in with an `AdminUser` (`name`, `email`, `password`); resources and `/madmin/jobs` open |
| 8.2 | Setting a user's Feature access state to `all_feature_access` shows up as `feature_access_state` / `account_owner_feature_access_state` in the sign-in response [paid] |

## 9. Push, billing, error monitoring [paid]

| # | Check |
|---|---|
| 9.1 | After sign-in each app registers a device (`POST …/devices`) and unregisters on sign-out. Android needs a real `google-services.json` (2.3) |
| 9.2 | With billing off: no paywall anywhere, no Subscription section in Settings |
| 9.3 | With your own RevenueCat key: paywall on the second primary resource, on creating an organization and on inviting; the paywall copy names the renamed primary resource |
| 9.4 | With Sentry DSN empty the SDKs stay uninitialized; with your own DSN only the user ID is sent |

## 10. Localization

| # | Check | How |
|---|---|---|
| 10.1 | Every key has a Japanese translation: iOS `Localizable.xcstrings` / `InfoPlist.xcstrings`, Android `values` vs `values-ja`, API `en.yml` vs `ja.yml` | [static] a short script comparing keys |
| 10.2 | With the device in Japanese, screens, mails and errors are Japanese | [device] |

---

## Running it on real devices

- iOS real device: `mobile-mcp` may not list it; `mobilecli` (bundled with mobile-mcp) can (`mobilecli devices`, `dump ui`, `io tap`, `io text`, `screenshot`). Wait ~1.5 s after a tap before typing, or the text goes to the previously focused field. Secure fields clear when refocused, and backspace does not delete in them; screenshots hide secure-field contents and the keyboard.
- Android: `adb shell input` and `uiautomator dump` are faster than tapping through `mobile-mcp`. Chrome's password suggestion sheet swallows typed text on web forms.
- Point both apps at the Mac's LAN IP (`API.local.xcconfig`, `<PRODUCT>_API_*` in `~/.gradle/gradle.properties`); allow Local Network on iOS before the first request.

A full pass over sections 3–8 on two real devices took about an hour for Orange Baton (2026-10-18).
