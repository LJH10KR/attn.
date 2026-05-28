"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useId, useState } from "react";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import {
  isFirebaseEmulatorEnabled,
  isWebPushConfigured,
} from "@/lib/firebase/config";
import {
  callSyncParentPushSubscription,
  clearLastSyncedFcmTokenStorage,
  FCM_LAST_SYNCED_TOKEN_STORAGE_KEY,
  fetchFcmToken,
  prepareWebPushMessaging,
  removeFcmTokenLocal,
} from "@/lib/firebase/web-push";

const shellClass = "glass-card overflow-hidden";

export function ParentPushNotificationsCard() {
  const headingId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [remoteEnabled, setRemoteEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const auth = getFirebaseAuth();
    return auth.onAuthStateChanged((u) => {
      setUid(u?.uid ?? null);
      if (!u) setRemoteEnabled(null);
    });
  }, []);

  useEffect(() => {
    if (!uid) return;
    const db = getFirebaseDb();
    const unsub = onSnapshot(
      doc(db, "users", uid),
      (snap) => {
        const v = snap.data()?.pushNotificationsEnabled;
        setRemoteEnabled(typeof v === "boolean" ? v : false);
      },
      () => setRemoteEnabled(false),
    );
    return () => unsub();
  }, [uid]);

  const onToggle = useCallback(
    async (wantOn: boolean) => {
      setError(null);
      if (!uid) return;
      if (isFirebaseEmulatorEnabled()) {
        setError("에뮬레이터에서는 웹 푸시를 사용할 수 없습니다.");
        return;
      }
      if (!isWebPushConfigured()) {
        setError("푸시 설정이 완료되지 않았습니다. VAPID 키가 필요합니다.");
        return;
      }
      setBusy(true);
      try {
        if (!wantOn) {
          await removeFcmTokenLocal();
          await callSyncParentPushSubscription(false);
          clearLastSyncedFcmTokenStorage();
          return;
        }
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "denied"
        ) {
          setError(
            "브라우저에서 알림이 차단되어 있습니다. 설정에서 허용해 주세요.",
          );
          return;
        }
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "default"
        ) {
          const p = await Notification.requestPermission();
          if (p !== "granted") {
            setError("알림 권한이 필요합니다. 허용 후 다시 시도해 주세요.");
            return;
          }
        }
        const { token, error: tokenErr } = await fetchFcmToken();
        if (!token) {
          setError(tokenErr ?? "푸시 등록에 실패했습니다.");
          return;
        }
        await callSyncParentPushSubscription(true, token, {
          clientAtMillis: Date.now(),
          syncMode: "normal",
        });
        try {
          sessionStorage.setItem(FCM_LAST_SYNCED_TOKEN_STORAGE_KEY, token);
        } catch {
          /* ignore */
        }
        setError(null);
      } catch {
        setError("설정 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      } finally {
        setBusy(false);
      }
    },
    [uid],
  );

  const canAttempt = uid && !isFirebaseEmulatorEnabled() && isWebPushConfigured();
  const prep = remoteEnabled === null;

  useEffect(() => {
    void prepareWebPushMessaging();
  }, []);

  const statusLine = prep
    ? "상태를 불러오는 중…"
    : remoteEnabled
      ? "브라우저 알림 받기 켜짐"
      : "브라우저 알림 받기 꺼짐";

  return (
    <section className={shellClass} aria-label="출석·결석 웹 푸시 알림">
      <button
        type="button"
        id={headingId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 p-4 text-left transition hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            출석·결석 알림 (웹 푸시)
          </h2>
          {!open ? (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {statusLine}
            </p>
          ) : null}
        </div>
        <svg
          className={`mt-0.5 h-5 w-5 shrink-0 text-neutral-500 transition-transform dark:text-neutral-400 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className="border-t border-neutral-200/80 px-4 pb-4 pt-3 dark:border-white/10"
        >
          <p className="text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-400">
            켜 두면 선생님이 보낸 출석·결석 알림을 브라우저 알림으로 받을 수 있습니다. 끄면 이
            브라우저에서는 푸시를 받지 않으며, 자녀 목록 등 다른 기능은 그대로 이용할 수 있습니다.
          </p>
          {error ? (
            <p className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-800 dark:text-red-200">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-800 dark:text-neutral-200">
              {prep ? "불러오는 중…" : remoteEnabled ? "알림 받기 켜짐" : "알림 받기 꺼짐"}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(remoteEnabled)}
              disabled={busy || prep || !canAttempt}
              onClick={() => void onToggle(!remoteEnabled)}
              className={`relative h-9 w-[3.25rem] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                remoteEnabled ? "bg-emerald-600" : "bg-neutral-300 dark:bg-neutral-600"
              }`}
            >
              <span
                className={`absolute top-1 left-1 h-7 w-7 rounded-full bg-white shadow transition-transform ${
                  remoteEnabled ? "translate-x-[1.35rem]" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          {!isWebPushConfigured() ? (
            <p className="mt-3 text-[10px] text-amber-800 dark:text-amber-200">
              관리자: Firebase 콘솔에서 웹 푸시 인증서(VAPID)를 생성한 뒤{" "}
              <code className="font-mono text-[10px]">
                NEXT_PUBLIC_FIREBASE_VAPID_KEY
              </code>
              를 설정해 주세요.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
