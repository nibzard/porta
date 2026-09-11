import { randomUUID } from "node:crypto";
import type { EnvironmentLease } from "../../schema/adapter.js";
import type { EnvironmentManifest } from "../../schema/capability.js";
import { matchEnvironment } from "../../core/matching.js";
import {
  PYTHON_CAPABILITY_ID,
  PYTHON_SUBSETS,
} from "../../runtime/python-capability.js";
import type {
  PythonAttributeDeclarations,
  PythonEvaluateResult,
} from "../../runtime/python-capability.js";
import type { ConformanceCase, ConformanceContext } from "../runner.js";
import type { ConformanceCaseAnswer } from "../runner.js";

/**
 * Lightweight Python conformance cases (SPEC.md section 21).
 *
 * The pack verifies the selected engine against its advertised
 * evaluation subset: the declared attributes, the imports the
 * declaration names, the limits around host functions, serialization
 * in and out, structured exceptions, and the call isolation that
 * keeps interpreter locals from becoming state.
 *
 * Cases that evaluate source on the loaded adapter declare external
 * effects: the engine runs real programs in real workers. The
 * matching case reads the offer and decides in memory.
 */

/** Modules the case tries when it looks for one nobody declared. */
const UNDECLARED_CANDIDATES = ["random", "statistics", "time", "uuid", "os", "sys", "socket"];

