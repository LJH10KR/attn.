import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

if (!admin.apps.length) {
  admin.initializeApp();
}

const SHORT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

type ShortLinkPurpose = "owner_verify" | "teacher_verify" | "teacher_reset" | "parent_verify" | "parent_reset";

function getProjectId(): string {
  return process.env.GCLOUD_PROJECT?.trim() || "";
}

function getRegion(): string {
  return process.env.FUNCTION_REGION?.trim() || "asia-northeast3";
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

export function getAppOrigin(): string {
  const o = process.env.APP_ORIGIN?.trim();
  return o && o.length > 0 ? normalizeBaseUrl(o) : "http://127.0.0.1:3000";
}

function defaultShortLinkBaseUrl(): string {
  const explicit = process.env.SHORT_LINK_BASE_URL?.trim();
  if (explicit) return normalizeBaseUrl(explicit);
  const projectId = getProjectId();
  const region = getRegion();
  if (!projectId) {
    return `${getAppOrigin()}/v`;
  }
  return `https://${region}-${projectId}.cloudfunctions.net/openShortAuthLink`;
}

function randomShortCode(): string {
  // URL-safe 11 chars. 예: "a8Fk1mQ2zYb"
  return crypto.randomBytes(8).toString("base64url").slice(0, 11);
}

function toSafeUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:") {
    throw new Error("only https target allowed");
  }
  return u;
}

function hostAllowed(hostname: string): boolean {
  const projectId = getProjectId();
  const appHost = (() => {
    try {
      return new URL(getAppOrigin()).hostname;
    } catch {
      return "";
    }
  })();
  const set = new Set<string>([
    appHost,
    projectId ? `${projectId}.firebaseapp.com` : "",
    projectId ? `${projectId}.web.app` : "",
  ]);
  return set.has(hostname);
}

export async function createShortAuthLink(params: {
  targetUrl: string;
  purpose: ShortLinkPurpose;
  academyId?: string;
  uid?: string;
  email?: string;
  expiresAt?: Timestamp;
}): Promise<string> {
  const target = toSafeUrl(params.targetUrl);
  if (!hostAllowed(target.hostname)) {
    throw new Error(`target host not allowed: ${target.hostname}`);
  }

  const db = admin.firestore();
  let code = "";
  let created = false;
  for (let i = 0; i < 8 && !created; i++) {
    const candidate = randomShortCode();
    const ref = db.doc(`shortAuthLinks/${candidate}`);
    const existing = await ref.get();
    if (existing.exists) continue;
    const exp = params.expiresAt ?? Timestamp.fromMillis(Date.now() + SHORT_LINK_TTL_MS);
    await ref.set({
      purpose: params.purpose,
      targetUrl: target.toString(),
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: exp,
      clickCount: 0,
      academyId: params.academyId ?? null,
      uid: params.uid ?? null,
      email: params.email ?? null,
    });
    code = candidate;
    created = true;
  }
  if (!created || !code) {
    throw new Error("short code generation failed");
  }
  return `${defaultShortLinkBaseUrl()}/${code}`;
}

/**
 * 공개 단축 링크 리다이렉트.
 * /openShortAuthLink/<code> 형태로 접근해 긴 Firebase 액션 링크로 302 이동합니다.
 */
export const openShortAuthLink = onRequest({ cors: true }, async (req, res) => {
  try {
    const pathCode = req.path.replace(/^\/+/, "").trim();
    const queryCode = typeof req.query.code === "string" ? req.query.code.trim() : "";
    const code = (pathCode || queryCode).replace(/[^a-zA-Z0-9_-]/g, "");
    if (!code || code.length < 6 || code.length > 64) {
      res.status(400).send("Invalid link.");
      return;
    }

    const db = admin.firestore();
    const ref = db.doc(`shortAuthLinks/${code}`);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).send("Link not found.");
      return;
    }
    const data = snap.data() ?? {};
    const targetUrl = typeof data.targetUrl === "string" ? data.targetUrl : "";
    const expiresAt = data.expiresAt as Timestamp | undefined;
    if (!targetUrl) {
      res.status(410).send("Link expired.");
      return;
    }
    if (expiresAt && Date.now() > expiresAt.toMillis()) {
      res.status(410).send("Link expired.");
      return;
    }
    let target: URL;
    try {
      target = toSafeUrl(targetUrl);
    } catch {
      res.status(400).send("Invalid target.");
      return;
    }
    if (!hostAllowed(target.hostname)) {
      res.status(400).send("Invalid target.");
      return;
    }

    await ref.update({
      clickCount: FieldValue.increment(1),
      lastClickedAt: FieldValue.serverTimestamp(),
    });
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, target.toString());
  } catch (e) {
    logger.error("openShortAuthLink failed", e);
    res.status(500).send("Failed to open link.");
  }
});
