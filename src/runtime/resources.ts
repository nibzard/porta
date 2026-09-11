import { randomUUID } from "node:crypto";
import {
  invalidRequestError,
  invalidRequestFromValidation,
  providerUnavailableError,
  staleHandleError,
  unsupportedOperationError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import { resourceDescriptionSchema, resourceRefSchema } from "../schema/resource.js";
import type {
  RecoveryMode,
  ResourceDescription,
  ResourceLifetime,
  ResourceRef,
} from "../schema/resource.js";
import type { BindingResult } from "../schema/adapter.js";
import type { AttachmentRef, AttachmentSummary } from "../schema/session.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore, ResourceBindingRecord } from "../store/control-store.js";
import { checkAttachmentAcceptsOperations } from "./lifecycle.js";
import { requireOpenSession } from "./workspace.js";

/**
 * Resource binding and validity (SPEC.md section 10).
 *
 * A binding turns one provider-side stateful object into a portable
 * reference an authorized caller can hand to a consumer attachment. The
 * reference carries identity, owner, lifetime, and recovery class — never
 * a provider token, signed URL, or cookie. Credentials stay in the
 * authorized context the adapter reads at use time.
 *
 * Resolution reports the persisted truth. It checks authorization, owner
 * generation, resource status, and lease validity, in that order, and
 * answers with a `ResourceValidity` instead of an error: an invalid
 * handle is a state to report, not a failed read.
 *
 * Replacement and release invalidate the handles one attachment
 * generation owns. Reattaching an external resource creates a new
 * binding under the new generation; the old binding stays invalid
 * forever, even though the provider-side identity may be unchanged.
 */

/** Options of the binding-side flows. */
export interface ResourceFlowOptions {
  /** The policy authority in force for this call. */
  authority: PolicyAuthority;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** Input of one bind call. */
export interface BindResourceInput {
  /** Resource type label, for example `process.group`. */
  type: string;
  /** The attachment that owns the resource. */
  owner: AttachmentRef;
  /** The capability use of this resource is authorized through. */
  capability: string;
  /** How long the binding outlives a single operation. */
  lifetime: ResourceLifetime;
  /** How the resource crosses a handoff (SPEC.md section 12). */
  recovery: RecoveryMode;
  /** Provider-side identity, kept out of the portable reference. */
  providerResourceId?: string;
  /** Absolute expiry of the binding's lease, when one applies. */
  expiresAt?: string;
  extensions?: Record<string, unknown>;
}

/**
 * Transport to the provider's bind operation (SPEC.md sections 8 and 10).
 *
 * The runtime builds the credential-free reference and hands it to the
 * transport; the adapter binds it using credentials from the current
 * authorized context, which never enter the reference or the store.
 */
export interface BindTransport {
  bind(resource: ResourceRef): Promise<BindingResult>;
}

/** Options of one resolution call. */
export interface ResolveResourceOptions {
  /** The policy authority in force for this call. */
  authority: PolicyAuthority;
  /** The capability the caller resolves the resource through. */
  capability: string;
  /** The operation the caller resolves the resource for. */
  operation: string;
}

/**
 * Bind one resource and record its portable reference durably
 * (SPEC.md sections 8 and 10).
 *
 * Admission-style guards run before the provider call and again inside
 * the transaction that persists the binding. The provider answers with
 * `bound`, `unsupported`, or `failed`; only a `bound` answer records a
 * binding. The stored reference is schema-validated, so no credential
 * field can ride inside it.
 */
export async function bindResource(
  store: ControlStore,
  sessionId: string,
  input: BindResourceInput,
  transport: BindTransport,
  options: ResourceFlowOptions,
): Promise<ResourceDescription> {
  checkBindGuards(store, sessionId, input, options);

  const candidate = candidateRef(sessionId, input);
  const result = await transport.bind(candidate);
  if (result.status === "unsupported") {
    throw unsupportedOperationError(input.capability, "bind", {
      reason: "The provider does not support binding.",
    });
  }
  if (result.status === "failed") {
    throw result.error ?? providerUnavailableError("The provider binding failed.");
  }
  const ref = adoptedRef(candidate, result.binding);

  try {
    return store.transaction(() => {
      // The guards ran before the provider call; re-run the generation
      // check so a replacement that committed meanwhile finds no new
      // valid handle in the store.
      requireOpenSession(store, sessionId);
      const current = requireOwnerAttachment(store, sessionId, input.owner.attachmentId);
      if (current.generation !== input.owner.generation) {
        throw staleHandleError(
          { kind: "attachment-generation", value: input.owner.generation },
          { kind: "attachment-generation", value: current.generation },
        );
      }
      const record: ResourceBindingRecord = {
        id: ref.id,
        sessionId,
        type: ref.type,
        capability: input.capability,
        owner: { sessionId, attachmentId: input.owner.attachmentId, generation: current.generation },
        lifetime: ref.lifetime,
        recovery: ref.recovery,
        status: "bound",
        ...(ref.expiresAt !== undefined ? { expiresAt: ref.expiresAt } : {}),
        ...(input.providerResourceId !== undefined
          ? { providerResourceId: input.providerResourceId }
          : {}),
        ...(ref.extensions !== undefined ? { extensions: ref.extensions } : {}),
        boundAt: new Date().toISOString(),
      };
      store.insertResourceBinding(record);
      const stream = new SessionEventStream(store, sessionId, options.redactor);
      stream.append("resource.bound", record.id, {
        resourceId: record.id,
        type: record.type,
        ownerAttachmentId: record.owner.attachmentId,
        ownerGeneration: record.owner.generation,
        lifetime: record.lifetime,
        recovery: record.recovery,
      });
      return describe(record, "valid");
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/**
 * Resolve one resource reference against persisted state
 * (SPEC.md sections 10 and 15).
 *
 * The answer reports validity, never a guess. Checks run in the order
 * the specification names: authorization, owner generation, resource
 * status, lease validity.
 */
export function resolveResource(
  store: ControlStore,
  sessionId: string,
  resourceId: string,
  options: ResolveResourceOptions,
): ResourceDescription {
  const binding = store.getResourceBinding(sessionId, resourceId);
  if (binding === null) {
    return notFound(resourceId, sessionId);
  }

  // Authorization: the caller's policy must grant the operation, and
  // the binding must have been created for the capability named.
  const denied = options.authority.checkOperation(options.capability, options.operation);
  if (denied !== null || binding.capability !== options.capability) {
    return describe(binding, "unauthorized", {
      detail:
        binding.capability !== options.capability
          ? `The binding authorizes ${binding.capability}, not ${options.capability}.`
          : `The policy denies ${options.capability}/${options.operation}.`,
    });
  }

  // Owner generation: a replacement moved the attachment forward.
  const owner = store.getAttachment(binding.owner.attachmentId);
  if (owner === null || owner.sessionId !== sessionId) {
    return describe(binding, "released", {
      detail: "The owner attachment no longer exists in this session.",
    });
  }
  if (owner.generation !== binding.owner.generation) {
    return describe(binding, "stale-generation", {
      detail: `The binding names generation ${binding.owner.generation}; the attachment is at ${owner.generation}.`,
    });
  }

  // Resource status: an invalidated binding never becomes valid again,
  // and a released owner takes its bindings with it.
  if (binding.status === "invalidated") {
    return describe(binding, "released", {
      detail: binding.invalidationReason ?? "The binding was invalidated.",
    });
  }
  if (owner.status === "released" || owner.status === "failed") {
    return describe(binding, "released", {
      detail: `The owner attachment is ${owner.status}.`,
    });
  }

  // Lease validity: an expiry that passed ends the binding's authority.
  if (binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= Date.now()) {
    return describe(binding, "expired", {
      detail: `The binding expired at ${binding.expiresAt}.`,
    });
  }

  return describe(binding, "valid");
}

/**
 * Invalidate every binding one attachment generation owns
 * (SPEC.md section 10).
 *
 * Replacement and release call this sweep for the generation they end.
 * Bindings owned by other attachments — an independently attached
 * browser during compute replacement, for example — keep their own
 * generation and stay valid.
 */
export function invalidateOwnedResources(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
  generation: number,
  reason: string,
  options?: ResourceFlowOptions,
): ResourceDescription[] {
  try {
    return store.transaction(() => {
      const stream =
        options === undefined
          ? new SessionEventStream(store, sessionId)
          : new SessionEventStream(store, sessionId, options.redactor);
      const swept: ResourceDescription[] = [];
      for (const binding of store.listResourceBindingsForOwner(
        sessionId,
        attachmentId,
        generation,
        true,
      )) {
        const updated = store.markResourceBindingInvalidated(
          binding.id,
          reason,
          new Date().toISOString(),
        );
        if (updated === null) {
          continue;
        }
        stream.append("resource.invalidated", updated.id, {
          resourceId: updated.id,
          reason,
          ownerGeneration: updated.owner.generation,
          attachmentId: updated.owner.attachmentId,
        });
        swept.push(describe(updated, "released", { detail: reason }));
      }
      return swept;
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/**
 * Reattach one external resource under a new owner generation
 * (SPEC.md section 10).
 *
 * The reattachment creates a new binding with a new identifier; the old
 * binding is invalidated and stays invalid forever. The provider-side
 * identity may be unchanged — it carries over without reviving any old
 * handle.
 */
export function reattachResource(
  store: ControlStore,
  sessionId: string,
  resourceId: string,
  newOwner: AttachmentRef,
  options: ResourceFlowOptions,
): ResourceDescription {
  try {
    return store.transaction(() => {
      requireOpenSession(store, sessionId);
      const old = store.getResourceBinding(sessionId, resourceId);
      if (old === null) {
        throw invalidRequestError(`Resource ${resourceId} does not exist in this session.`, {
          sessionId,
          resourceId,
        });
      }
      if (old.recovery !== "reattach") {
        throw unsupportedOperationError(old.capability, "reattach", {
          resourceId,
          reason: `The resource recovers by ${old.recovery}, not by reattachment.`,
        });
      }
      if (newOwner.sessionId !== sessionId) {
        throw invalidRequestError("The new owner names another session.", {
          sessionId,
          attachmentSessionId: newOwner.sessionId,
        });
      }
      const owner = requireOwnerAttachment(store, sessionId, newOwner.attachmentId);
      const refused = checkAttachmentAcceptsOperations(owner);
      if (refused !== null || owner.status !== "active") {
        throw invalidRequestError(
          `Attachment ${owner.attachmentId} is ${owner.status}; it accepts no new bindings.`,
          { attachmentId: owner.attachmentId, status: owner.status },
        );
      }
      if (owner.generation !== newOwner.generation) {
        throw staleHandleError(
          { kind: "attachment-generation", value: newOwner.generation },
          { kind: "attachment-generation", value: owner.generation },
        );
      }
      const denied = options.authority.checkOperation(old.capability, "bind");
      if (denied !== null) {
        throw denied;
      }

      const stream = new SessionEventStream(store, sessionId, options.redactor);
      // The old handle dies first; the rebind never leaves two live
      // identifiers for one provider resource.
      if (old.status === "bound") {
        const invalidated = store.markResourceBindingInvalidated(
          old.id,
          "reattached",
          new Date().toISOString(),
        );
        if (invalidated !== null) {
          stream.append("resource.invalidated", invalidated.id, {
            resourceId: invalidated.id,
            reason: "reattached",
            ownerGeneration: invalidated.owner.generation,
            attachmentId: invalidated.owner.attachmentId,
          });
        }
      }

      const record: ResourceBindingRecord = {
        id: `res-${randomUUID()}`,
        sessionId,
        type: old.type,
        capability: old.capability,
        owner: { sessionId, attachmentId: newOwner.attachmentId, generation: newOwner.generation },
        lifetime: old.lifetime,
        recovery: old.recovery,
        status: "bound",
        ...(old.providerResourceId !== undefined
          ? { providerResourceId: old.providerResourceId }
          : {}),
        ...(old.expiresAt !== undefined ? { expiresAt: old.expiresAt } : {}),
        ...(old.extensions !== undefined ? { extensions: old.extensions } : {}),
        boundAt: new Date().toISOString(),
      };
      store.insertResourceBinding(record);
      stream.append("resource.rebound", record.id, {
        resourceId: record.id,
        ownerAttachmentId: record.owner.attachmentId,
        ownerGeneration: record.owner.generation,
        previousOwnerGeneration: old.owner.generation,
      });
      return describe(record, "valid");
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/** The pre-provider guards of one bind call. */
function checkBindGuards(
  store: ControlStore,
  sessionId: string,
  input: BindResourceInput,
  options: ResourceFlowOptions,
): AttachmentSummary {
  requireOpenSession(store, sessionId);
  if (input.owner.sessionId !== sessionId) {
    throw invalidRequestError("The owner reference names another session.", {
      sessionId,
      attachmentSessionId: input.owner.sessionId,
    });
  }
  const attachment = requireOwnerAttachment(store, sessionId, input.owner.attachmentId);
  const refused = checkAttachmentAcceptsOperations(attachment);
  if (refused !== null) {
    throw refused;
  }
  if (attachment.status !== "active") {
    throw invalidRequestError(
      `Attachment ${attachment.attachmentId} is ${attachment.status}; it accepts no new bindings.`,
      { attachmentId: attachment.attachmentId, status: attachment.status },
    );
  }
  if (attachment.generation !== input.owner.generation) {
    throw staleHandleError(
      { kind: "attachment-generation", value: input.owner.generation },
      { kind: "attachment-generation", value: attachment.generation },
    );
  }
  if (!attachment.capabilityIds.includes(input.capability)) {
    throw invalidRequestError(
      `Attachment ${attachment.attachmentId} does not offer ${input.capability}.`,
      {
        attachmentId: attachment.attachmentId,
        capability: input.capability,
        reason: "capability-not-offered",
      },
    );
  }
  const denied = options.authority.checkOperation(input.capability, "bind");
  if (denied !== null) {
    throw denied;
  }
  return attachment;
}

/** The reference a bind call offers to the provider. */
function candidateRef(sessionId: string, input: BindResourceInput): ResourceRef {
  const ref: ResourceRef = {
    id: `res-${randomUUID()}`,
    sessionId,
    type: input.type,
    owner: { ...input.owner },
    lifetime: input.lifetime,
    recovery: input.recovery,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  };
  return checkedRef(ref);
}

/**
 * The reference a bind call persists after the provider answers.
 *
 * The provider may return a binding; the runtime adopts only its expiry
 * and extensions, which the provider is better placed to know. Identity,
 * owner, and recovery class stay as the runtime issued them, so a
 * provider cannot widen a binding's scope in its answer.
 */
function adoptedRef(
  candidate: ResourceRef,
  providerBinding: ResourceRef | undefined,
): ResourceRef {
  if (providerBinding === undefined) {
    return candidate;
  }
  const checked = checkedRef(providerBinding);
  if (checked.sessionId !== candidate.sessionId || checked.id !== candidate.id) {
    throw invalidRequestError("The provider returned a reference for another resource.", {
      offered: candidate.id,
      returned: checked.id,
    });
  }
  return {
    ...candidate,
    ...(checked.expiresAt !== undefined ? { expiresAt: checked.expiresAt } : {}),
    ...(checked.extensions !== undefined ? { extensions: checked.extensions } : {}),
  };
}

/** Validate one reference shape, so no credential field can ride in it. */
function checkedRef(ref: ResourceRef): ResourceRef {
  try {
    assertValid(resourceRefSchema, ref);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  return ref;
}

/** Load one attachment of this session or refuse. */
function requireOwnerAttachment(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
): AttachmentSummary {
  const attachment = store.getAttachment(attachmentId);
  if (attachment === null || attachment.sessionId !== sessionId) {
    throw invalidRequestError(`Attachment ${attachmentId} does not exist in this session.`, {
      attachmentId,
    });
  }
  return attachment;
}

/** The portable reference of one stored binding. */
function refOf(binding: ResourceBindingRecord): ResourceRef {
  return {
    id: binding.id,
    sessionId: binding.sessionId,
    type: binding.type,
    owner: { ...binding.owner },
    lifetime: binding.lifetime,
    recovery: binding.recovery,
    ...(binding.expiresAt !== undefined ? { expiresAt: binding.expiresAt } : {}),
    ...(binding.extensions !== undefined ? { extensions: binding.extensions } : {}),
  };
}

/** One description of one stored binding, schema-checked before return. */
function describe(
  binding: ResourceBindingRecord,
  validity: ResourceDescription["validity"],
  extra?: { detail?: string },
): ResourceDescription {
  const description: ResourceDescription = {
    ref: refOf(binding),
    validity,
    ...(binding.providerResourceId !== undefined
      ? { providerResourceId: binding.providerResourceId }
      : {}),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
  };
  try {
    assertValid(resourceDescriptionSchema, description);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  return description;
}

/**
 * The description of a resource this session never bound.
 *
 * The schema requires a reference in every description. For a missing
 * resource the reference echoes the queried identifier over a synthetic
 * owner; the `not-found` validity and the detail carry the truth.
 */
function notFound(resourceId: string, sessionId: string): ResourceDescription {
  if (!/^\S+$/.test(resourceId) || resourceId.length > 128) {
    throw invalidRequestError("The resource identifier is not a valid identifier.", {
      resourceId,
    });
  }
  const description: ResourceDescription = {
    ref: {
      id: resourceId,
      sessionId,
      type: "unknown",
      owner: { sessionId, attachmentId: "att-unknown", generation: 1 },
      lifetime: "external",
      recovery: "none",
    },
    validity: "not-found",
    detail: `No binding exists for resource ${resourceId} in this session.`,
  };
  assertValid(resourceDescriptionSchema, description);
  return description;
}
