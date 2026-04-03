"use client";

import Link from "next/link";
import { useState } from "react";
import { IosPwaHintModal } from "@/components/parent/ios-pwa-hint-modal";
import { ParentPushNotificationsCard } from "@/components/parent/parent-push-notifications-card";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { doc, setDoc } from "firebase/firestore";
import { isLikelyIos, isStandaloneDisplayMode } from "@/lib/platform/ios-pwa";

const glassCard =
  "rounded-[1.75rem] border border-white/70 bg-[rgba(236,235,228,0.45)] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.14),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl backdrop-saturate-150";

export default function ParentSettingsPage() {
  const [iosModalOpen, setIosModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const openIosHint = () => {
    if (!isLikelyIos()) {
      setToast("iPhone·iPad Safari가 아닌 경우 이 안내는 필요하지 않을 수 있습니다.");
      return;
    }
    if (isStandaloneDisplayMode()) {
      setToast("이미 홈 화면 앱으로 실행 중입니다.");
      return;
    }
    setToast(null);
    setIosModalOpen(true);
  };

  return (
    <div className="min-h-[100dvh] bg-[#f2f1eb] px-4 pb-12 pt-8">
      <div className="mx-auto max-w-lg">
        <header className="mb-6">
          <Link
            href="/parent"
            className="text-[11px] font-medium text-sky-900 underline-offset-2 hover:underline"
          >
            ← 학부모 대시보드
          </Link>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-[#111]">사용자 설정</h1>
          <p className="mt-1 text-xs text-neutral-600">알림 및 기기 안내를 관리합니다.</p>
        </header>

        {toast ? (
          <p className="mb-4 rounded-xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-900">
            {toast}
          </p>
        ) : null}

        <div className="space-y-4">
          <ParentPushNotificationsCard />
          <section className={`p-4 ${glassCard}`}>
            <h2 className="text-sm font-semibold text-[#111]">iOS (Safari)</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
              푸시를 안정적으로 쓰려면 홈 화면에 추가한 뒤 해당 아이콘으로 여는 것이 좋습니다. 안내를
              다시 보려면 아래를 누르세요.
            </p>
            <button
              type="button"
              onClick={openIosHint}
              className="mt-3 w-full rounded-2xl border border-neutral-300/80 bg-white/70 py-2.5 text-sm font-medium text-neutral-800 hover:bg-white"
            >
              iOS 안내 다시 보기
            </button>
          </section>
        </div>

        <IosPwaHintModal
          open={iosModalOpen}
          onCloseAction={() => setIosModalOpen(false)}
          onConfirmAction={async (dontShowAgain) => {
            if (!dontShowAgain) return;
            const u = getFirebaseAuth().currentUser;
            if (!u) return;
            await setDoc(
              doc(getFirebaseDb(), "users", u.uid),
              { attn_hide_ios_pwa_hint: true },
              { merge: true },
            );
          }}
        />
      </div>
    </div>
  );
}
