export type SecurityProfile = "workspace" | "guarded";

export interface SecurityPolicyInput {
  readonly profile?: SecurityProfile;
  readonly restrictProcess?: boolean;
  readonly exposeRawProcess?: boolean;
  readonly verifierEvidence?: "full" | "summary";
}

export interface EffectiveSecurityPolicy {
  readonly schemaVersion: 1;
  readonly profile: SecurityProfile;
  readonly restrictProcess: boolean;
  readonly exposeRawProcess: boolean;
  readonly verifierEvidence: "full" | "summary";
  /** Provider credentials are removed from child-process environments. */
  readonly forwardsProviderCredentialsToTools: false;
  /** Fixed checks still execute as the current OS user unless the host supplies isolation. */
  readonly fixedChecksRequireExternalIsolationForUntrustedCode: true;
  readonly limitations: readonly string[];
}

/**
 * Resolves one named, auditable runtime posture. `guarded` is deliberately
 * fail-closed: callers cannot quietly re-enable the escape hatches that the
 * profile promises to remove.
 *
 * Neither profile claims an OS sandbox. Workspace boundaries constrain
 * Vanguard's own file tools; a fixed build/test command can execute project
 * code with the authority of the host process. Truly untrusted repositories
 * therefore require a container/VM boundary supplied by the embedding host.
 */
export function resolveSecurityPolicy(input: SecurityPolicyInput = {}): EffectiveSecurityPolicy {
  const profile = input.profile ?? "workspace";
  if (profile !== "workspace" && profile !== "guarded") {
    throw new Error(`Unsupported security profile '${String(profile)}'.`);
  }
  if (profile === "guarded") {
    if (input.restrictProcess === false) {
      throw new Error("The guarded security profile requires restricted process mode.");
    }
    if (input.exposeRawProcess === true) {
      throw new Error("The guarded security profile cannot expose the raw process tool.");
    }
    if (input.verifierEvidence === "full") {
      throw new Error("The guarded security profile requires summary-only verifier evidence.");
    }
    return {
      schemaVersion: 1,
      profile,
      restrictProcess: true,
      exposeRawProcess: false,
      verifierEvidence: "summary",
      forwardsProviderCredentialsToTools: false,
      fixedChecksRequireExternalIsolationForUntrustedCode: true,
      limitations: [
        "Node filesystem permissions constrain supported Node commands only; they are not a cross-language OS sandbox.",
        "Fixed build and verification commands may execute candidate code as the current OS user.",
        "Use an externally isolated runner for hostile repositories, plugins, or certification holdouts.",
      ],
    };
  }
  return {
    schemaVersion: 1,
    profile,
    restrictProcess: input.restrictProcess ?? false,
    exposeRawProcess: input.exposeRawProcess ?? true,
    verifierEvidence: input.verifierEvidence ?? "full",
    forwardsProviderCredentialsToTools: false,
    fixedChecksRequireExternalIsolationForUntrustedCode: true,
    limitations: [
      "The raw process tool and fixed checks execute with the current OS user's filesystem and network authority.",
      "Workspace confinement applies to Vanguard file tools, not arbitrary subprocess behavior.",
      "Use the guarded profile plus an externally isolated runner when repository code is not trusted.",
    ],
  };
}

