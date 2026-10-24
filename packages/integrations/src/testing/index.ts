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
export { createFakeMail, type FakeMail } from "./fake-mail.ts";
export {
  addBillingCycle,
  createFakePaddle,
  FAKE_PADDLE_PERMISSIONS,
  type FakeEventInput,
  type FakePaddle,
  type FakePaddleDelivery,
  type FakePaddleMutation,
  type FakePaddleOperation,
  type FakePaddleOptions,
  type FakePriceInput,
  type FakeSubscriptionInput,
  type FakeTransaction,
} from "./fake-paddle.ts";
export { signPaddleWebhook } from "./sign-paddle-webhook.ts";
export { signWebhook } from "./sign-webhook.ts";
