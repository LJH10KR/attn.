import { NextRequest, NextResponse } from "next/server";
import { PaymentClient } from "@portone/server-sdk";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { academyPaymentPath, COLLECTIONS } from "@/lib/firebase/attn-schema";
import { reopenInvoiceForCancelledPayment } from "@/lib/payment/complete-payment";
import { normalizePermissionList, type AcademyPermission } from "@/lib/academy/permissions";

export const runtime = "nodejs";

type CancelRequestBody = {
  paymentId?: unknown;
  academyId?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** functions/src/lib/academy-access.ts의 assertPermission() 판별과 동일 */
async function hasAcademyPermission(
  academyId: string,
  uid: string,
  claimRole: unknown,
  claimAcademyId: unknown,
  permission: AcademyPermission,
): Promise<boolean> {
  if (claimRole === "academy" && claimAcademyId === academyId) {
    return true;
  }
  const academySnap = await adminDb.doc(`${COLLECTIONS.academies}/${academyId}`).get();
  if (!academySnap.exists) return false;
  if (academySnap.get("ownerUid") === uid) return true;
  const staffSnap = await adminDb
    .doc(`${COLLECTIONS.academies}/${academyId}/teachers/${uid}`)
    .get();
  return (
    staffSnap.exists &&
    staffSnap.get("status") === "active" &&
    normalizePermissionList(staffSnap.get("permissions")).includes(permission)
  );
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) {
    return NextResponse.json({ error: "인증 토큰이 필요합니다." }, { status: 401 });
  }

  let body: CancelRequestBody;
  try {
    body = (await request.json()) as CancelRequestBody;
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }

  const { paymentId, academyId } = body;
  if (!isNonEmptyString(paymentId) || !isNonEmptyString(academyId)) {
    return NextResponse.json(
      { error: "paymentId, academyId가 필요합니다." },
      { status: 400 },
    );
  }

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(idToken);
  } catch {
    return NextResponse.json({ error: "인증 토큰이 유효하지 않습니다." }, { status: 401 });
  }

  const allowed = await hasAcademyPermission(
    academyId,
    decoded.uid,
    decoded.role,
    decoded.academyId,
    "billing.payments",
  );
  if (!allowed) {
    return NextResponse.json({ error: "이 학원을 관리할 권한이 없습니다." }, { status: 403 });
  }

  const apiSecret = process.env.PORTONE_API_SECRET;
  if (!apiSecret) {
    console.error("[payment/cancel] PORTONE_API_SECRET 환경변수가 설정되지 않았습니다.");
    return NextResponse.json({ error: "결제 서버 설정 오류입니다." }, { status: 500 });
  }

  const paymentRef = adminDb.doc(academyPaymentPath(academyId, paymentId));
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) {
    return NextResponse.json({ error: "결제 내역을 찾을 수 없습니다." }, { status: 404 });
  }

  const payment = paymentSnap.data() ?? {};
  if (payment.status !== "PAID") {
    return NextResponse.json(
      { error: "납부완료 상태인 결제만 취소할 수 있습니다." },
      { status: 400 },
    );
  }

  const portone = PaymentClient({ secret: apiSecret });
  try {
    await portone.cancelPayment({
      paymentId,
      reason: "학원 관리자에 의한 결제 취소",
    });
  } catch (err) {
    console.error("[payment/cancel] 포트원 결제 취소 실패", err);
    return NextResponse.json({ error: "결제 취소에 실패했습니다." }, { status: 502 });
  }

  // 웹훅으로도 상태가 갱신되지만, 즉시 UI 반영을 위해 여기서도 직접 업데이트
  await paymentRef.update({
    status: "CANCELLED",
    cancelledAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // 월 원비 결제였다면 해당 청구서를 미납으로 되돌림(웹훅에서도 처리되지만 즉시 반영)
  await reopenInvoiceForCancelledPayment(academyId, payment);

  return NextResponse.json({ ok: true, status: "CANCELLED" });
}
