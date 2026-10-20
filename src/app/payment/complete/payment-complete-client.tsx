"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isStandaloneDisplayMode } from "@/lib/platform/ios-pwa";

/**
 * PWA(홈스크린 standalone)와 일반 브라우저(Safari/Chrome)는 완전히 격리된 컨텍스트라
 * localStorage/BroadcastChannel로 서로 신호를 주고받을 수 없다(특히 iOS: PWA는 WKWebView,
 * 브라우저는 Safari — 스토리지 파티션 자체가 다름). PWA는 나이스 리다이렉트를 자체적으로
 * 받아 이 페이지로 이동하므로 그 안에서 바로 /parent로 돌아가면 되고, 시스템 브라우저에서
 * 열린 경우(주로 iOS)에는 이 탭이 곧 닫혀야 하므로 결과만 localStorage에 남기고(Android
 * 등 스토리지를 공유하는 환경을 위한 best-effort) 탭을 닫아본다.
 *
 * 결제 완결 자체(서버 사이드 completePayment 호출)는 이 컴포넌트가 아니라 부모 서버
 * 컴포넌트(page.tsx)가 HTML을 응답하기 전에 이미 끝마친 상태다 — 브라우저가 이 페이지에
 * 진입한 것(HTTP 요청이 서버에 도달한 것) 자체가 트리거이므로, 이 클라이언트 컴포넌트가
 * 마운트되기도 전에(심지어 이 탭이 그 직후 종료되더라도) 완결 처리가 보장된다.
 */
const PAYMENT_RESULT_STORAGE_KEY = "attn_payment_result";

export type PaymentCompleteStatus = "success" | "fail";

function saveResult(status: PaymentCompleteStatus, paymentType: string) {
  try {
    localStorage.setItem(
      PAYMENT_RESULT_STORAGE_KEY,
      JSON.stringify({
        status,
        ...(status === "success" ? { paymentType } : {}),
        timestamp: Date.now(),
      }),
    );
  } catch {
    /* 프라이빗 모드 등 localStorage 접근 불가 — 무시 */
  }
}

function tryCloseWindow() {
  try {
    window.close();
  } catch {
    /* 스크립트로 열지 않은 탭은 닫기가 거부될 수 있음 — 실패해도 무방 */
  }
}

function StatusGlyph({ tone }: { tone: "success" | "error" }) {
  const isSuccess = tone === "success";
  return (
    <div
      className={`mx-auto flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold ${
        isSuccess
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
          : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
      }`}
      aria-hidden
    >
      {isSuccess ? "✓" : "✕"}
    </div>
  );
}

export function PaymentCompleteClient({
  status,
  paymentType,
}: {
  status: PaymentCompleteStatus;
  paymentType: string;
}) {
  const router = useRouter();
  const [isPwa, setIsPwa] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const pwa = isStandaloneDisplayMode();
    setIsPwa(pwa);

    if (pwa) {
      window.setTimeout(() => router.push("/parent"), 2000);
    } else {
      saveResult(status, paymentType);
      window.setTimeout(() => tryCloseWindow(), 1500);
    }
  }, [status, paymentType, router]);

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-12 flex flex-col items-center justify-center">
      <div className="glass-card-soft w-full max-w-md p-8 text-center space-y-4">
        {status === "success" ? (
          <>
            <StatusGlyph tone="success" />
            <p className="text-sm text-foreground">
              {isPwa ? "결제가 완료됐습니다." : "결제가 완료됐습니다. attn. 앱으로 돌아가세요."}
            </p>
          </>
        ) : (
          <>
            <StatusGlyph tone="error" />
            <p className="text-sm text-foreground">
              {isPwa ? "결제가 취소됐습니다." : "결제에 실패했습니다. attn. 앱으로 돌아가세요."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
