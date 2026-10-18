/** A fresh RSA key pair and its private key as a PKCS#8 PEM, as the runbook produces. */
export async function generateAppKey() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { publicKey: pair.publicKey, pem };
}

let shared: Promise<Awaited<ReturnType<typeof generateAppKey>>> | undefined;

/** One key per test file: generating RSA keys is slow. */
export function appKey() {
  shared ??= generateAppKey();
  return shared;
}
