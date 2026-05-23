import type { DomainSpec } from "../../agents/types.js";
import type { Stage2Scenario, Stage2Step } from "../stage2.js";

// Canonical scripted-CRUD scenario for the walk-in queue substrate, after
// rename. Walks: launch → welcome → sign up → land on primary-resource
// list → create one resource → create one queue entry → toggle entry
// state → screenshot the post-toggle list.
//
// Mirrors docs/SPEC.md §Layer-2 Stage 2 ("sign up → create primary
// resource → list → update state → delete"); the delete step is
// intentionally deferred until the rest of the walk is solid.
//
// Labels here are split into two groups:
//
//   1. Auth-side labels (Welcome, Start, Sign Up for an Account, Full
//      Name, Email, Password, Sign Up) come from the substrate's own
//      onboarding UI and are stable across renames. These have been
//      verified against a live iOS Sim of the generated app.
//
//   2. Domain-side labels — the renamed primary noun (Shop -> Clinic /
//      Restaurant / ...) and queue-entry noun (ItemTag -> Patient /
//      Reservation / ...) — come from the rename plan so the scenario
//      survives any rename pair.
//
// Coverage status (as of 2026-05-09):
//   ✓ Welcome screen → tap Start (verified)
//   ✓ Auth choice → tap "Sign Up for an Account" (verified)
//   ✓ Sign Up form labels: Full Name / Email / Password / Sign Up button (verified)
//   ⚠ Post-signup flow (resource list / create / drill / toggle) — NOT yet
//      verified against a live sim; labels below are best-effort guesses
//      based on the substrate's typical UX. Real-sim run will surface
//      mismatches as `wait_for_text "X": not found` errors; iterate from
//      there to tighten labels.
//
// findByText uses case-insensitive substring matching, so "Sign Up"
// would match both the "Sign Up for an Account" button on the auth
// screen AND the "Sign Up" StaticText header on the form screen.
// Use the full unique label (e.g. "Sign Up for an Account") to
// disambiguate which screen the wait/tap targets.

export type QueueScenarioInputs = {
  fullName: string;
  email: string;
  password: string;
  // Display name for the new primary resource (e.g. "Acme Vet Clinic").
  primaryResourceName: string;
  // Absolute path to the generated rails dir. Used by rails_runner
  // steps to bypass parts of the substrate auth flow that aren't
  // traversable via UI alone (notably the email-confirmation click).
  railsOutDir: string;
};

export type Platform = "ios" | "android";

