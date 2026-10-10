import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export function normalizePassphrase(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[-\s]+/g, " ")
    .toLowerCase();
}
export async function createCredential(passphrase: string) {
  const salt = randomBytes(16).toString("hex");
  const digest = (await derive(
    normalizePassphrase(passphrase),
    salt,
    64,
  )) as Buffer;
  return {
    salt,
    digest: digest.toString("hex"),
    algorithm: "scrypt-v1" as const,
  };
}
export async function verifyCredential(
  passphrase: string,
  record: { salt?: unknown; digest?: unknown; algorithm?: unknown },
) {
  if (
    record.algorithm !== "scrypt-v1" ||
    typeof record.salt !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.salt) ||
    typeof record.digest !== "string" ||
    !/^[a-f0-9]{128}$/.test(record.digest)
  )
    return false;
  const actual = (await derive(
    normalizePassphrase(passphrase),
    record.salt,
    64,
  )) as Buffer;
  return timingSafeEqual(actual, Buffer.from(record.digest, "hex"));
}
