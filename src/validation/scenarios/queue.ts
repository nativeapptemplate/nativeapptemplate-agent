import type { DomainSpec } from "../../agents/types.js";
import type { Stage2Scenario, Stage2Step } from "../stage2.js";

// Canonical scripted-CRUD scenario for the walk-in queue substrate, after
// rename. Walks: launch → sign up → land on primary-resource list → create
// one resource → create one queue entry → toggle entry state → screenshot
// the post-toggle list. Mirrors docs/SPEC.md §Layer-2 Stage 2 ("sign up →
// create primary resource → list → update state → delete"); the delete
// step is intentionally deferred until the runner has been validated
// against a live sim.
//
// Labels are looked up from the rename plan so the scenario survives any
// (Shop -> Clinic / Restaurant / Workspace / ...) renaming. Auth labels
// ("Sign Up", "Email", etc.) come from the substrate's own UI and are
// stable across renames.
//
// IMPORTANT: the exact button copy in the substrate UI hasn't been
// verified end-to-end yet — judge integration (PR 3) will surface any
// mismatches against a live iPhone Simulator and we'll either tighten
// these labels or expose them as overridable inputs at that point.

export type QueueScenarioInputs = {
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
    { kind: "wait_for_text", text: "Sign Up" },
    { kind: "screenshot", label: "01-welcome" },
    { kind: "tap_text", text: "Sign Up" },

    { kind: "wait_for_text", text: "Email" },
    { kind: "tap_text", text: "Email" },
    { kind: "type", text: inputs.email },

    { kind: "tap_text", text: "Password" },
    { kind: "type", text: inputs.password },

    { kind: "tap_text", text: "Create Account" },

    // After auth the user lands on the primary-resource list. The empty
    // state typically shows the renamed primary noun in a header or "No
    // <Primary>" placeholder. Either is sufficient to match.
    { kind: "wait_for_text", text: primaryName },
    { kind: "screenshot", label: "02-primary-list-empty" },

    // Create one primary resource.
    { kind: "tap_text", text: "Add" },
    { kind: "wait_for_text", text: "Name" },
    { kind: "tap_text", text: "Name" },
    { kind: "type", text: inputs.primaryResourceName },
    { kind: "tap_text", text: "Save" },

    { kind: "wait_for_text", text: inputs.primaryResourceName },
    { kind: "screenshot", label: "03-primary-list-one" },

    // Drill into the resource to reach the queue-entry list.
    { kind: "tap_text", text: inputs.primaryResourceName },
    { kind: "wait_for_text", text: queueEntryName },
    { kind: "screenshot", label: "04-queue-entry-list" },

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
    { kind: "screenshot", label: "05-entry-completed" },
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
