---
name: walk-app
description: >-
  Launch a generated app on a booted iOS Simulator or Android emulator and walk
  its UI with mobile-mcp — capture the home screen, show screenshots inline, list
  on-screen elements, and optionally drive a guided tap-through. Use when the
  user wants to see, preview, screenshot, or interact with the running generated
  app, or asks to "walk the home screen" / "show me the UI" after a generation.
---

# Walk a generated app's UI with mobile-mcp

This is the interactive companion to `generate-app`. Where `generate-app` produces
and validates the projects, this skill puts a generated app **on screen** and lets
you explore it conversationally — capture the current screen, list its elements,
and tap through a flow, surfacing screenshots inline as you go.

It depends on `mobile-mcp` (bundled with this plugin — check `/mcp`) and on a real
booted device + an installed build. Those parts are environment-dependent and the
flakiest link in the chain; be explicit with the user about what's required rather
than failing silently.

## 1. Resolve the target

- **Project:** a slug from `$ARGUMENTS`, else the most recently modified directory
  under `./out/`. Confirm the chosen `out/<slug>/` exists.
- **Platform:** `ios` or `android` from `$ARGUMENTS`. If unspecified, ask — they
  need different devices and you can only drive one at a time.

## 2. Get the app onto a device (the heavy prerequisite)

mobile-mcp drives an app that is already **installed and running** on a **booted**
device. Two routes:

**Recommended — let the generator build + install it.** The agent's visual mode
already does the full build → install → launch on both platforms and is the
tested path. Re-run the generator for this spec with `NATIVEAPPTEMPLATE_VISUAL=1`
(home-screen build) or `=2` (full scripted walk). After it finishes the app is
installed and launched on the booted device, and you can pick up here for
interactive exploration.

**Manual — build it yourself** from `out/<slug>/`:
- **iOS:** the scheme is the project's PascalCase name (run `xcodebuild -list` in
  `out/<slug>/ios/` to confirm it). Build for the iPhone 17 Pro simulator
  (`xcodebuild -scheme <Pascal> -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2' build`),
  then install/launch on the booted sim.
- **Android:** from `out/<slug>/android/`, `./gradlew assembleDebug && ./gradlew installDebug`.

Device readiness:
- **iOS:** ensure a simulator is booted (`xcrun simctl list devices | grep Booted`;
  boot iPhone 17 Pro + `open -a Simulator` if none).
- **Android:** ensure an emulator is running. Boot it from **Android Studio's
  Device Manager** — don't start it with the CLI `emulator -avd` on this machine
  (Android Studio owns adb here). Confirm with `adb devices`.

If the app needs live data past the welcome screen, the generated Rails API must
be running: in `out/<slug>/rails/`, `mise exec -- bin/dev` (after `bundle install`
+ `db:prepare` + `db:seed_fu`).

## 3. Connect mobile-mcp to the device

Use mobile-mcp to list available devices and select the booted simulator/emulator.
Then list installed apps and launch the generated one (match on the project's
display name / PascalCase name) — launching by name via mobile-mcp avoids hunting
for the bundle id / package name.

## 4. Capture and walk

The point of this skill is showing, not narrating:
1. Take a screenshot of the current screen and **surface it inline** to the user.
2. List on-screen elements (mobile-mcp prefers the accessibility tree — more
   reliable than coordinate taps) so you and the user can see what's actionable.
3. Briefly describe what's on screen in domain terms (the renamed entities, not
   substrate tokens — e.g. "Barbershop list", "Add Ticket").

Then offer to walk a short flow. A sensible default for these apps mirrors the
validated scenario: Welcome → Sign Up → Sign In → drill into the seeded sample.
Take a fresh screenshot after each meaningful step and show it. Keep steps small
and confirm before destructive actions.

## 5. Stay interactive

This is exploratory, not a fixed script. After the home-screen capture, let the
user drive: "tap Sign Up", "go back", "what's on this screen?". Drive mobile-mcp
per request and return a screenshot each time. That conversational loop — generate,
then walk the running app together — is the whole reason this skill exists.

## 6. When it fails

The device layer fails in known ways; diagnose, don't just retry:
- **No device / mobile-mcp finds nothing** → the sim/emulator isn't booted, or
  (Android) Studio isn't running and adb sees no device. Point the user at §2.
- **App not installed** → the build/install step didn't run or failed; fall back to
  the recommended `NATIVEAPPTEMPLATE_VISUAL=1` route.
- **App launches but screens are blank / error** → the Rails API likely isn't
  running or the app can't reach it; start it (§2) and check the
  `NATIVEAPPTEMPLATE_API_*` env the app was built against.
- **Build fails** → surface the compiler output; Jetpack Compose + Hilt are the
  known-cryptic ones. Offer a repair re-run of `generate-app` with
  `NATIVEAPPTEMPLATE_REPAIR=on`.
