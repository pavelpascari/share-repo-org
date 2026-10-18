// User-facing messages for GitHub setup failures (CompleteConnectionFailure codes).
export const GITHUB_SETUP_ERRORS: Readonly<Record<string, string>> = {
  invalid_state: "That GitHub connection link has expired or was already used. Start again.",
  not_owner: "Only workspace owners can connect GitHub.",
  installation_not_found: "GitHub did not find that installation. Try installing again.",
  account_not_supported:
    "ShareRepo supports repositories on personal GitHub accounts only. Install the App on your personal account.",
  account_mismatch: "Install the App on the GitHub account you signed in with.",
  installation_taken: "That installation is already connected to another workspace.",
};

export const GITHUB_SETUP_FALLBACK = "Connecting GitHub failed. Please try again.";
