import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAcceptanceDemonstration } from "./demonstration.js";

/**
 * The acceptance demonstration (SPEC.md sections 22 and 22.1).
 *
 * One run walks all seven steps over the executable fixture and
 * returns the evidence. These assertions are the acceptance criteria
 * of the specification, not unit checks: every step leaves the
 * identifiers and statuses the MUSTs demand.
 *
 * - Every step of the flow completes with the evidence it promises.
 * - An injected replacement failure leaves one authority in charge,
 *   refuses the replaced generation, and never re-dispatches work
 *   whose effect stayed unknown.
 * - A local edit after the tested revision makes a write that still
 *   expects that revision conflict, and the conflict names it.
 */

/** The fixture root, resolved from the compiled test's location. */
const FIXTURE = fileURLToPath(new URL("../../fixtures/acceptance", import.meta.url));

test("the acceptance demonstration walks the seven steps and meets the criteria", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "porta-demonstration-"));
  try {
    const report = await runAcceptanceDemonstration({
      fixtureRoot: FIXTURE,
      workRoot,
    });

    // The automated destination says what it is: a stand-in, never
    // a claim of remote Linux.
    assert.equal(report.destination.label, "remote-linux-standin");
    assert.match(report.destination.note, /no remote Linux credentials/);

    // Step 1: the lightweight inspection, with no machine held.
    assert.deepEqual(report.inspection.value, [10, 0.4, 47.5, 1]);
    assert.equal(report.inspection.providerId, "monty-python");
    assert.equal(report.inspection.attachmentStatus, "released");
    assert.match(report.inspection.operationId, /^op-/);

    // Step 2: local native execution reconstructed the dependency.
    assert.equal(report.localExecution.generation, 1);
    assert.ok(report.localExecution.recipeSteps.length >= 1);
    for (const step of report.localExecution.recipeSteps) {
      assert.equal(step.exitCode, 0, `recipe step ${step.id} failed`);
    }
    assert.ok(report.localExecution.produced.length >= 1);
    assert.equal(report.localExecution.test.exitCode, 0);
    assert.match(report.localExecution.test.stdout, /data ok/);

    // Step 3: the checkpointed workspace and the independent browser.
    assert.notEqual(report.browserAttachment.revisionId, report.inspection.revisionId);
    assert.equal(report.browserAttachment.navigation.status, 200);
    assert.equal(report.browserAttachment.navigation.title, "Reading summary");
    assert.deepEqual(report.browserAttachment.observedSummary, {
      count: 10,
      lowest: 0.4,
      highest: 47.5,
      anomalies: 1,
    });
    assert.equal(report.browserAttachment.summaryMatchesInspection, true);
    assert.equal(report.browserAttachment.bindingStatus, "valid");

    // Step 4: the replacement switched generations and retired the
    // handles of the old one; the browser handle survived it.
    assert.equal(report.replacement.outcome, "completed");
    assert.equal(report.replacement.oldGeneration, 1);
    assert.equal(report.replacement.newGeneration, 2);
    assert.ok(report.replacement.newEnvironmentId.length > 0);
    assert.ok(report.replacement.reconstruction.length >= 1);
    for (const run of report.replacement.reconstruction) {
      assert.equal(run.outcome, "completed", `reconstruction ${run.recipeId} failed`);
    }
    assert.equal(report.replacement.invalidated.length, 3);
    for (const binding of report.replacement.invalidated) {
      assert.equal(binding.status, "invalidated");
    }
    assert.equal(report.replacement.browserBindingStatus, "bound");

    // Step 5: the same browser on the new server, and verification
    // artifacts that name the revision they tested.
    assert.equal(report.verification.navigation.status, 200);
    assert.equal(report.verification.summaryMatchesInspection, true);
    assert.notEqual(
      report.verification.reconnectedServiceId,
      report.browserAttachment.serviceId,
    );
    assert.equal(report.verification.testedRevisionId, report.browserAttachment.revisionId);
    assert.equal(report.verification.copyModified, false);
    assert.equal(report.verification.test.exitCode, 0);
    assert.match(report.verification.test.stdout, /data ok/);
    assert.equal(
      report.verification.artifact.workspaceRevisionId,
      report.verification.testedRevisionId,
    );
    assert.ok(report.verification.artifact.checks.length >= 2);
    for (const check of report.verification.artifact.checks) {
      assert.equal(check.passed, true, `artifact check ${check.name} failed`);
    }
    assert.equal(report.verification.checker.exitCode, 0);
    assert.match(report.verification.checker.stdout, /verified rev-/);

    // Step 6, first half: the injected failure left exactly one
    // authority, and nothing re-dispatched work of unknown effect.
    const failure = report.failureInjection;
    assert.equal(failure.outcome, "failed");
    assert.equal(failure.errorCode, "ProviderUnavailable");
    assert.match(failure.errorMessage, /porta-no-such-binary/);
    assert.equal(failure.failureCondition, "failed to start");
    assert.equal(failure.transitionPhase, "failed");
    assert.equal(failure.generationAfterFailure, 2);
    assert.equal(failure.computeStatusAfterFailure, "replacing");
    assert.equal(failure.dispatchesForFailingStep, 1);
    assert.equal(failure.retry.refused, true);
    assert.equal(failure.retry.newDispatches, 0);
    assert.equal(failure.retry.code, "StaleHandle");

    // Step 6, second half: the explicit abort returned the source to
    // authority at its unchanged generation, and one new request
    // recovered. Old handles refuse; the browser handle stays valid.
    assert.equal(failure.abort.sourceGeneration, 2);
    assert.equal(failure.abort.computeStatus, "active");
    assert.ok(failure.abort.survivingEffects.length >= 1);
    assert.equal(failure.recovery.outcome, "completed");
    assert.equal(failure.recovery.newGeneration, 3);
    assert.equal(failure.staleHandle.generation, 2);
    assert.equal(failure.staleHandle.code, "StaleHandle");
    assert.ok(failure.supersededBindingStatuses.length >= 1);
    for (const binding of failure.supersededBindingStatuses) {
      assert.equal(binding.status, "invalidated");
    }
    assert.equal(failure.browserStillValid.bindingStatus, "bound");
    assert.equal(failure.browserStillValid.providerState, "active");

    // Step 7: compute released, the session reopened with its
    // retained workspace, and the browser lease still real.
    const release = report.releaseAndReopen;
    assert.equal(release.releasedAttachmentId, report.localExecution.attachmentId);
    assert.equal(release.releaseStatus, "released");
    assert.ok(release.cleanupOutcomes.length >= 1);
    // One pass settles only its own provider's obligations; every
    // obligation is settled by the pass that owns it, and no
    // obligation stays only pending.
    const settled = new Set(
      release.cleanupOutcomes
        .filter((outcome) => outcome.outcome === "satisfied")
        .map((outcome) => outcome.cleanupId),
    );
    for (const outcome of release.cleanupOutcomes) {
      if (outcome.outcome === "pending") {
        assert.ok(
          settled.has(outcome.cleanupId),
          `obligation ${outcome.cleanupId} stayed pending: ${outcome.reason ?? "no reason"}`,
        );
      }
    }
    assert.equal(release.reopen.conversationRestored, false);
    assert.equal(release.reopen.headRevisionId, report.browserAttachment.revisionId);
    assert.equal(release.reopen.computeStatus, "released");
    assert.equal(release.reopen.browserStatus, "active");
    assert.equal(release.reopen.pendingCleanup, 0);
    assert.equal(release.browserLease.bindingStatus, "bound");
    assert.equal(release.browserLease.providerState, "active");

    // The workspace-conflict requirement: the edit published a new
    // revision over the tested one, and the write that still expected
    // the tested revision conflicted, naming it.
    const conflict = report.conflict;
    assert.notEqual(conflict.publishedRevisionId, conflict.earlierTestedRevisionId);
    assert.equal(conflict.parentId, conflict.earlierTestedRevisionId);
    assert.equal(conflict.staleWrite.code, "WorkspaceConflict");
    assert.equal(conflict.staleWrite.expectedHead, conflict.earlierTestedRevisionId);
    assert.equal(conflict.staleWrite.currentHead, conflict.publishedRevisionId);
  } finally {
    // The read-only materialization carries no write permission, so
    // the removal needs one permission pass first.
    spawnSync("chmod", ["-R", "u+w", workRoot]);
    rmSync(workRoot, { recursive: true, force: true });
  }
});
