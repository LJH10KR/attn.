import { PaymentClient } from "@portone/server-sdk";
import { redirect } from "next/navigation";
import { completePayment, type PaymentType } from "@/lib/payment/complete-payment";
import { PaymentCompleteClient } from "./payment-complete-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 포트원이 REDIRECTION 완료 후 이동시키는 페이지. 브라우저가 이 경로로 진입한 시점(=이 서버
 * 컴포넌트가 실행되는 시점) 자체를 결제 완결 트리거로 쓴다 — 클라이언트 JS가 로드·실행되기도
 * 전에 서버에서 먼저 완결하므로, 이후 탭이 바로 종료돼도 처리 결과에 영향이 없다.
 */
export default async function PaymentCompletePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const paymentId = first(params.paymentId);
  const code = first(params.code);
  const studentId = first(params.studentId);
  const academyId = first(params.academyId);
  const paymentTypeRaw = first(params.paymentType);
  const sessionCountRaw = first(params.sessionCount);
  const invoicePeriod = first(params.invoicePeriod) ?? null;

  if (!paymentId) {
    redirect("/parent");
  }

  const paymentType: PaymentType =
    paymentTypeRaw === "session_based" ? "session_based" : "monthly_fixed";

  if (code) {
    // 은행 앱/결제창에서 사용자가 취소했거나 실패 — completePayment를 호출할 것도 없음
    return <PaymentCompleteClient status="fail" paymentType={paymentType} />;
  }

  const sessionCount =
    sessionCountRaw != null && sessionCountRaw.trim() !== "" ? Number(sessionCountRaw) : null;

  const apiSecret = process.env.PORTONE_API_SECRET;
  if (!apiSecret || !studentId || !academyId) {
    console.error("[payment/complete] 필수 파라미터 또는 PORTONE_API_SECRET 누락");
    return <PaymentCompleteClient status="fail" paymentType={paymentType} />;
  }

  let status: "success" | "fail" = "fail";
  try {
    const portone = PaymentClient({ secret: apiSecret });
    const result = await completePayment(portone, {
      paymentId,
      studentId,
      academyId,
      paymentType,
      sessionCount,
      invoicePeriod,
    });
    if (result.ok) {
      status = "success";
    } else {
      console.error(`[payment/complete] 서버 사이드 결제 완결 실패: ${result.error}`);
    }
  } catch (err) {
    console.error("[payment/complete] 서버 사이드 결제 완결 중 예외", err);
  }

  return <PaymentCompleteClient status={status} paymentType={paymentType} />;
}
