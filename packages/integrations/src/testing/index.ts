// Test doubles for other packages' tests (`@sharerepo/integrations/testing`). Never import from
// production code.
export {
  createFakeGitHubApp,
  FAKE_INSTALL_BASE,
  type FakeGitHubApp,
  type FakeGitHubAppOptions,
  type FakeGitHubOperation,
  type FakeInstallationInput,
  type FakeRepositoryAccess,
} from "./fake-github-app.ts";
export { signWebhook } from "./sign-webhook.ts";
