import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

export async function assertCanManageAcademy(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  token: admin.auth.DecodedIdToken,
): Promise<void> {
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  const ownerUid = academySnap.get("ownerUid");
  if (typeof ownerUid === "string" && ownerUid === uid) {
    return;
  }
  if (token.role === "academy" && token.academyId === academyId) {
    return;
  }
  throw new HttpsError("permission-denied", "학원을 관리할 권한이 없습니다.");
}
