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
};

export function buildQueueScenario(
  domain: DomainSpec,
  inputs: QueueScenarioInputs,
): Stage2Scenario {
  const primaryName = renamedTo(domain, "Shop") ?? "Shop";
  const queueEntryName = renamedTo(domain, "ItemTag") ?? "ItemTag";

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
    { kind: "tap_text", text: "Full Name" },
    { kind: "type", text: inputs.fullName },

    { kind: "tap_text", text: "Email" },
    { kind: "type", text: inputs.email },

    { kind: "tap_text", text: "Password" },
    { kind: "type", text: inputs.password },

    // The form's bottom button is also labeled "Sign Up" (matches the
    // "Sign Up" header). Two elements with the same label on the same
    // screen — findByText returns the first match (header). We rely on
    // mobile-mcp's element ordering placing the button before/after
    // the header consistently. If this lands on the wrong one, switch
    // to tap_coordinates from the screen-3 probe (button center ~201,644).
    { kind: "tap_text", text: "Sign Up" },

    // ---- Unverified below — best-effort guesses, expect drift ----

    // After auth, the user lands on the primary-resource list. The
    // empty state typically shows the renamed primary noun in a
    // header or "No <Primary>" placeholder. Either is sufficient to
    // match via substring.
    { kind: "wait_for_text", text: primaryName, timeoutMs: 15_000 },
    { kind: "screenshot", label: "04-primary-list-empty" },

    // Create one primary resource.
    { kind: "tap_text", text: "Add" },
    { kind: "wait_for_text", text: "Name" },
    { kind: "tap_text", text: "Name" },
    { kind: "type", text: inputs.primaryResourceName },
    { kind: "tap_text", text: "Save" },

    { kind: "wait_for_text", text: inputs.primaryResourceName },
    { kind: "screenshot", label: "05-primary-list-one" },

    // Drill into the resource to reach the queue-entry list.
    { kind: "tap_text", text: inputs.primaryResourceName },
    { kind: "wait_for_text", text: queueEntryName },
    { kind: "screenshot", label: "06-queue-entry-list" },

    // Add one queue entry.
    { kind: "tap_text", text: "Add" },
    { kind: "tap_text", text: "Save" },

    // Toggle the entry from Idled → Completed (substrate's two-state
    // machine per CLAUDE.md). The state badge renders as the current
    // state ("Idled") and the toggle button renders as the action
    // ("Mark as completed"). After tapping, the badge switches to
    // "Completed". Matcher is case-insensitive substring, so iOS chip
    // text "idled" and Android chip text "IDLED" both satisfy "Idled".
    { kind: "wait_for_text", text: "Idled" },
    { kind: "tap_text", text: "Mark as completed" },
    { kind: "wait_for_text", text: "Completed" },
    { kind: "screenshot", label: "07-entry-completed" },
    { kind: "assert_text", text: "Completed" },
  ];

  return {
    name: `queue-crud-${domain.slug}`,
    steps,
  };
}

function renamedTo(domain: DomainSpec, from: string): string | undefined {
  return domain.renamePlan.find((p) => p.from === from)?.to;
}
