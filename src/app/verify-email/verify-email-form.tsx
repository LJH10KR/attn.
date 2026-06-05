"use client";

import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EmailVerificationCodeModal } from "@/components/auth/email-verification-code-modal";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { upsertOwnerProfile } from "@/lib/firebase/owner-profile";

export function VerifyEmailForm() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [otpOpen, setOtpOpen] = useState(false);

  const configured = isFirebaseConfigured();

  useEffect(() => {
    if (!configured) return;
    const auth = getFirebaseAuth();
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u && !u.emailVerified) {
        setOtpOpen(true);
      }
    });
    return () => unsub();
  }, [configured]);

  const onVerified = useCallback(async () => {
    const auth = getFirebaseAuth();
    const fresh = auth.currentUser;
    if (!fresh) {
      router.replace("/login/owner");
      return;
    }
    await fresh.reload();
    if (!fresh.emailVerified) {
      throw new Error("인증이 완료되지 않았습니다.");
    }
    await upsertOwnerProfile(fresh);
    router.replace("/owner");
  }, [router]);

  if (!configured) {
    return (
      <p className="text-sm text-neutral-600">
        Firebase 설정이 필요합니다.
      </p>
    );
  }

  if (!user) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-neutral-600">로그인이 필요합니다.</p>
        <Link href="/login/owner" className="text-sm text-[#4a90e2] underline">
          오너 로그인
        </Link>
      </div>
    );
  }

  if (user.emailVerified) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-emerald-800">이메일 인증이 완료되었습니다.</p>
        <Link href="/owner" className="text-sm text-[#4a90e2] underline">
          오너 대시보드로 이동
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4 text-center">
        <p className="text-sm text-neutral-600">
          이메일로 받은 6자리 인증 코드를 입력해 주세요.
        </p>
        <button
          type="button"
          onClick={() => setOtpOpen(true)}
          className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
        >
          인증 코드 입력
        </button>
        <button
          type="button"
          onClick={() => void signOut(getFirebaseAuth()).then(() => router.replace("/login/owner"))}
          className="text-sm text-neutral-500 underline"
        >
          로그인 화면으로
        </button>
      </div>
      <EmailVerificationCodeModal
        open={otpOpen}
        purpose="owner"
        emailHint={user.email}
        onVerifiedAction={onVerified}
        onCloseAction={() => setOtpOpen(false)}
      />
    </>
  );
}