/** Read one portable error's code, or null for anything else. */
function codeOf(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

/** The answer of one observation that must refuse with a code. */
async function expectCode(
  run: () => unknown,
  wanted: string,
): Promise<ConformanceCaseAnswer | void> {
  try {
    await run();
  } catch (error) {
    const code = codeOf(error);
    if (code === wanted) {
      return undefined;
    }
    return {
      outcome: "fail",
      reason: `expected ${wanted}, saw ${code ?? "no portable error"}`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { outcome: "fail", reason: `expected ${wanted}, the call succeeded` };
}

/** Acquire one environment from the loaded adapter. */
async function acquireOnce(context: ConformanceContext): Promise<EnvironmentLease> {
  return context.adapter.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: { name: "python", providerId: context.adapter.id, requires: {} },
    authority: { principal: "conformance", policyRef: "policy://conformance" },
  });
}

/**
 * Evaluate one program on the loaded adapter and return its result.
 *
 * An operation that does not complete is a finding; the thrown
 * message carries the reported error for the report.
 */
async function evaluate(
  lease: EnvironmentLease,
  input: Record<string, unknown>,
): Promise<PythonEvaluateResult> {
  const answered = await lease.invoke({
    operationId: `op-${randomUUID()}`,
    capability: PYTHON_CAPABILITY_ID,
    operation: "evaluate",
    input,
    environmentId: lease.environmentId,
    limits: {},
  });
  if (answered.status !== "completed") {
    throw new Error(
      `The evaluation did not complete: ${JSON.stringify((answered as { error?: unknown }).error)}`,
    );
  }
  return answered.result as PythonEvaluateResult;
}

/** The declared Python attributes of the loaded adapter. */
async function declaredOf(
  lease: EnvironmentLease,
): Promise<PythonAttributeDeclarations> {
  const manifest: EnvironmentManifest = await lease.manifest();
  const entry = manifest.capabilities.find(
    (capability) => capability.id === PYTHON_CAPABILITY_ID,
  );
  if (entry === undefined) {
    throw new Error("The manifest offers no exec.python@1 capability.");
  }
  return entry.attributes as unknown as PythonAttributeDeclarations;
}

/** The Python case pack. */
export function pythonCases(): ConformanceCase[] {
  return [
    {
      id: "python.declared-subset",
      area: "python",
      capability: "exec.python@1",
      summary: "The declared subset and isolation shape carry, and subset syntax runs.",
      effects: { external: true },
      async run(context) {
        const lease = await acquireOnce(context);
        const declared = await declaredOf(lease);
        if (!(PYTHON_SUBSETS as readonly string[]).includes(declared.subset)) {
          return {
            outcome: "fail",
            reason: "the declared subset is not one this contract defines",
            detail: String(declared.subset),
          };
        }
        if (declared.persistentState !== "call-isolated") {
          return {
            outcome: "fail",
            reason: "the declared persistent state is not call-isolated",
            detail: String(declared.persistentState),
          };
        }
        const result = await evaluate(lease, {
          source: "[x * 2 for x in items] + [extra]",
          variables: { items: [1, 2], extra: 5 },
        });
        if (result.exception !== undefined) {
          return {
            outcome: "fail",
            reason: "subset syntax raised instead of running",
            detail: `${result.exception.type}: ${result.exception.message}`,
          };
        }
        if (JSON.stringify(result.value) !== JSON.stringify([2, 4, 5])) {
          return {
            outcome: "fail",
            reason: "the subset program computed the wrong value",
            detail: JSON.stringify(result.value),
          };
        }
        return {
          outcome: "pass",
          detail: `Engine ${declared.engine}, subset ${declared.subset}, calls isolated.`,
        };
      },
    },
    {
      id: "python.unsupported-imports",
      area: "python",
      capability: "exec.python@1",
      summary: "An import the declaration does not name raises a structured exception.",
      effects: { external: true },
      async run(context) {
        const lease = await acquireOnce(context);
        const declared = await declaredOf(lease);
        if (declared.imports.includes("*")) {
          return {
            outcome: "skip",
            reason: "wildcard-imports-declared",
            detail: "The provider declares every module importable.",
          };
        }
        const missing = UNDECLARED_CANDIDATES.find(
          (name) => !declared.imports.includes(name),
        );
        if (missing === undefined) {
          return {
            outcome: "skip",
            reason: "no-undeclared-candidate",
            detail: "Every candidate module the case knows is declared.",
          };
        }
        const refused = await evaluate(lease, { source: `import ${missing}` });
        if (refused.exception?.type !== "ModuleNotFoundError") {
          return {
            outcome: "fail",
            reason: `importing ${missing} did not raise ModuleNotFoundError`,
            detail: JSON.stringify(refused.exception ?? refused.value),
          };
        }
        if (!refused.exception.message.includes(missing) || refused.value !== undefined) {
          return {
            outcome: "fail",
            reason: "the refusal does not name the module or invented a value",
            detail: JSON.stringify(refused.exception),
          };
        }
        if (declared.imports.length > 0) {
          const offered = declared.imports[0]!;
          const accepted = await evaluate(lease, { source: `import ${offered}` });
          if (accepted.exception !== undefined) {
            return {
              outcome: "fail",
              reason: `the declared import ${offered} did not run`,
              detail: `${accepted.exception.type}: ${accepted.exception.message}`,
            };
          }
        }
        return undefined;
      },
    },
    {
      id: "python.host-function-limits",
      area: "python",
      capability: "exec.python@1",
      summary: "Host-function bindings stay inside the declared names and shapes.",
      effects: { external: true },
      async run(context): Promise<ConformanceCaseAnswer> {
        const lease = await acquireOnce(context);
        const declared = await declaredOf(lease);
        // A name nobody offered refuses before any program runs.
        const undeclared = `porta_undeclared_${randomUUID().slice(0, 8)}`;
        const refused = await expectCode(
          () =>
            evaluate(lease, {
              source: "1",
              bindings: [{ name: undeclared, kind: "host-function" }],
            }),
          "InvalidRequest",
        );
        if (refused !== undefined) {
          return refused;
        }
        // One name bound twice refuses.
        const doubled = await expectCode(
          () =>
            evaluate(lease, {
              source: "1",
              bindings: [
                { name: "porta_a", kind: "host-function" },
                { name: "porta_a", kind: "host-function" },
              ],
            }),
          "InvalidRequest",
        );
        if (doubled !== undefined) {
          return doubled;
        }
        // A host-function binding carrying workspace fields refuses.
        const mixed = await expectCode(
          () =>
            evaluate(lease, {
              source: "1",
              bindings: [
                { name: "porta_b", kind: "host-function", path: "data" },
              ],
            }),
          "InvalidRequest",
        );
        if (mixed !== undefined) {
          return mixed;
        }
        if (declared.hostFunctions.length === 0) {
          return {
            outcome: "pass",
            detail: "No host functions are declared; every undeclared binding refused.",
          };
        }
        // A declared name binds and reaches its function: the call
        // answers with a value or a structured host error, never a
        // transport failure.
        const offered = declared.hostFunctions[0]!;
        const answered = await evaluate(lease, {
          source: `${offered}()`,
          bindings: [{ name: offered, kind: "host-function" }],
        });
        if (answered.timedOut !== false) {
          return {
            outcome: "fail",
            reason: "the host-function call timed out",
          };
        }
        return {
          outcome: "pass",
          detail: `Declared ${declared.hostFunctions.length} host function(s); the first answered.`,
        };
      },
    },
    {
      id: "python.serialization",
      area: "python",
      capability: "exec.python@1",
      summary: "JSON values cross in and out; what the contract cannot carry refuses.",
      effects: { external: true },
      async run(context) {
        const lease = await acquireOnce(context);
        const payload = {
          rows: [1, 2.5, true, null],
          name: "table",
          unicode: "héllo → 日本語",
        };
        const returned = await evaluate(lease, {
          source: "payload",
          variables: { payload },
        });
        if (JSON.stringify(returned.value) !== JSON.stringify(payload)) {
          return {
            outcome: "fail",
            reason: "the input value changed on its way to the program",
            detail: JSON.stringify(returned.value),
          };
        }
        const tuple = await evaluate(lease, { source: "(1, 'two', None)" });
        if (JSON.stringify(tuple.value) !== JSON.stringify([1, "two", null])) {
          return {
            outcome: "fail",
            reason: "a tuple did not cross as a JSON array",
            detail: JSON.stringify(tuple.value),
          };
        }
        const dictionary = await evaluate(lease, { source: "{'a': 1, 'b': {'c': 2}}" });
        if (JSON.stringify(dictionary.value) !== JSON.stringify({ a: 1, b: { c: 2 } })) {
          return {
            outcome: "fail",
            reason: "a dict did not cross as a JSON object",
            detail: JSON.stringify(dictionary.value),
          };
        }
        // A set has no JSON shape: the answer is a structured
        // exception, never a silently emptied value.
        const unsettleable = await evaluate(lease, { source: "{1, 2}" });
        if (unsettleable.exception?.type !== "TypeError" || unsettleable.value !== undefined) {
          return {
            outcome: "fail",
            reason: "an unserializable result did not refuse structurally",
            detail: JSON.stringify(unsettleable.exception ?? unsettleable.value),
          };
        }
        return undefined;
      },
    },
    {
      id: "python.structured-exceptions",
      area: "python",
      capability: "exec.python@1",
      summary: "A raising program answers with its exception type and message.",
      effects: { external: true },
      async run(context) {
        const lease = await acquireOnce(context);
        const raised = await evaluate(lease, {
          source: 'raise ValueError("boom")',
        });
        if (raised.exception?.type !== "ValueError") {
          return {
            outcome: "fail",
            reason: "the raised exception lost its type",
            detail: JSON.stringify(raised.exception ?? raised.value),
          };
        }
        if (!raised.exception.message.includes("boom") || raised.value !== undefined) {
          return {
            outcome: "fail",
            reason: "the exception lost its message or invented a value",
            detail: JSON.stringify(raised.exception),
          };
        }
        if (raised.timedOut !== false) {
          return {
            outcome: "fail",
            reason: "a raising program was reported as timed out",
          };
        }
        const named = await evaluate(lease, { source: "no_such_name" });
        if (named.exception?.type !== "NameError") {
          return {
            outcome: "fail",
            reason: "an undefined name did not raise NameError",
            detail: JSON.stringify(named.exception ?? named.value),
          };
        }
        return {
          outcome: "pass",
          detail: "Exceptions carry type and message; no stack trace stands alone.",
        };
      },
    },
    {
      id: "python.state-isolation",
      area: "python",
      capability: "exec.python@1",
      summary: "Nothing one call defines survives into the next, imports included.",
      effects: { external: true },
      async run(context) {
        const lease = await acquireOnce(context);
        const declared = await declaredOf(lease);
        const first = await evaluate(lease, { source: "leaked = 99\nleaked" });
        if (first.value !== 99) {
          return {
            outcome: "fail",
            reason: "the defining call did not run",
            detail: JSON.stringify(first.exception ?? first.value),
          };
        }
        const second = await evaluate(lease, { source: "leaked" });
        if (second.exception?.type !== "NameError") {
          return {
            outcome: "fail",
            reason: "a local of one call leaked into the next",
            detail: JSON.stringify(second.exception ?? second.value),
          };
        }
        if (declared.imports.length > 0 && !declared.imports.includes("*")) {
          const module = declared.imports[0]!;
          await evaluate(lease, { source: `import ${module}` });
          const gone = await evaluate(lease, {
            source: `${module}.__name__ if hasattr(${module}, '__name__') else 'present'`,
          });
          if (gone.exception?.type !== "NameError") {
            return {
              outcome: "fail",
              reason: "an import of one call leaked into the next",
              detail: JSON.stringify(gone.exception ?? gone.value),
            };
          }
        }
        return undefined;
      },
    },
    {
      id: "python.full-python-requirement",
      area: "python",
      capability: "exec.python@1",
      summary: "A requirement for full Python semantics refuses this provider explicitly.",
      async run(context): Promise<ConformanceCaseAnswer> {
        const offers = await context.adapter.describe();
        const offer = offers.find((entry) =>
          entry.capabilities.some((capability) => capability.id === PYTHON_CAPABILITY_ID),
        );
        if (offer === undefined) {
          return {
            outcome: "skip",
            reason: "capability-not-offered",
            detail: "The loaded adapter offers no exec.python@1 capability.",
          };
        }
        const declared = offer.capabilities
          .find((capability) => capability.id === PYTHON_CAPABILITY_ID)!
          .attributes as unknown as PythonAttributeDeclarations;
        const refused = await expectCode(
          () =>
            matchEnvironment(
              {
                name: "python",
                requires: {
                  [PYTHON_CAPABILITY_ID]: { subset: { equals: "full" } },
                },
              },
              [offer],
            ),
          "RequirementUnsatisfied",
        );
        if (refused !== undefined) {
          return refused;
        }
        // The control: the same offer satisfies its own declared
        // subset, so the refusal was about full semantics alone.
        matchEnvironment(
          {
            name: "python",
            requires: {
              [PYTHON_CAPABILITY_ID]: { subset: { equals: declared.subset } },
            },
          },
          [offer],
        );
        return {
          outcome: "pass",
          detail: `Subset ${declared.subset} matches; a full-Python requirement refuses.`,
        };
      },
    },
  ];
}
