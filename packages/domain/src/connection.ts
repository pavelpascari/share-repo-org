/** A workspace's link to a provider account, such as a GitHub App installation. */
export const CONNECTION_STATUSES = ["active", "suspended", "deleted"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Provider account types ShareRepo can connect. v1: personal GitHub accounts only (decision 0008). */
export const CONNECTABLE_ACCOUNT_TYPES = ["user"] as const;
export type ConnectableAccountType = (typeof CONNECTABLE_ACCOUNT_TYPES)[number];
