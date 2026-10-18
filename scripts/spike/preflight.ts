/** Facts the spike reads before it changes anything. */
export interface PreflightFacts {
  readonly owner: string;
  readonly subscriber: string;
  readonly repoPrivate: boolean;
  readonly repoOwnerType: string;
  readonly installationAccountLogin: string;
  readonly installationAccountType: string;
  readonly installationSuspended: boolean;
}

/** Reasons the spike must not run against this repository; empty means safe to proceed. */
export function preflightProblems(facts: PreflightFacts): string[] {
  const problems: string[] = [];
  if (!facts.repoPrivate) {
    problems.push("the repository is public: use a private test repository");
  }
  if (facts.repoOwnerType !== "User") {
    problems.push(
      `the repository is owned by a ${facts.repoOwnerType}, not a personal account (decision 0008)`,
    );
  }
  if (facts.installationAccountType !== "User") {
    problems.push("the App is installed on an organization, not a personal account");
  }
  if (facts.installationAccountLogin.toLowerCase() !== facts.owner.toLowerCase()) {
    problems.push("the installation belongs to a different account than the repository owner");
  }
  if (facts.installationSuspended) {
    problems.push("the installation is suspended: unsuspend it on GitHub first");
  }
  if (facts.subscriber.toLowerCase() === facts.owner.toLowerCase()) {
    problems.push("the subscriber must be a different account from the repository owner");
  }
  return problems;
}

/** Parses `owner/name`; null when the shape is wrong. */
export function parseRepoArgument(
  value: string | undefined,
): { owner: string; repo: string } | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value ?? "");
  if (match === null) return null;
  const [, owner = "", repo = ""] = match;
  return { owner, repo };
}
