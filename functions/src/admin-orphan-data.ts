import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { deleteAcademyCompletely } from "./lib/academy-delete";
import { accountStillInUse } from "./lib/account-use";
import { chunkArray, purgeUserFirestoreData } from "./lib/firestore-cleanup";

/**
 * 운영 잔여 데이터 점검·정리(2-N N10, ★9) — 관리자 전용. `mode: "scan"`은 보고만, `"purge"`는 ①③④⑤를 정리하고 다시 점검.
 * ① 학원 문서 없이 하위 문서만 남은 학원(예전 원장 삭제가 남긴 `o1_a1` 등) — `listDocuments`는 문서 없는 경로도 돌려줌
 * ② 원장 Auth가 없는 학원(보고만) ③ 가리키는 학원·계정 문서가 없는 로그인 색인 ④ 학원이 없는 가입 링크
 * ⑤ Auth가 없는 `users/{uid}`·`legalConsents/{uid}` ⑥ 어디에도 쓰이지 않는 Auth(admin 제외, 보고만)
 * ⑦ 끝나지 않은 학원 삭제 표시(`_academyDeletions`, 보고만 — 원장·관리자가 같은 삭제를 다시 부르면 이어서 끝남)
 * 개발 단계 규모(학원 수십 개)를 전제로 전체를 읽는다.
 */

type Report = {
  phantomAcademies: { academyId: string; collections: Record<string, number> }[];
  academiesWithoutOwnerAuth: { academyId: string; ownerUid: string }[];
  orphanLoginIndex: { key: string; academyId: string; role: string }[];
  orphanSignupLinks: { id: string; academyId: string }[];
  orphanUserDocs: string[];
  orphanConsents: string[];
  unusedAuthUsers: string[];
  pendingDeletions: string[];
};

async function missingAuthUids(uids: string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  for (const part of chunkArray([...new Set(uids)].filter((u) => u && !u.includes("/")), 100)) {
    const res = await admin.auth().getUsers(part.map((uid) => ({ uid })));
    for (const nf of res.notFound) {
      if ("uid" in nf) missing.add(nf.uid);
    }
  }
  return missing;
}

