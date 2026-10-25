import type { Logger } from "./logger.ts";

/** What an alert line may carry: IDs, codes, counts and instants, never free text or secrets. */
export type AlertIds = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Logs one alert line (decision 0014): `{"msg":"alert","alert":"<name>",…ids}` at warn level. A
 * Cloudflare Monitor emails on any line with an `alert` field, so `name` must come from the
 * domain's closed `AlertName` vocabulary (the platform does not depend on the domain).
 */
export function alert(logger: Logger, name: string, ids: AlertIds = {}): void {
  logger.warn("alert", { ...ids, alert: name });
}
