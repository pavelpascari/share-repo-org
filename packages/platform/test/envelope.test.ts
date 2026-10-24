import { describe, expect, it } from "vitest";
import {
  CredentialEnvelopeError,
  type CredentialKeyring,
  createLogger,
  envelopeAad,
  openSecret,
  sealSecret,
} from "../src/index.ts";
import { captureConsole } from "./support/capture-console.ts";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const OLD: CredentialKeyring = { current: "k1", keys: { k1: key(1) } };
const ROTATED: CredentialKeyring = { current: "k2", keys: { k1: key(1), k2: key(2) } };
const SECRET = `pdl_sdbx_apikey_${crypto.randomUUID().replaceAll("-", "")}`;
const AAD = envelopeAad({ workspaceId: "ws_1", rowId: "pdc_1", purpose: "api_key" });

async function failure(promise: Promise<unknown>): Promise<CredentialEnvelopeError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CredentialEnvelopeError);
  return error as CredentialEnvelopeError;
}

function edit(envelope: string, change: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(envelope), ...change });
}

/** Flips one bit of a base64 field's decoded bytes. */
function flip(field: string): string {
  const bytes = Uint8Array.from(atob(field), (c) => c.charCodeAt(0));
  bytes[0] = (bytes[0] as number) ^ 1;
  return btoa(String.fromCharCode(...bytes));
}

describe("envelopeAad", () => {
  it("binds workspace, row and purpose", () => {
    expect(AAD).toBe("ws_1:pdc_1:api_key");
  });

  it.each([
    ["a colon", { workspaceId: "ws:1", rowId: "r" }],
    ["whitespace", { workspaceId: "ws", rowId: "r 1" }],
    ["an empty part", { workspaceId: "", rowId: "r" }],
  ])("refuses a part with %s", (_, parts) => {
    expect(() => envelopeAad({ ...parts, purpose: "email" })).toThrow(CredentialEnvelopeError);
  });
});

