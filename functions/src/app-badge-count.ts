import * as admin from "firebase-admin";

/** `users/{userId}/dashboardBellItems` 문서 수 — PWA 앱 아이콘 배지용 */
export async function countUserDashboardBellItems(
  db: admin.firestore.Firestore,
  userId: string,
): Promise<number> {
  const snap = await db
    .collection(`users/${userId}/dashboardBellItems`)
    .count()
    .get();
  return snap.data().count;
}