async function scan(db: admin.firestore.Firestore, includeAuthUsers: boolean): Promise<Report> {
  // ① ② — 학원 경로(문서 없는 것 포함)
  const academyRefs = await db.collection("academies").listDocuments();
  const existing = new Map<string, admin.firestore.DocumentSnapshot>();
  const phantomIds: string[] = [];
  for (const part of chunkArray(academyRefs, 100)) {
    for (const s of await db.getAll(...part)) {
      if (s.exists) existing.set(s.id, s);
      else phantomIds.push(s.id);
    }
  }
  const phantomAcademies: Report["phantomAcademies"] = [];
  for (const academyId of phantomIds) {
    const collections: Record<string, number> = {};
    for (const col of await db.doc(`academies/${academyId}`).listCollections()) {
      collections[col.id] = (await col.count().get()).data().count;
    }
    phantomAcademies.push({ academyId, collections });
  }
  const ownerUids = [...existing.values()].map((s) => s.get("ownerUid")).filter((u): u is string => typeof u === "string");
  const missingOwners = await missingAuthUids(ownerUids);
  const academiesWithoutOwnerAuth = [...existing.values()]
    .filter((s) => missingOwners.has(s.get("ownerUid")) || typeof s.get("ownerUid") !== "string")
    .map((s) => ({ academyId: s.id, ownerUid: typeof s.get("ownerUid") === "string" ? (s.get("ownerUid") as string) : "" }));

  // ③ 로그인 색인
  const indexSnap = await db.collection("attnLoginIndex").get();
  const orphanLoginIndex: Report["orphanLoginIndex"] = [];
  const memberRefs = indexSnap.docs.map((d) => {
    const academyId = d.get("academyId");
    const authUid = d.get("authUid");
    const col = d.get("role") === "parent" ? "parents" : d.get("role") === "teacher" ? "staff" : null;
    const ok = typeof academyId === "string" && academyId && !academyId.includes("/") &&
      typeof authUid === "string" && authUid && !authUid.includes("/") && col;
    return { d, ref: ok ? db.doc(`academies/${academyId}/${col}/${authUid}`) : null };
  });
  for (const part of chunkArray(memberRefs, 100)) {
    const refs = part.flatMap((m) => (m.ref ? [m.ref] : []));
    const snaps = refs.length > 0 ? await db.getAll(...refs) : [];
    const exists = new Set(snaps.filter((s) => s.exists).map((s) => s.ref.path));
    for (const m of part) {
      const academyId = String(m.d.get("academyId") ?? "");
      if (!m.ref || !existing.has(academyId) || !exists.has(m.ref.path)) {
        orphanLoginIndex.push({ key: m.d.id, academyId, role: String(m.d.get("role") ?? "") });
      }
    }
  }

  // ④ 가입 링크
  const linkSnap = await db.collection("signupLinks").get();
  const orphanSignupLinks = linkSnap.docs
    .filter((d) => !existing.has(String(d.get("academyId") ?? "")))
    .map((d) => ({ id: d.id, academyId: String(d.get("academyId") ?? "") }));

  // ⑤ 사용자 문서·동의 기록(문서 없이 하위만 남은 users 경로 포함)
  const userRefs = await db.collection("users").listDocuments();
  const missingUsers = await missingAuthUids(userRefs.map((r) => r.id).filter((id) => !id.startsWith("academy_")));
  const consentSnap = await db.collection("legalConsents").get();
  const missingConsents = await missingAuthUids(consentSnap.docs.map((d) => d.id));

  // ⑥ 쓰이지 않는 Auth
  const unusedAuthUsers: string[] = [];
  if (includeAuthUsers) {
    let pageToken: string | undefined;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      for (const u of page.users) {
        if ((u.customClaims as Record<string, unknown> | undefined)?.admin === true) continue;
        if (!(await accountStillInUse(db, u.uid))) unusedAuthUsers.push(u.uid);
      }
      pageToken = page.pageToken;
    } while (pageToken);
  }

  // ⑦
  const pending = await db.collection("_academyDeletions").get();

  return {
    phantomAcademies,
    academiesWithoutOwnerAuth,
    orphanLoginIndex,
    orphanSignupLinks,
    orphanUserDocs: [...missingUsers],
    orphanConsents: [...missingConsents],
    unusedAuthUsers,
    pendingDeletions: pending.docs.map((d) => d.id),
  };
}

export const adminOrphanData = onCall({ timeoutSeconds: 540 }, async (request) => {
  if (request.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "관리자만 실행할 수 있습니다.");
  }
  const mode = request.data?.mode === "purge" ? "purge" : "scan";
  const db = admin.firestore();
  const before = await scan(db, mode === "scan");
  if (mode === "scan") {
    logger.info("adminOrphanData scan", { phantom: before.phantomAcademies.length });
    return { ok: true as const, mode, report: before };
  }

  // 정리 — 학원 경로부터(그 학원 멤버 색인·계정까지 같은 규칙으로), 원장 계정은 건드리지 않음(②⑥은 보고만)
  for (const p of before.phantomAcademies) {
    await deleteAcademyCompletely(db, p.academyId, {
      ownerAccount: "keep",
      context: "adminOrphanData",
      requestedBy: request.auth.uid,
    });
  }
  const mid = await scan(db, false);
  for (const part of chunkArray(mid.orphanLoginIndex, 400)) {
    const batch = db.batch();
    for (const x of part) batch.delete(db.doc(`attnLoginIndex/${x.key}`));
    await batch.commit();
  }
  for (const part of chunkArray(mid.orphanSignupLinks, 400)) {
    const batch = db.batch();
    for (const x of part) batch.delete(db.doc(`signupLinks/${x.id}`));
    await batch.commit();
  }
  for (const uid of new Set([...mid.orphanUserDocs, ...mid.orphanConsents])) {
    await purgeUserFirestoreData(db, uid);
  }
  const after = await scan(db, true);
  logger.info("adminOrphanData purge", {
    phantom: before.phantomAcademies.length,
    loginIndex: mid.orphanLoginIndex.length,
    signupLinks: mid.orphanSignupLinks.length,
    users: mid.orphanUserDocs.length,
  });
  return { ok: true as const, mode, before, report: after };
});