describe("sealSecret and openSecret", () => {
  it("round-trips under the current key with the format of decision 0011", async () => {
    const envelope = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
    const parsed = JSON.parse(envelope);
    expect(Object.keys(parsed).sort()).toEqual(["ct", "iv", "kid", "v", "wiv", "wk"]);
    expect(parsed).toMatchObject({ v: 1, kid: "k1" });
    expect(envelope).not.toContain(SECRET);
    expect(await openSecret({ keyring: OLD, envelope, aad: AAD })).toEqual({
      plaintext: SECRET,
      needsRewrap: false,
    });
  });

  it("uses a fresh data key and IVs for every seal", async () => {
    const a = JSON.parse(await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD }));
    const b = JSON.parse(await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD }));
    for (const field of ["iv", "ct", "wiv", "wk"]) expect(a[field]).not.toBe(b[field]);
  });

  it("round-trips an empty and a non-ASCII secret", async () => {
    for (const plaintext of ["", "ünïcødé ✓"]) {
      const envelope = await sealSecret({ keyring: OLD, plaintext, aad: AAD });
      expect((await openSecret({ keyring: OLD, envelope, aad: AAD })).plaintext).toBe(plaintext);
    }
  });

  describe("credential/envelope-bound-to-row", () => {
    it.each([
      ["another row", { workspaceId: "ws_1", rowId: "pdc_2", purpose: "api_key" }],
      ["another workspace", { workspaceId: "ws_2", rowId: "pdc_1", purpose: "api_key" }],
      ["another purpose", { workspaceId: "ws_1", rowId: "pdc_1", purpose: "webhook_secret" }],
    ] as const)(
      "credential/envelope-bound-to-row: a copy to %s does not open",
      async (_, other) => {
        const envelope = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
        const error = await failure(
          openSecret({ keyring: OLD, envelope, aad: envelopeAad(other) }),
        );
        expect(error.reason).toBe("decrypt_failed");
      },
    );

    it("credential/envelope-bound-to-row: rotation opens old envelopes and asks for a re-wrap", async () => {
      const old = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
      expect(await openSecret({ keyring: ROTATED, envelope: old, aad: AAD })).toEqual({
        plaintext: SECRET,
        needsRewrap: true,
      });
      const rewrapped = await sealSecret({ keyring: ROTATED, plaintext: SECRET, aad: AAD });
      expect(JSON.parse(rewrapped).kid).toBe("k2");
      expect(await openSecret({ keyring: ROTATED, envelope: rewrapped, aad: AAD })).toEqual({
        plaintext: SECRET,
        needsRewrap: false,
      });
      // Once k1 is retired, only the re-wrapped envelope opens.
      const retired: CredentialKeyring = { current: "k2", keys: { k2: key(2) } };
      expect(
        (await failure(openSecret({ keyring: retired, envelope: old, aad: AAD }))).reason,
      ).toBe("unknown_key");
      expect(
        (await openSecret({ keyring: retired, envelope: rewrapped, aad: AAD })).plaintext,
      ).toBe(SECRET);
    });

    it.each(["ct", "iv", "wk", "wiv"])(
      "credential/envelope-bound-to-row: a tampered %s fails",
      async (field) => {
        const envelope = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
        const tampered = edit(envelope, { [field]: flip(JSON.parse(envelope)[field]) });
        const error = await failure(openSecret({ keyring: OLD, envelope: tampered, aad: AAD }));
        expect(error.reason).toBe("decrypt_failed");
      },
    );

    it("credential/envelope-bound-to-row: relabelling the master key fails", async () => {
      const envelope = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
      const sameBytes: CredentialKeyring = { current: "k1", keys: { k1: key(1), k9: key(1) } };
      const relabelled = edit(envelope, { kid: "k9" });
      const error = await failure(
        openSecret({ keyring: sameBytes, envelope: relabelled, aad: AAD }),
      );
      expect(error.reason).toBe("decrypt_failed");
    });
  });

  it("fails with the wrong master key bytes", async () => {
    const envelope = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
    const wrong: CredentialKeyring = { current: "k1", keys: { k1: key(7) } };
    expect((await failure(openSecret({ keyring: wrong, envelope, aad: AAD }))).reason).toBe(
      "decrypt_failed",
    );
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["an unknown version", (e: string) => edit(e, { v: 2 })],
    ["an extra field", (e: string) => edit(e, { plaintext: "x" })],
    ["a bad key ID", (e: string) => edit(e, { kid: "k 1" })],
    ["non-base64 ciphertext", (e: string) => edit(e, { ct: "!!!!" })],
    ["a short IV", (e: string) => edit(e, { iv: btoa("short") })],
    ["a short wrap IV", (e: string) => edit(e, { wiv: btoa("short") })],
    ["a short wrapped key", (e: string) => edit(e, { wk: btoa("short") })],
    ["a ciphertext shorter than its tag", (e: string) => edit(e, { ct: btoa("short") })],
  ])("rejects %s as malformed", async (_, make) => {
    const sealed = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
    const envelope = typeof make === "string" ? make : make(sealed);
    expect((await failure(openSecret({ keyring: OLD, envelope, aad: AAD }))).reason).toBe(
      "malformed",
    );
  });

  it.each([
    ["a current key that is missing", { current: "k3", keys: { k1: key(1) } }],
    ["a current key of the wrong size", { current: "k1", keys: { k1: new Uint8Array(16) } }],
    ["a malformed current key ID", { current: "k 1", keys: { "k 1": key(1) } }],
  ])("refuses to seal with %s", async (_, keyring) => {
    const error = await failure(sealSecret({ keyring, plaintext: SECRET, aad: AAD }));
    expect(error.reason).toBe("invalid_input");
  });

  it("does not open with a keyring entry of the wrong size", async () => {
    const envelope = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
    const short: CredentialKeyring = { current: "k1", keys: { k1: new Uint8Array(16) } };
    expect((await failure(openSecret({ keyring: short, envelope, aad: AAD }))).reason).toBe(
      "unknown_key",
    );
  });

  it("does not consult inherited keyring properties", async () => {
    const envelope = edit(await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD }), {
      kid: "toString",
    });
    expect((await failure(openSecret({ keyring: OLD, envelope, aad: AAD }))).reason).toBe(
      "unknown_key",
    );
  });

  it("leaves the caller's keyring bytes intact", async () => {
    const keyring: CredentialKeyring = { current: "k1", keys: { k1: key(1) } };
    const envelope = await sealSecret({ keyring, plaintext: SECRET, aad: AAD });
    await openSecret({ keyring, envelope, aad: AAD });
    expect(keyring.keys.k1).toEqual(key(1));
  });

  it("audit/no-secrets-in-logs-or-audit: failures carry no secret material", async () => {
    const capture = captureConsole();
    try {
      const envelope = await sealSecret({ keyring: OLD, plaintext: SECRET, aad: AAD });
      const error = await failure(openSecret({ keyring: ROTATED, envelope, aad: "ws_9:x:email" }));
      createLogger({ correlationId: "req-00000001" }).error("open failed", {
        error,
        connection: { apiKeyEnvelope: envelope },
      });
      expect(error.message).toBe("Credential envelope failure: decrypt_failed");
      expect(error.cause).toBeUndefined();
      const ciphertext = JSON.parse(envelope).ct as string;
      for (const text of [error.message, String(error.stack), capture.text()]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(ciphertext);
      }
      expect(capture.text()).toContain("decrypt_failed");
    } finally {
      capture.restore();
    }
  });
});
