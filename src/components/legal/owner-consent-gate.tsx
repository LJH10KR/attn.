"use client";

import { onAuthStateChanged } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import {
  ConsentChecklist,
  CONSENT_REQUIRED_MESSAGE,
  consentComplete,
  EMPTY_CONSENT,
  type ConsentState,
} from "@/components/legal/consent-checklist";
import { ModalPortal } from "@/components/ui/modal-portal";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { currentConsentPayload, LEGAL_DOC_VERSIONS } from "@/lib/legal/legal-docs";

/** 이 페이지 로드에서 지금 버전 동의를 확인한 원장(학원 화면 사이 이동마다 다시 묻지 않게) */
const confirmedKeys = new Set<string>();

function confirmKey(uid: string): string {
  return `${uid}|${LEGAL_DOC_VERSIONS.terms}|${LEGAL_DOC_VERSIONS.privacy}`;
}

/**
 * 원장 동의 다시 묻기(2-L ★10 보강) — 원장 화면(/owner·/academy)에 들어올 때 `legalConsents/{uid}`에
 * 지금 버전 동의가 없으면(가입 직후 기록 실패·문서 개정) 동의 시트를 띄워 기록한다.
 * 확인은 가벼운 읽기 1건(`getOwnerConsentState`), 확인에 실패하면(네트워크 등) 이번엔 묻지 않는다.
 */
export function OwnerConsentGate({ enabled }: { enabled: boolean }) {
  const [uid, setUid] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState<ConsentState>(EMPTY_CONSENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(getFirebaseAuth(), (u) => setUid(u?.uid ?? null)), []);

  useEffect(() => {
    if (!enabled || !uid || confirmedKeys.has(confirmKey(uid))) return;
    let cancelled = false;
    void httpsCallable<unknown, { current?: boolean }>(getFirebaseFunctions(), "getOwnerConsentState")({})
      .then((res) => {
        if (cancelled) return;
        if (res.data.current) confirmedKeys.add(confirmKey(uid));
        else setOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, uid]);

  if (!open || !uid) return null;

  const submit = async () => {
    if (!consentComplete(consent)) {
      setError(CONSENT_REQUIRED_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "recordOwnerConsent")({ consents: currentConsentPayload() });
      confirmedKeys.add(confirmKey(uid));
      setOpen(false);
    } catch {
      setError("동의를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[270] flex items-end justify-center bg-black/40 sm:items-center" role="presentation">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="owner-consent-title"
          className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5"
          data-owner-consent-gate
        >
          <h2 id="owner-consent-title" className="break-keep text-base font-semibold text-foreground">
            약관 동의가 필요해요
          </h2>
          <p className="mt-2 break-keep text-sm text-neutral-600">
            서비스를 계속 이용하려면 이용약관과 개인정보 수집·이용에 동의해 주세요.
          </p>
          <div className="mt-4">
            <ConsentChecklist audience="owner" value={consent} onChangeAction={setConsent} disabled={busy} />
          </div>
          {error ? (
            <p className="mt-2 break-keep text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="mt-4 w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-50"
          >
            {busy ? "저장하는 중…" : "동의하고 계속"}
          </button>
        </div>
      </div>
    </ModalPortal>
  );
}
