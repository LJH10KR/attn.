import * as admin from "firebase-admin";

/**
 * 한 로그인 계정(Auth uid)이 어디에 쓰이고 있는지(2-N) — 학원 삭제·학원이 지우는 계정·활성 미러 트리거가
 * "이 계정을 지워도 되는지" 판단할 때 함께 쓴다.
 * 쓰임 = 학원 직원 문서·학부모 문서(authUid, 컬렉션 그룹) · 소유 학원 · 원장 계정 표시(`users/{uid}.platformRole == "owner"`).
 * 원장 표시는 학원을 모두 지운 원장(2-N ★3 — 학원 삭제 뒤에도 원장 계정 유지)을 지키려고 넣었다.
 */

export type MembershipDoc = admin.firestore.QueryDocumentSnapshot;

const MEMBERSHIP_SCAN_LIMIT = 50;

export async function accountMemberships(
  db: admin.firestore.Firestore,
  uid: string,
): Promise<{ staff: MembershipDoc[]; parents: MembershipDoc[] }> {
  const [staff, parents] = await Promise.all([
    db.collectionGroup("staff").where("authUid", "==", uid).limit(MEMBERSHIP_SCAN_LIMIT).get(),
    db.collectionGroup("parents").where("authUid", "==", uid).limit(MEMBERSHIP_SCAN_LIMIT).get(),
  ]);
  return {
    staff: staff.docs.filter((d) => academyIdOfMemberPath(d.ref.path, "staff") !== null),
    parents: parents.docs.filter((d) => academyIdOfMemberPath(d.ref.path, "parents") !== null),
  };
}

export function academyIdOfMemberPath(path: string, col: "staff" | "parents"): string | null {
  const m = path.match(new RegExp(`^academies/([^/]+)/${col}/[^/]+$`));
  return m ? m[1]! : null;
}

export async function ownedAcademyIds(db: admin.firestore.Firestore, uid: string, limit = 50): Promise<string[]> {
  const snap = await db.collection("academies").where("ownerUid", "==", uid).limit(limit).get();
  return snap.docs.map((d) => d.id);
}

export async function hasOwnerRole(db: admin.firestore.Firestore, uid: string): Promise<boolean> {
  return (await db.doc(`users/${uid}`).get()).get("platformRole") === "owner";
}

/**
 * 이 계정이 아직 쓰이는지 — 직원·학부모 소속, 소유 학원, (옵션) 원장 표시.
 * `ignoreOwnerRole`: 관리자·seed가 원장의 마지막 학원을 지울 때 원장 본인 판단(원장 표시는 보지 않음).
 */
export async function accountStillInUse(
  db: admin.firestore.Firestore,
  uid: string,
  opts: { ignoreOwnerRole?: boolean } = {},
): Promise<boolean> {
  const [staff, parents, owned, ownerRole] = await Promise.all([
    db.collectionGroup("staff").where("authUid", "==", uid).limit(1).get(),
    db.collectionGroup("parents").where("authUid", "==", uid).limit(1).get(),
    db.collection("academies").where("ownerUid", "==", uid).limit(1).get(),
    opts.ignoreOwnerRole ? Promise.resolve(false) : hasOwnerRole(db, uid),
  ]);
  return !staff.empty || !parents.empty || !owned.empty || ownerRole;
}
