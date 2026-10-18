/** Identity providers a user can sign in with. Keyed by the provider's immutable user ID. */
export const IDENTITY_PROVIDERS = ["github"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];
