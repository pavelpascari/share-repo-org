import { simulatedEntitlementSource } from "@sharerepo/application";
import { randomIds, systemClock } from "@sharerepo/domain";
import { createGitHubApp, createMailPort, createPaddleClient } from "@sharerepo/integrations";
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
  paddle: ({ apiKey, apiBaseUrl }) =>
    createPaddleClient({
      apiKey,
      apiBaseUrl,
      fetch: globalThis.fetch.bind(globalThis),
      clock: systemClock,
    }),
  mail: (transport, from) =>
    createMailPort(transport, { from, fetch: globalThis.fetch.bind(globalThis) }),
  // The jobs Worker produces to the queue it consumes, for follow-up work (decision 0003).
  followUps: (env) => env.EVENTS,
}) satisfies ExportedHandler<Env>;
