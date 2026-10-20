import { NextRequest, NextResponse } from "next/server";
import { PaymentClient } from "@portone/server-sdk";
import { completePayment, type PaymentType } from "@/lib/payment/complete-payment";

export const runtime = "nodejs";

type VerifyRequestBody = {
  paymentId?: unknown;
  studentId?: unknown;
  academyId?: unknown;
  paymentType?: unknown;
  sessionCount?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function POST(request: NextRequest) {
  let body: VerifyRequestBody;
  try {
    body = (await request.json()) as VerifyRequestBody;
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }

  const { paymentId, studentId, academyId } = body;
  if (
    !isNonEmptyString(paymentId) ||
    !isNonEmptyString(studentId) ||
    !isNonEmptyString(academyId)
  ) {
    return NextResponse.json(
      { error: "paymentId, studentId, academyId가 필요합니다." },
      { status: 400 },
    );
  }

  // 미지정 시(기존 원비 결제 UI) monthly_fixed로 취급 — 하위 호환
  const paymentType: PaymentType =
    body.paymentType === "session_based" ? "session_based" : "monthly_fixed";
  const sessionCount = typeof body.sessionCount === "number" ? body.sessionCount : null;

  const apiSecret = process.env.PORTONE_API_SECRET;
  if (!apiSecret) {
    console.error("[payment/verify] PORTONE_API_SECRET 환경변수가 설정되지 않았습니다.");
    return NextResponse.json({ error: "결제 서버 설정 오류입니다." }, { status: 500 });
  }

  const portone = PaymentClient({ secret: apiSecret });
  const result = await completePayment(portone, {
    paymentId,
    studentId,
    academyId,
    paymentType,
    sessionCount,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true, status: "PAID" });
}
