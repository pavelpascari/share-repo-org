import { systemClock } from "@sharerepo/domain";
import { createGitHubApp, type GitHubAppPort } from "@sharerepo/integrations";
import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "./context.ts";

/** The GitHub App for this request, or null when it is not configured (local development). */
export function githubFor(context: Readonly<RouterContextProvider>): GitHubAppPort | null {
  const config = context.get(cloudflareContext).env.github;
  if (config === null || config.slug === undefined) return null;
  return createGitHubApp({
    appId: config.appId,
    privateKeyPem: config.privateKeyPem,
    apiBaseUrl: config.apiBaseUrl,
    fetch: globalThis.fetch.bind(globalThis),
    clock: systemClock,
    install: { slug: config.slug, webBaseUrl: config.webBaseUrl },
  });
}
