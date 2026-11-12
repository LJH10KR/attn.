"use client";

import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, type Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PhoneChangeSheet } from "@/components/phone-verification/phone-change-sheet";
import { ModalPortal } from "@/components/ui/modal-portal";
import { getFirebaseAuth, getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import { octomoPhoneKey } from "@/lib/phone/octomo-phone-key";
import { signupErrorMessage } from "@/lib/signup/signup-errors";

/** 안내 처리로 자녀 연결이 바뀌었을 때 학부모 홈이 자녀 목록을 다시 받게 */
export const PARENT_CHILDREN_CHANGED_EVENT = "attn-parent-children-changed";

export const PHONE_NOTICE_TEXT = {
  title: "보호자 번호가 바뀌었어요",
  body: (student: string, phone: string) =>
    `학원에서 ${student} 학생의 보호자 번호를 ${phone}로 바꿨어요. 지금 쓰는 번호를 확인해 주세요.`,
  confirm: "지금 쓰는 번호 확인하기",
  revert: "번호를 바꾸지 않았어요",
  later: "나중에",
} as const;

type Notice = { studentId: string; studentName: string; phone: string; changedAtMs: number };
type Account = { academyId: string; uid: string; phone: string; verified: boolean; notices: Notice[] };

function noticeKey(n: Notice): string {
  return `${n.studentId}:${n.changedAtMs}:${n.phone}`;
}

function readNotices(data: Record<string, unknown> | undefined): Notice[] {
  const linked = Array.isArray(data?.linkedStudentIds)
    ? (data.linkedStudentIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const byStudent = ((data?.phoneNotice as { byStudent?: Record<string, unknown> } | undefined)?.byStudent ?? {}) as Record<
    string,
    { studentName?: unknown; phone?: unknown; changedAt?: unknown }
  >;
  return Object.entries(byStudent)
    .flatMap(([studentId, v]): Notice[] => {
      // 지금 연결된 자녀만(그 사이 해제된 자녀의 안내는 보이지 않음)
      if (!linked.includes(studentId) || !v || typeof v.phone !== "string" || !v.phone) return [];
      const ts = v.changedAt as Timestamp | undefined;
      return [{
        studentId,
        studentName: typeof v.studentName === "string" && v.studentName ? v.studentName : "자녀",
        phone: v.phone,
        changedAtMs: typeof ts?.toMillis === "function" ? ts.toMillis() : 0,
      }];
    })
    .sort((a, b) => a.changedAtMs - b.changedAtMs);
}

const btnPrimary =
  "w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950";
const btnSecondary =
  "w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700 disabled:opacity-50";

/**
 * 학원이 연결된 보호자 칸 번호를 바꿨을 때 학부모 앱 안내 창(2-L L3-1-2) — `/parent` 레이아웃에 붙는다.
 * 계정 문서 `phoneNotice.byStudent` 중 **지금 연결된 자녀만** 한 번에 하나씩 보인다. 앱을 열 때·화면으로 돌아올 때·안내 푸시가 올 때 다시 읽는다.
 * [지금 쓰는 번호 확인하기] = 학원 번호를 미리 채운 번호 바꾸기 시트(문자 확인 필수) → `resolveParentPhoneNotice` confirm.
 * [번호를 바꾸지 않았어요] = 계정 번호가 문자로 확인된 번호일 때만 보임 → revert. [나중에] = 이 화면에서만 숨김(메모리, 다시 열면 또 뜸).
 */
export function ParentPhoneNoticeGate({ refreshKey }: { refreshKey: number }) {
  const pathname = usePathname();
  const active = pathname === "/parent" || pathname.startsWith("/parent/settings");
  const [account, setAccount] = useState<Account | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [sheet, setSheet] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const user = getFirebaseAuth().currentUser;
    if (!user) {
      setAccount(null);
      return;
    }
    try {
      const token = await user.getIdTokenResult();
      const academyId = typeof token.claims.academyId === "string" ? token.claims.academyId : "";
      if (token.claims.role !== "parent" || !academyId) {
        if (seq === loadSeq.current) setAccount(null);
        return;
      }
      const snap = await getDoc(doc(getFirebaseDb(), "academies", academyId, "parents", user.uid));
      if (seq !== loadSeq.current) return;
      const data = snap.data();
      const phone = typeof data?.phone === "string" ? data.phone : "";
      const key = octomoPhoneKey(phone);
      setAccount({
        academyId,
        uid: user.uid,
        phone,
        verified: key !== "" && data?.phoneVerifiedKey === key,
        notices: readNotices(data),
      });
    } catch {
      /* 안내는 다음에 다시 — 화면을 막지 않음 */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const unsub = onAuthStateChanged(getFirebaseAuth(), () => void load());
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, load]);

  useEffect(() => {
    if (active && refreshKey > 0) void load();
  }, [active, refreshKey, load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const current = active && account ? account.notices.find((n) => !dismissed.has(noticeKey(n))) ?? null : null;

  const later = (n: Notice) => {
    setError(null);
    setDismissed((prev) => new Set(prev).add(noticeKey(n)));
  };

  const revert = async (n: Notice) => {
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "resolveParentPhoneNotice")({ action: "revert", studentId: n.studentId });
      setToast("보호자 번호를 지금 계정 번호로 되돌리고 학원에 알렸어요.");
      await load();
    } catch (e) {
      setError(signupErrorMessage(e, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {current && !sheet ? (
        <ModalPortal>
          <div className="fixed inset-0 z-[265] flex items-end justify-center bg-black/40 sm:items-center" role="presentation">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="phone-notice-title"
              className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5 dark:bg-neutral-900"
              data-phone-notice={current.studentId}
            >
              <h2 id="phone-notice-title" className="break-keep text-base font-semibold text-foreground">
                {PHONE_NOTICE_TEXT.title}
              </h2>
              <p className="mt-2 break-keep text-sm text-neutral-600">
                {PHONE_NOTICE_TEXT.body(current.studentName, formatKrPhoneDisplay(current.phone))}
              </p>
              {error ? (
                <p className="mt-2 break-keep text-sm text-red-700" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="mt-4 space-y-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setSheet(current);
                  }}
                  className={btnPrimary}
                  data-phone-notice-confirm
                >
                  {PHONE_NOTICE_TEXT.confirm}
                </button>
                {account?.verified ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revert(current)}
                    className={btnSecondary}
                    data-phone-notice-revert
                  >
                    {busy ? "처리하는 중…" : PHONE_NOTICE_TEXT.revert}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => later(current)}
                  className="w-full py-2 text-sm text-neutral-500"
                  data-phone-notice-later
                >
                  {PHONE_NOTICE_TEXT.later}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      ) : null}

      {sheet && account ? (
        <PhoneChangeSheet
          title="지금 쓰는 번호 확인"
          intro={`문자로 확인한 번호가 계정 번호와 ${sheet.studentName} 학생 등 연결된 자녀의 보호자 번호로 저장돼요.`}
          initialPhone={formatKrPhoneDisplay(sheet.phone)}
          currentPhone={account.phone}
          currentVerified={account.verified}
          submitAction={async (phone, proof) => {
            const res = await httpsCallable(getFirebaseFunctions(), "resolveParentPhoneNotice")({
              action: "confirm",
              studentId: sheet.studentId,
              phone,
              phoneProof: proof,
            });
            const linkedCount = (res.data as { linkedCount?: number }).linkedCount ?? 0;
            return linkedCount > 0
              ? `번호를 확인했어요. 자녀 ${linkedCount}명과 새로 연결됐어요.`
              : "번호를 확인했어요. 학원에도 반영됐어요.";
          }}
          onDoneAction={(message) => {
            setSheet(null);
            setToast(message);
            void load();
            window.dispatchEvent(new Event(PARENT_CHILDREN_CHANGED_EVENT));
          }}
          onCloseAction={() => setSheet(null)}
        />
      ) : null}

      {toast ? (
        <div
          className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-[275] mx-auto max-w-sm rounded-2xl bg-[#222] px-4 py-3 text-center text-sm text-white shadow-lg"
          role="status"
          data-phone-notice-toast
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