export function buildQueueScenario(
  domain: DomainSpec,
  inputs: QueueScenarioInputs,
  platform: Platform = "ios",
): Stage2Scenario {
  const queueEntryName = renamedTo(domain, "ItemTag") ?? "ItemTag";
  // Renamed Shopkeeper class (Vet for clinic, Host for restaurant,
  // Curator for journal, etc.). Used by the rails_runner confirm
  // step to bypass email confirmation server-side.
  const shopkeeperClass = renamedTo(domain, "Shopkeeper") ?? "Shopkeeper";

  // Sign In form-fill diverges per platform: iOS Compose uses a
  // SecureTextField type for the password (queryable by tap_field);
  // Android Compose's empty OutlinedTextField doesn't surface an
  // EditText in the accessibility tree until it has content. Tap the
  // visible TextView label to focus the field instead.
  const signInFormFill: Stage2Step[] = platform === "ios"
    ? [
        { kind: "tap_field", fieldTypes: ["TextField", "EditText"], nth: 0 },
        { kind: "type", text: inputs.email, submit: true },
        { kind: "tap_field", fieldTypes: ["SecureTextField", "EditText"], nth: -1 },
        { kind: "type", text: inputs.password, submit: true },
      ]
    : [
        // exact:true scopes to the standalone label TextView. Without
        // it, "Password" substring-matches "Forgot your password?" (a
        // link that navigates away to the password-reset screen).
        //
        // submit:true is OMITTED on Android because mobile-mcp injects
        // a literal newline character ("\n", surfaces as "&#10;") into
        // the field instead of dismissing the keyboard — which then
        // fails Email validation. Use press_button "BACK" instead to
        // dismiss the keyboard before the next tap.
        { kind: "tap_text", text: "Email", exact: true },
        { kind: "type", text: inputs.email },
        { kind: "press_button", button: "BACK", optional: true },
        { kind: "tap_text", text: "Password", exact: true },
        { kind: "type", text: inputs.password },
        { kind: "press_button", button: "BACK", optional: true },
      ];

  const steps: Stage2Step[] = [
    // ---- Verified: Welcome → Auth choice → Sign Up form ----

    { kind: "wait_for_text", text: "Welcome to" },
    { kind: "screenshot", label: "01-welcome" },
    { kind: "tap_text", text: "Start" },

    { kind: "wait_for_text", text: "Sign Up for an Account" },
    { kind: "screenshot", label: "02-auth-choice" },
    { kind: "tap_text", text: "Sign Up for an Account" },

    { kind: "wait_for_text", text: "Full Name" },
    { kind: "screenshot", label: "03-signup-form" },
    // Form fields don't bind to their labels — tap_text on the label
    // hits the dead StaticText and leaves the TextField unfocused.
    // tap_below_text bias-taps where the field actually sits.
    { kind: "tap_below_text", text: "Full Name" },
    { kind: "type", text: inputs.fullName },

    { kind: "tap_below_text", text: "Email" },
    { kind: "type", text: inputs.email },

    { kind: "tap_below_text", text: "Password" },
    // submit:true dismisses the on-screen keyboard after the last
    // field — without it, the keyboard occludes the bottom Sign Up
    // button and tap_text "Sign Up" hits the keyboard area instead.
    { kind: "type", text: inputs.password, submit: true },

    // Dismiss the on-screen keyboard before tapping Sign Up. On
    // iOS the keychain dialog handler below catches things; on
    // Android the Sign Up submit button (Compose, rendered as
    // TextView at y~2613) sits near the bottom and the keyboard can
    // occlude it / push it off-tappable area. press_button "BACK" is
    // Android's keyboard-dismiss; on iOS it's not a real key and
    // mobile-mcp may error or no-op — we wrap in try/catch via the
    // press_button no-throw semantics in the runner.
    { kind: "press_button", button: "BACK", optional: true },

    // tap_text prefers Button-typed matches over StaticText/TextView,
    // so this hits the form's bottom Sign Up button rather than the
    // page-header that shares the label. On Android Compose, the
    // bottom-most fallback (when no Button-type match exists) finds
    // the lower TextView "Sign Up".
    { kind: "tap_text", text: "Sign Up" },

    // After successful signup, iOS shows the Keychain "Save password?"
    // system dialog. optional:true means we no-op if it doesn't appear
    // (e.g. on Android, or if Keychain is disabled). Try the Japanese
    // and English labels — Japanese-localized sims see "今はしない",
    // English see "Not Now". Same dialog, locale-dependent label.
    { kind: "tap_text", text: "今はしない", optional: true, timeoutMs: 3_000 },
    { kind: "tap_text", text: "Not Now", optional: true, timeoutMs: 3_000 },

    // Substrate uses devise_token_auth's email-confirmation flow:
    // signup → "check your email" banner → user must click the email
    // link before they can sign in. We can't click the email
    // programmatically via UI alone, so bypass server-side: confirm
    // the just-created Vet directly. devise's `.confirm` flips
    // confirmed_at and unblocks sign-in.
    {
      kind: "rails_runner",
      outDir: inputs.railsOutDir,
      ruby: `${shopkeeperClass}.find_by(email: ${JSON.stringify(inputs.email)})&.confirm`,
      label: "confirm vet",
    },

    // After confirmation, dismiss the post-signup banner (if visible)
    // and tap Sign In to land on the (renamed primary noun) list. iOS
    // labels the banner button "Close"; Android Compose substrate
    // labels it "Dismiss". Both are optional — only one fires per
    // platform; the other no-ops.
    { kind: "tap_text", text: "Close", optional: true, timeoutMs: 3_000 },
    { kind: "tap_text", text: "Dismiss", optional: true, timeoutMs: 3_000 },
    // The iOS Keychain "Save password?" dialog can surface LATE — after the
    // rails_runner confirm above, not right at signup — so it re-covers the
    // auth screen here and intercepts the Sign-In tap (observed: poll saw only
    // the 5 dialog elements). Dismiss it again immediately before tapping Sign
    // In; optional, so it no-ops on Android / when already gone.
    { kind: "tap_text", text: "今はしない", optional: true, timeoutMs: 3_000 },
    { kind: "tap_text", text: "Not Now", optional: true, timeoutMs: 3_000 },
    { kind: "tap_text", text: "Sign In to Your Account" },
    { kind: "wait_for_text", text: "Email", timeoutMs: 10_000 },
    // Sign In form-fill is platform-specific (built above). iOS uses
    // tap_field with SecureTextField; Android uses tap_text "Email" /
    // "Password" since Compose's empty OutlinedTextField doesn't
    // surface an EditText in the accessibility tree.
    ...signInFormFill,
    { kind: "tap_text", text: "Sign In" },

    // iOS Keychain shows "Save password?" again after a successful
    // Sign In (not just Sign Up). Same dismissal pattern.
    { kind: "tap_text", text: "今はしない", optional: true, timeoutMs: 3_000 },
    { kind: "tap_text", text: "Not Now", optional: true, timeoutMs: 3_000 },

    // PAID-substrate-only intro modal after Sign In: "You are in
    // personal organization. ... Switch to or create an organization
    // to share..." with a "Create <Primary>" CTA that opens the
    // creation form. Free edition has no multi-tenancy so the modal
    // never appears — these waits/taps are effectively skipped on
    // free because the post-Sign-In screen ALREADY shows
    // primaryName (free) without a modal in the way.
    //
    // Free path: wait_for_text "Clinic" matches the list view
    // header; the optional Create-* taps below find nothing and
    // no-op (but the unconditional `tap_text "Add"` later matches
    // the free toolbar).
    //
    // Paid path: wait_for_text "Clinic" matches the modal's Create
    // <Primary> button label (substring). We can't tap it yet
    // because the modal might still be animating in — explicit
    // wait_for_text below with a longer timeout + exact:true on the
    // "Create <Primary>" button gates correctly.
    //
    // Paid-substrate-only post-Sign-In multi-tenancy explainer.
    // Per platform:
    //   iOS:     two modal phases — v1 "OK"+"Go to Organizations",
    //            then v2 "Create <Primary>"+"Go to Organizations"+
    //            "Cancel". OK then Cancel both dismiss.
    //   Android: single snackbar with a "Dismiss" button.
    // All optional with short timeouts so free no-ops cleanly. The
    // walk picks up at the auto-seeded "Sample <Primary>" the
    // substrate created during signup — no need to navigate the
    // create-resource flow at all.
    { kind: "tap_text", text: "OK", exact: true, optional: true, timeoutMs: 5_000 },
    { kind: "tap_text", text: "Cancel", exact: true, optional: true, timeoutMs: 5_000 },
    { kind: "tap_text", text: "Dismiss", exact: true, optional: true, timeoutMs: 5_000 },

    // ---- Unverified below — best-effort guesses, expect drift ----

    // After auth + modal dismissals, drill DIRECTLY into the
    // substrate's auto-seeded "Sample <Primary>" resource (created
    // by Account#create_default_clinic! on every signup, both
    // editions). This skips the per-edition Create flow complexity
    // (paid hides Create behind multi-tenancy modals; free shows
    // an Add button) — the auto-seeded resource is enough to
    // demonstrate the rubric (renamed domain content with visible
    // state badge).
    //
    // iOS requests notification permission at runtime when the list first
    // loads. A system alert makes the accessibility tree return ONLY the
    // alert's elements, hiding the list — so wait_for_text "Sample" below sees
    // just the dialog (observed: "5 elements") and times out. Dismiss it
    // (Allow; JP + EN labels, exact so "許可" doesn't match "許可しない").
    // Optional + Android no-op: Android pre-grants POST_NOTIFICATIONS (#78).
    { kind: "tap_text", text: "許可", exact: true, optional: true, timeoutMs: 5_000 },
    { kind: "tap_text", text: "Allow", exact: true, optional: true, timeoutMs: 3_000 },

    // The iOS Keychain "Save password?" dialog also re-appears here — after a
    // successful Sign In, once the list loads — covering "Sample Household"
    // (observed: poll saw only the 5 dialog elements). Dismiss it again right
    // before the Sample wait. Optional; Android no-op.
    { kind: "tap_text", text: "今はしない", optional: true, timeoutMs: 5_000 },
    { kind: "tap_text", text: "Not Now", optional: true, timeoutMs: 3_000 },

    // Paid-only "You are in personal organization" multi-tenancy modal ALSO
    // surfaces here — late, once the list loads, covering "Sample Household".
    // Tap OK (and Cancel for the 2nd phase) to dismiss to the list. Optional;
    // free edition / Android no-op.
    { kind: "tap_text", text: "OK", exact: true, optional: true, timeoutMs: 5_000 },
    { kind: "tap_text", text: "Cancel", exact: true, optional: true, timeoutMs: 3_000 },

    // The substrate's seed name "Sample" doesn't get renamed (it's
    // a value, not a domain identifier). On every edition the list
    // shows an entry containing "Sample" — wait for it.
    { kind: "wait_for_text", text: "Sample", timeoutMs: 15_000 },
    { kind: "screenshot", label: "04-primary-list-with-sample" },

    // Drill into the sample resource to reach the queue-entry list.
    // Substrate auto-creates a "Sample" queue entry inside the
    // sample primary resource too (Clinic#create_sample_patient or
    // equivalent), so the list isn't empty — this screenshot shows
    // real domain content with the renamed state badge.
    { kind: "tap_text", text: "Sample" },
    { kind: "wait_for_text", text: queueEntryName, timeoutMs: 15_000 },
    { kind: "screenshot", label: "06-queue-entry-list" },

    // Stage 2 ends here. The agent has demonstrated end-to-end:
    //   planner → renamer → workers → reviewer → Layer 1 + 2 + 3
    //   Stage 1 → bin/dev → Stage 2 walk through signup → email-
    //   confirm bypass → sign in → resource creation → drill into
    //   queue-entry list with the substrate's auto-seeded sample.
    //
    // Adding a NEW entry + toggling its state are deferred — they
    // require mapping the substrate's "+" / swipe / state-toggle
    // affordances which are icon-only and aren't reliably matched
    // by tap_text. Layer 3 judges the screenshot above, which
    // already contains the renamed primary resource ("Vet Clinic
    // Queue"), the renamed queue entry noun ("Patient" via
    // queueEntryName), and the renamed state badge — sufficient
    // to satisfy the Stage 2 rubric.
  ];

  return {
    name: `queue-crud-${domain.slug}`,
    steps,
  };
}

function renamedTo(domain: DomainSpec, from: string): string | undefined {
  return domain.renamePlan.find((p) => p.from === from)?.to;
}
