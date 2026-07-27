"use client";

import { FirebaseError } from "firebase/app";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";
import {
  academyTuitionSettingsPath,
  type AcademyTuitionSettingsDoc,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`shrink-0 text-neutral-400 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    >
      <path
        d="M9 18l6-6-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OwnerTuitionSettingsCard({
  academyId,
  academyName,
  disabled,
  defaultCollapsed,
}: {
  academyId: string;
  academyName: string;
  disabled?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const [kakaoPayLink, setKakaoPayLink] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const db = getFirebaseDb();
    const ref = doc(db, academyTuitionSettingsPath(academyId));
    return onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const d = snap.data() as AcademyTuitionSettingsDoc;
          setKakaoPayLink(d.kakaoPayLink ?? "");
          setBankName(d.bankName ?? "");
          setAccountNumber(d.accountNumber ?? "");
          setAccountHolder(d.accountHolder ?? "");
        }
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, [academyId]);

  const clearSaved = () => setSaved(false);

  const onSave = useCallback(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const db = getFirebaseDb();
      await setDoc(
        doc(db, academyTuitionSettingsPath(academyId)),
        {
          kakaoPayLink: kakaoPayLink.trim(),
          bankName: bankName.trim(),
          accountNumber: accountNumber.trim(),
          accountHolder: accountHolder.trim(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [academyId, kakaoPayLink, bankName, accountNumber, accountHolder]);

  const formDisabled = disabled || busy || !loaded;

  return (
    <section className="glass-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3.5 text-left"
      >
        <span className="text-sm font-semibold text-foreground">
          원비 납부 안내{academyName ? ` — ${academyName}` : ""}
        </span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
      <div className="border-t border-black/[0.06] px-4 pb-4 pt-3 dark:border-white/10 space-y-4">
      <p className="text-[11px] leading-relaxed text-neutral-600">
        학부모에게 발송되는 원비 납부 알림에 포함될 카카오페이 링크와 계좌 정보를
        입력합니다. 비워 두면 해당 항목은 알림에서 생략됩니다.
      </p>

      <div className="space-y-3">
        <div>
          <label
            className="mb-1 block text-xs font-medium text-neutral-600"
            htmlFor={`kakaopay-${academyId}`}
          >
            카카오페이 송금 링크
          </label>
          <input
            id={`kakaopay-${academyId}`}
            type="url"
            value={kakaoPayLink}
            onChange={(e) => {
              clearSaved();
              setKakaoPayLink(e.target.value);
            }}
            placeholder="https://qr.kakaopay.com/..."
            className={inputClass}
            disabled={formDisabled}
            autoComplete="off"
          />
        </div>

        <div>
          <label
            className="mb-1 block text-xs font-medium text-neutral-600"
            htmlFor={`bank-name-${academyId}`}
          >
            은행명
          </label>
          <input
            id={`bank-name-${academyId}`}
            type="text"
            value={bankName}
            onChange={(e) => {
              clearSaved();
              setBankName(e.target.value);
            }}
            placeholder="예: 카카오뱅크"
            className={inputClass}
            disabled={formDisabled}
            autoComplete="off"
          />
        </div>

        <div>
          <label
            className="mb-1 block text-xs font-medium text-neutral-600"
            htmlFor={`account-num-${academyId}`}
          >
            계좌번호
          </label>
          <input
            id={`account-num-${academyId}`}
            type="text"
            value={accountNumber}
            onChange={(e) => {
              clearSaved();
              setAccountNumber(e.target.value);
            }}
            placeholder="예: 3333-01-1234567"
            className={inputClass}
            disabled={formDisabled}
            autoComplete="off"
          />
        </div>

        <div>
          <label
            className="mb-1 block text-xs font-medium text-neutral-600"
            htmlFor={`account-holder-${academyId}`}
          >
            예금주
          </label>
          <input
            id={`account-holder-${academyId}`}
            type="text"
            value={accountHolder}
            onChange={(e) => {
              clearSaved();
              setAccountHolder(e.target.value);
            }}
            placeholder="예: 홍길동"
            className={inputClass}
            disabled={formDisabled}
            autoComplete="off"
          />
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-emerald-800">납부 안내 정보가 저장되었습니다.</p>
      ) : null}

      <button
        type="button"
        disabled={formDisabled}
        onClick={() => void onSave()}
        className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
      >
        {busy ? "저장 중…" : "저장"}
      </button>
      </div>
      ) : null}
    </section>
  );
}
