import * as crypto from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";

const PIN_PATTERN = /^\d{4}$/;

export function assertFourDigitPin(raw: unknown, label = "PIN"): string {
  const pin = typeof raw === "string" ? raw.trim() : "";
  if (!PIN_PATTERN.test(pin)) {
    throw new HttpsError("invalid-argument", `${label}은(는) 숫자 4자리여야 합니다.`);
  }
  return pin;
}

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(pin, salt, 120_000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPin(pin: string, stored: string | undefined | null): boolean {
  if (!stored || typeof stored !== "string") return false;
  const idx = stored.indexOf(":");
  if (idx <= 0) return false;
  const salt = stored.slice(0, idx);
  const expected = stored.slice(idx + 1);
  const actual = crypto.pbkdf2Sync(pin, salt, 120_000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
