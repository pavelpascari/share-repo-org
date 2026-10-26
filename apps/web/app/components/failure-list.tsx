import type { FailedJob, FailingRepository, PurgeBlocked } from "@sharerepo/application";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatInstant } from "../entitlement-messages.ts";
import {
  affectedText,
  JOB_KIND_LABELS,
  jobErrorText,
  purgeBlockText,
  reconcileErrorText,
} from "../failure-messages.ts";

/**
 * Failed jobs, oldest first (decision 0014): what the job did, the access it affects, why it
 * failed and when, with optional per-row controls (Retry, Dismiss).
 */
export function FailedJobsTable(props: {
  jobs: readonly FailedJob[];
  /** On `/ops`: a column naming each failure's workspace. */
  showWorkspace?: boolean;
  actions?: (job: FailedJob) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-300 text-gray-600">
          <tr>
            {props.showWorkspace && <th className="py-2 pr-4 font-medium">Workspace</th>}
            <th className="py-2 pr-4 font-medium">What failed</th>
            <th className="py-2 pr-4 font-medium">Affects</th>
            <th className="py-2 pr-4 font-medium">Why</th>
            <th className="py-2 pr-4 font-medium">Failed</th>
            {props.actions !== undefined && <th className="py-2 font-medium">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {props.jobs.map((job) => {
            const affected = affectedText(job.affected);
            return (
              <tr
                key={job.id}
                aria-label={JOB_KIND_LABELS[job.kind]}
                className="border-b border-gray-200 align-top"
              >
                {props.showWorkspace && (
                  <td className="py-2 pr-4">{job.workspaceName ?? "System"}</td>
                )}
                <td className="py-2 pr-4">{JOB_KIND_LABELS[job.kind]}</td>
                <td className="py-2 pr-4">
                  {affected.length === 0 ? (
                    <span className="text-gray-600">Nothing else to name</span>
                  ) : (
                    <ul>
                      {affected.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {jobErrorText(job.errorCode)}
                  <span className="block text-gray-600">
                    {job.attempts === 1 ? "1 attempt" : `${job.attempts} attempts`}
                  </span>
                </td>
                <td className="py-2 pr-4">{formatInstant(job.failedAt)}</td>
                {props.actions !== undefined && <td className="py-2">{props.actions(job)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Repositories whose checks keep failing, with the latest reason. */
export function FailingRepositoriesList(props: {
  repositories: readonly FailingRepository[];
  showWorkspace?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {props.repositories.map((repository) => (
        <li key={repository.resourceId} aria-label={repository.name} className="flex flex-col">
          <span className="font-medium">
            {repository.name}
            {props.showWorkspace && (
              <span className="font-normal text-gray-600"> · {repository.workspaceName}</span>
            )}
          </span>
          <span>
            {reconcileErrorText(repository.lastReconcileError)} {repository.reconcileFailures}{" "}
            checks in a row failed
            {repository.lastReconciledAt !== null &&
              `; last tried ${formatInstant(repository.lastReconciledAt)}`}
            .
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Workspace deletions whose purge waits (decision 0015): why, and since when. */
export function PurgeBlockedList(props: {
  blocks: readonly PurgeBlocked[];
  /** On `/ops`: name each workspace, linked to its read-only Access page. */
  showWorkspace?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {props.blocks.map((block) => (
        <li
          key={block.workspaceId}
          aria-label={`Deletion of ${block.workspaceName} waits`}
          className="flex flex-col"
        >
          {props.showWorkspace && (
            <Link to={`/ops/w/${block.workspaceSlug}`} className="font-medium underline">
              {block.workspaceName}
            </Link>
          )}
          <span>
            Deletion waits: {purgeBlockText(block.reason)} Waiting since{" "}
            {formatInstant(block.since)}; last checked {formatInstant(block.checkedAt)}.
          </span>
        </li>
      ))}
    </ul>
  );
}
