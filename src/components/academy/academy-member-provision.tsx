"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

type IssuedRow = {
  attnId: string;
  loginId?: string;
  displayName: string;
  tempPassword: string;
};

type AcademyMemberProvisionProps = {
  academyId: string;
  kind: "teacher" | "parent" | "students";
  parentAuthUid?: string;
  open: boolean;
  onCloseAction: () => void;
  onDoneAction?: () => void;
};

function errMsg(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

export function AcademyMemberProvisionModal({
  academyId,
  kind,
  parentAuthUid,
  open,
  onCloseAction,
  onDoneAction,
}: AcademyMemberProvisionProps) {
  useBodyScrollLock(open);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedRow[]>([]);
  const [studentLines, setStudentLines] = useState<string[]>([]);

  const title =
    kind === "teacher"
      ? "선생님 등록"
      : kind === "parent"
        ? "학부모 등록"
        : "자녀 등록";

  const handleSubmit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const fn = getFirebaseFunctions();
      if (kind === "teacher") {
        const call = httpsCallable(fn, "provisionTeachersBatch");
        const res = await call({ academyId, count });
        const data = res.data as { teachers?: IssuedRow[] };
        setIssued(data.teachers ?? []);
      } else if (kind === "parent") {
        const call = httpsCallable(fn, "provisionParentsBatch");
        const res = await call({ academyId, count, childrenPerParent: 0 });
        const data = res.data as {
          parents?: Array<IssuedRow & { children?: Array<{ attnId: string }> }>;
        };
        setIssued(
          (data.parents ?? []).map((p) => ({
            attnId: p.attnId,
            displayName: p.displayName,
            tempPassword: p.tempPassword,
          })),
        );
      } else {
        if (!parentAuthUid) {
          setError("학부모 정보가 없습니다.");
          return;
        }
        const call = httpsCallable(fn, "provisionStudentsBatch");
        const res = await call({ academyId, parentAuthUid, count });
        const data = res.data as {
          students?: Array<{ attnId: string; name: string }>;
        };
        setStudentLines((data.students ?? []).map((s) => s.attnId));
      }
      onDoneAction?.();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [academyId, count, kind, onDoneAction, parentAuthUid]);

  const handleClose = useCallback(() => {
    setCount(1);
    setError(null);
    setIssued([]);
    setStudentLines([]);
    onCloseAction();
  }, [onCloseAction]);

  if (!open) {
    return null;
  }

  const showResult = issued.length > 0 || studentLines.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="glass-card w-full max-w-md rounded-3xl p-6">
        <h3 className="text-lg font-semibold">{title}</h3>
        {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}

        {showResult ? (
          <div className="mt-4 space-y-2 text-xs">
            <p className="text-neutral-600">발급 완료 — 아래 정보는 이번에만 표시됩니다.</p>
            {issued.map((row) => (
              <p key={row.attnId} className="font-mono leading-relaxed">
                {row.displayName} ·{" "}
                {kind === "teacher" && row.loginId
                  ? `${row.loginId} (attn: ${row.attnId})`
                  : row.attnId}{" "}
                · {row.tempPassword}
              </p>
            ))}
            {studentLines.map((line) => (
              <p key={line} className="font-mono">
                {line}
              </p>
            ))}
            <button
              type="button"
              onClick={handleClose}
              className="mt-4 w-full rounded-2xl bg-[#222] py-2.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-950"
            >
              확인
            </button>
          </div>
        ) : (
          <>
            <label className="mt-4 block text-xs text-neutral-600">발급 개수</label>
            <input
              type="number"
              min={1}
              max={kind === "students" ? 20 : 50}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="mt-1 w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-2.5 text-sm"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={busy}
                className="flex-1 rounded-2xl border py-2.5 text-sm"
              >
                취소
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSubmit()}
                className="flex-1 rounded-2xl bg-[#222] py-2.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-950"
              >
                {busy ? "발급 중…" : "발급"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 미활성 계정 — attnId 표시·임시 비밀번호 재발급 */
export function AcademyMemberCredentialActions({
  academyId,
  authUid,
  role,
  attnId,
  loginId,
  status,
}: {
  academyId: string;
  authUid: string;
  role: "teacher" | "parent";
  attnId: string;
  /** 학부모 링크 가입 등 — 로그인에 쓰는 ID (없으면 attnId) */
  loginId?: string;
  status: string;
}) {
  const credentialLogin = loginId?.trim() || attnId;
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onRegenerate = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "regenerateMemberTempPassword");
      const res = await fn({ academyId, memberAuthUid: authUid, role });
      const data = res.data as { tempPassword?: string };
      setTempPassword(data.tempPassword ?? null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [academyId, authUid, role]);

  if (!credentialLogin) {
    return null;
  }

  return (
    <div className="mt-1 space-y-1 text-[11px]">
      <p className="font-mono text-neutral-600">
        {(role === "parent" || role === "teacher") && loginId
          ? "로그인 ID"
          : "로그인 번호"}
        : {credentialLogin}
        <button
          type="button"
          className="ml-2 text-[#4a90e2] underline"
          onClick={() => void navigator.clipboard.writeText(credentialLogin)}
        >
          복사
        </button>
      </p>
      {(role === "parent" || role === "teacher") &&
      loginId &&
      attnId &&
      loginId !== attnId ? (
        <p className="text-neutral-500">관리 번호(attn): {attnId}</p>
      ) : null}
      {status === "pending_setup" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRegenerate()}
          className="text-[#4a90e2] underline disabled:opacity-50"
        >
          {busy ? "처리 중…" : "임시 비밀번호 재발급"}
        </button>
      ) : null}
      {error ? <p className="text-red-600">{error}</p> : null}
      {tempPassword ? (
        <p className="rounded-lg bg-amber-50 px-2 py-1 font-mono text-amber-950 ring-1 ring-amber-200">
          임시 비밀번호(1회): {tempPassword}
        </p>
      ) : null}
    </div>
  );
}
