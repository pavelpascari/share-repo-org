import type { WorkspaceFieldError } from "@sharerepo/application";

const MESSAGES: Record<WorkspaceFieldError["code"], string> = {
  name_empty: "Enter a name.",
  name_too_long: "Use at most 100 characters.",
  name_invalid_characters: "Use a name without line breaks, tabs or other control characters.",
  slug_too_short: "Use at least 3 characters.",
  slug_too_long: "Use at most 48 characters.",
  slug_invalid_format: "Use lowercase letters, numbers and single hyphens.",
  slug_taken: "This URL is already taken.",
};

/** Field errors keyed by field, with user-facing messages. */
export function fieldMessages(errors: readonly WorkspaceFieldError[]) {
  const messages: Partial<Record<WorkspaceFieldError["field"], string>> = {};
  for (const error of errors) messages[error.field] = MESSAGES[error.code];
  return messages;
}
