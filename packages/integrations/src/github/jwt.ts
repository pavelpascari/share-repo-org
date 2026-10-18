import type { Clock } from "@sharerepo/domain";

// GitHub App authentication: an RS256 JWT signed with the App's private key, valid for at most
// 10 minutes. `iat` is backdated 60 seconds to tolerate clock drift, as GitHub recommends.
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const BACKDATE_SECONDS = 60;
const LIFETIME_SECONDS = 9 * 60;

export function importPrivateKey(pkcs8Pem: string): Promise<CryptoKey> {
  const body = pkcs8Pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  return crypto.subtle.importKey("pkcs8", base64ToBytes(body), ALGORITHM, false, ["sign"]);
}

export async function signAppJwt(key: CryptoKey, appId: string, clock: Clock): Promise<string> {
  const now = Math.floor(clock.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - BACKDATE_SECONDS, exp: now + LIFETIME_SECONDS, iss: Number(appId) };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
