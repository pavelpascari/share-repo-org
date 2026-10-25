import type { AlertName } from "@sharerepo/domain";
import type { Logger } from "./logger.ts";

/** An alert line's fields: identifiers and classified codes only, never secrets or personal data. */
export type AlertIds = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Logs one alert line (decision 0014): `alert: "<name>"` plus IDs and codes. A Cloudflare Monitor
 * emails on any line with an `alert` field, so this is the only way code raises one, and the
 * names are the closed `AlertName` vocabulary. Logged at `warn`: Workers Issues already reports
 * errors, and the Monitor, not the level, decides who is emailed. The name is written last, so an
 * ID field cannot replace it.
 */
export function alert(logger: Logger, name: AlertName, ids: AlertIds = {}): void {
  logger.warn(`alert: ${name}`, { ...ids, alert: name });
}
