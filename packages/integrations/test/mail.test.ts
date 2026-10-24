import { describe, expect, it } from "vitest";
import { createMailPort, MailError, type MailMessage } from "../src/index.ts";
import { createFakeMail } from "../src/testing/index.ts";
import { jsonResponse, stubFetch } from "./support/stub-fetch.ts";

const FROM = "claims@sharerepo.test";
const MESSAGE: MailMessage = {
  to: "jo@example.com",
  subject: "Claim your access",
  text: "Open https://sharerepo.test/claim/x",
  html: "<p>Open <a href='https://sharerepo.test/claim/x'>the link</a></p>",
};

async function failure(promise: Promise<unknown>): Promise<MailError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MailError);
  const mail = error as MailError;
  // Never the address, subject or body.
  expect(`${mail.message} ${mail.providerCode ?? ""}`).not.toMatch(/example\.com|Claim|claim\/x/);
  return mail;
}

const unusedFetch = (async () => {
  throw new Error("unused");
}) as typeof fetch;

describe("mail through the send_email binding", () => {
  it("sends the message from the configured sender", async () => {
    const sent: unknown[] = [];
    const port = createMailPort(
      { kind: "binding", binding: { send: async (message) => void sent.push(message) } },
      { from: FROM, fetch: unusedFetch },
    );
    await port.send(MESSAGE);
    expect(sent).toEqual([{ ...MESSAGE, from: FROM }]);
  });

  it.each([
    [
      Object.assign(new Error("bad"), { code: "E_RECIPIENT_NOT_ALLOWED" }),
      "rejected",
      "E_RECIPIENT_NOT_ALLOWED",
    ],
    [
      Object.assign(new Error("bad"), { code: "E_SENDER_UNVERIFIED" }),
      "rejected",
      "E_SENDER_UNVERIFIED",
    ],
    [Object.assign(new Error("busy"), { code: "E_INTERNAL" }), "transient", "E_INTERNAL"],
    [Object.assign(new Error("x"), { code: "jo@example.com is invalid" }), "transient", undefined],
    [new Error("no code"), "transient", undefined],
    [null, "transient", undefined],
  ])("classifies a thrown %s", async (thrown, kind, providerCode) => {
    const port = createMailPort(
      {
        kind: "binding",
        binding: {
          send: async () => {
            throw thrown;
          },
        },
      },
      { from: FROM, fetch: unusedFetch },
    );
    expect(await failure(port.send(MESSAGE))).toMatchObject({ kind, providerCode });
  });

  it.each([
    ["no recipient", { ...MESSAGE, to: "" }],
    ["two recipients", { ...MESSAGE, to: "a@x.test b@x.test" }],
    ["no subject", { ...MESSAGE, subject: "" }],
    ["no text", { ...MESSAGE, text: "" }],
    ["no html", { ...MESSAGE, html: "" }],
  ])("refuses a message with %s before sending", async (_, message) => {
    let sends = 0;
    const port = createMailPort(
      {
        kind: "binding",
        binding: {
          send: async () => {
            sends += 1;
          },
        },
      },
      { from: FROM, fetch: unusedFetch },
    );
    expect(await failure(port.send(message))).toMatchObject({ kind: "rejected" });
    expect(sends).toBe(0);
  });
});

describe("mail through the HTTP capture", () => {
  const CAPTURE = "http://localhost:5191/mail";

  it("posts the message as JSON", async () => {
    const stub = stubFetch([() => new Response(null, { status: 204 })]);
    const port = createMailPort(
      { kind: "capture", url: CAPTURE },
      { from: FROM, fetch: stub.fetch },
    );
    await port.send(MESSAGE);
    expect(stub.calls).toEqual([expect.objectContaining({ method: "POST", url: CAPTURE })]);
    expect(JSON.parse(stub.calls[0]?.body ?? "")).toEqual({ ...MESSAGE, from: FROM });
  });

  it.each([
    [400, "rejected"],
    [422, "rejected"],
    [429, "transient"],
    [500, "transient"],
  ] as const)("classifies status %i as %s", async (status, kind) => {
    const stub = stubFetch([() => jsonResponse(status, { error: "x" })]);
    const port = createMailPort(
      { kind: "capture", url: CAPTURE },
      { from: FROM, fetch: stub.fetch },
    );
    expect(await failure(port.send(MESSAGE))).toMatchObject({ kind, providerCode: String(status) });
  });

  it("is transient on a network failure", async () => {
    const port = createMailPort(
      { kind: "capture", url: CAPTURE },
      {
        from: FROM,
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      },
    );
    expect(await failure(port.send(MESSAGE))).toMatchObject({ kind: "transient" });
  });
});

describe("fake mail", () => {
  it("records messages per recipient and fails once on request", async () => {
    const mail = createFakeMail();
    await mail.send(MESSAGE);
    await mail.send({ ...MESSAGE, to: "sam@example.com" });
    expect(mail.inbox("jo@example.com")).toEqual([MESSAGE]);
    expect(mail.sent).toHaveLength(2);
    mail.failNext("rejected");
    expect(await failure(mail.send(MESSAGE))).toMatchObject({ kind: "rejected" });
    await mail.send(MESSAGE);
    expect(mail.sent).toHaveLength(3);
  });
});
