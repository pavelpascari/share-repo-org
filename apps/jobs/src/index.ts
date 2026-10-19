import { simulatedEntitlementSource } from "@sharerepo/application";
import { randomIds, systemClock } from "@sharerepo/domain";
import { createGitHubApp } from "@sharerepo/integrations";
import { createJobsWorker } from "./handlers.ts";

export default createJobsWorker({
  ids: randomIds,
  clock: systemClock,
  simulatedSource: simulatedEntitlementSource,
  github: (config) =>
    createGitHubApp({
      appId: config.appId,
      privateKeyPem: config.privateKeyPem,
      apiBaseUrl: config.apiBaseUrl,
      fetch: globalThis.fetch.bind(globalThis),
      clock: systemClock,
    }),
}) satisfies ExportedHandler<Env>;
