"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseEmulatorEnabled, isWebPushConfigured } from "@/lib/firebase/config";
import {
  callSyncParentPushSubscription,
  fetchFcmToken,
  prepareWebPushMessaging,
  removeFcmTokenLocal,
} from "@/lib/firebase/web-push";

const cardClass =
  "rounded-[1.75rem] border border-white/70 bg-[rgba(236,235,228,0.45)] p-4 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl";

export function ParentPushNotificationsCard() {
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
          return;
        }
        if (typeof Notification !== "undefined" && Notification.permission === "denied") {
          setError("브라우저에서 알림이 차단되어 있습니다. 설정에서 허용해 주세요.");
          return;
        }
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
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
        await callSyncParentPushSubscription(true, token);
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

  return (
    <section className={cardClass}>
      <h2 className="text-sm font-semibold text-[#111]">출석·결석 알림 (웹 푸시)</h2>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
        켜 두면 선생님이 보낸 출석·결석 알림을 브라우저 알림으로 받을 수 있습니다. 끄면 앱에서만 확인할
        수 있으며, 자녀 목록 등 다른 기능은 그대로 이용할 수 있습니다.
      </p>
      {error ? (
        <p className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-800">{error}</p>
      ) : null}
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm text-neutral-800">
          {prep ? "불러오는 중…" : remoteEnabled ? "알림 받기 켜짐" : "알림 받기 꺼짐"}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(remoteEnabled)}
          disabled={busy || prep || !canAttempt}
          onClick={() => void onToggle(!remoteEnabled)}
          className={`relative h-9 w-[3.25rem] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            remoteEnabled ? "bg-emerald-600" : "bg-neutral-300"
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
        <p className="mt-2 text-[10px] text-amber-800">
          관리자: Firebase 콘솔에서 웹 푸시 인증서(VAPID)를 생성한 뒤{" "}
          <code className="font-mono text-[10px]">NEXT_PUBLIC_FIREBASE_VAPID_KEY</code>를 설정해 주세요.
        </p>
      ) : null}
    </section>
  );
}
