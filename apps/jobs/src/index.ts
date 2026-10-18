import { randomIds, systemClock } from "@sharerepo/domain";
import { createJobsWorker } from "./handlers.ts";

export default createJobsWorker({
  ids: randomIds,
  clock: systemClock,
}) satisfies ExportedHandler<Env>;
