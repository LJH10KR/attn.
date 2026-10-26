"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import { EditableOptionSelect } from "@/components/ui/editable-option-select";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  STAFF_EMPLOYMENT_STATUS_LABELS,
  readStaffEmploymentStatus,
  type AcademyOptionItem,
  type StaffAccountStatus,
  type StaffEmploymentStatus,
} from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatKrPhoneDisplay, getKrPhoneValidationError } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

export type StaffRowVM = {
  id: string;
  displayName: string;
  phone: string;
  jobTitleId: string | null;
  hireDate: string | null;
  employmentStatus: StaffEmploymentStatus;
  memo: string;
  accountStatus: StaffAccountStatus;
  isGuest: boolean;
};

export function docToStaffRow(id: string, data: Record<string, unknown>): StaffRowVM {
  return {
    id,
    displayName: typeof data.displayName === "string" ? data.displayName : "",
    phone: typeof data.phone === "string" ? data.phone : "",
    jobTitleId: typeof data.jobTitleId === "string" ? data.jobTitleId : null,
    hireDate: typeof data.hireDate === "string" ? data.hireDate : null,
    employmentStatus: readStaffEmploymentStatus(data.employmentStatus),
    memo: typeof data.memo === "string" ? data.memo : "",
    accountStatus: (data.status as StaffAccountStatus) || "invitation_needed",
    isGuest: data.isGuest === true,
  };
}

/** 계정 상태 배지 문구 — 초청·가입 진행 단계는 "초대 중"으로 묶음 */
export function staffAccountLabel(status: StaffAccountStatus): string {
  switch (status) {
    case "no_account":
      return "계정 없음";
    case "active":
      return "계정 사용 중";
    case "inactive":
      return "계정 비활성";
    case "pending_registration":
      return "등록 대기";
    default:
      return "초대 중";
  }
}

const EMPLOYMENT_ORDER: StaffEmploymentStatus[] = ["employed", "on_leave", "resigned"];
const MEMO_MAX = 200;

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-sm text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

type StaffFormSheetProps = {
  academyId: string;
  /** null이면 새 직원 추가 */
  target: StaffRowVM | null;
  jobTitles: AcademyOptionItem[];
  onSaveJobTitlesAction: (items: { id?: string; label: string }[]) => Promise<AcademyOptionItem[]>;
  jobTitleUsage: Record<string, number>;
  onCloseAction: () => void;
  onSavedAction: (message: string) => void;
};

/** 직원 추가·수정 전체 화면 시트 — 계정 초대·권한은 멤버 관리에서 */
export function StaffFormSheet({
  academyId,
  target,
  jobTitles,
  onSaveJobTitlesAction,
  jobTitleUsage,
  onCloseAction,
  onSavedAction,
}: StaffFormSheetProps) {
  useBodyScrollLock(true);
  const [displayName, setDisplayName] = useState(target?.displayName ?? "");
  const [phone, setPhone] = useState(formatKrPhoneDisplay(target?.phone));
  const [jobTitleId, setJobTitleId] = useState<string | null>(target?.jobTitleId ?? null);
  const [hireDate, setHireDate] = useState(target?.hireDate ?? "");
  const [employmentStatus, setEmploymentStatus] = useState<StaffEmploymentStatus>(
    target?.employmentStatus ?? "employed",
  );
  const [memo, setMemo] = useState(target?.memo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCloseAction]);

  const willDeactivateAccount =
    target?.accountStatus === "active" &&
    target.employmentStatus !== "resigned" &&
    employmentStatus === "resigned";

  const onSubmit = async () => {
    const name = displayName.trim();
    if (!name) {
      setError("이름을 입력해 주세요.");
      return;
    }
    if (phone.trim()) {
      const phoneError = getKrPhoneValidationError(phone);
      if (phoneError) {
        setError(phoneError);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "saveStaffMember");
      const res = await fn({
        academyId,
        staffId: target?.id ?? null,
        displayName: name,
        phone,
        jobTitleId,
        hireDate: hireDate || null,
        employmentStatus,
        memo,
      });
      const data = res.data as { accountDeactivated?: boolean };
      onSavedAction(
        data.accountDeactivated
          ? `${name} 님을 퇴사 처리하고 계정을 비활성화했습니다.`
          : target
            ? `${name} 님의 정보를 저장했습니다.`
            : `${name} 님을 직원으로 추가했습니다.`,
      );
    } catch (e) {
      setError(errMsg(e, "저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!target || !window.confirm(`${target.displayName} 님을 직원 목록에서 삭제할까요?`)) return;
    setBusy(true);
    setError(null);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "deleteStaffMember");
      await fn({ academyId, staffId: target.id });
      onSavedAction(`${target.displayName} 님을 삭제했습니다.`);
    } catch (e) {
      setError(errMsg(e, "삭제하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[200] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-form-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between">
            <h1 id="staff-form-title" className="text-lg font-semibold text-foreground">
              {target ? "직원 정보" : "직원 추가"}
            </h1>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy}
              className="text-sm text-neutral-500 hover:text-foreground"
            >
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-4 px-4 py-5">
            <div>
              <label htmlFor="staff-name" className="mb-1 block text-xs font-medium text-neutral-600">
                이름 <span className="text-red-600">*</span>
              </label>
              <input
                id="staff-name"
                value={displayName}
                maxLength={60}
                onChange={(e) => setDisplayName(e.target.value)}
                className={inputClass}
                placeholder="예: 김선생"
              />
            </div>

            <div>
              <label htmlFor="staff-phone" className="mb-1 block text-xs font-medium text-neutral-600">
                연락처
              </label>
              <KrPhoneInput id="staff-phone" value={phone} onChange={setPhone} className={inputClass} />
            </div>

            <div>
              <label htmlFor="staff-job" className="mb-1 block text-xs font-medium text-neutral-600">
                직무
              </label>
              <EditableOptionSelect
                id="staff-job"
                noun="직무"
                value={jobTitleId}
                onChangeAction={setJobTitleId}
                items={jobTitles}
                onSaveItemsAction={onSaveJobTitlesAction}
                usageCountById={jobTitleUsage}
                placeholder="직무 선택 (예: 강사, 행정)"
                disabled={busy}
              />
            </div>

            <div>
              <label htmlFor="staff-hire" className="mb-1 block text-xs font-medium text-neutral-600">
                입사일
              </label>
              <input
                id="staff-hire"
                type="date"
                value={hireDate}
                onChange={(e) => setHireDate(e.target.value)}
                className={inputClass}
              />
            </div>

            <fieldset>
              <legend className="mb-1 block text-xs font-medium text-neutral-600">재직 상태</legend>
              <div className="grid grid-cols-3 gap-2" role="radiogroup">
                {EMPLOYMENT_ORDER.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={employmentStatus === s}
                    onClick={() => setEmploymentStatus(s)}
                    className={`rounded-2xl border py-2.5 text-sm font-medium transition ${
                      employmentStatus === s
                        ? "border-[#222] bg-[#222] text-white"
                        : "border-neutral-300/70 bg-white/60 text-neutral-700"
                    }`}
                  >
                    {STAFF_EMPLOYMENT_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
              {willDeactivateAccount ? (
                <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                  퇴사로 저장하면 이 직원의 계정이 비활성화되어 로그인할 수 없습니다.
                </p>
              ) : null}
            </fieldset>

            <div>
              <label htmlFor="staff-memo" className="mb-1 block text-xs font-medium text-neutral-600">
                메모
              </label>
              <textarea
                id="staff-memo"
                value={memo}
                maxLength={MEMO_MAX}
                rows={3}
                onChange={(e) => setMemo(e.target.value)}
                className={`${inputClass} resize-none`}
                placeholder="담당 과목, 근무 요일 등"
              />
              <p className="mt-1 text-right text-[10px] text-neutral-400">
                {memo.length}/{MEMO_MAX}
              </p>
            </div>

            {target ? (
              <div className="rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3 text-xs text-neutral-600">
                <p>
                  계정: <span className="font-medium text-foreground">{staffAccountLabel(target.accountStatus)}</span>
                </p>
                <p className="mt-1 text-neutral-500">계정 초대와 권한은 멤버 관리에서 설정합니다.</p>
              </div>
            ) : null}

            {error ? (
              <p className="text-sm text-red-700" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </main>

        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto flex max-w-lg gap-2">
            {target?.accountStatus === "no_account" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onDelete()}
                className="rounded-2xl border border-red-200 px-4 py-3 text-sm font-medium text-red-700 disabled:opacity-50"
              >
                삭제
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSubmit()}
              className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </footer>
      </div>
    </ModalPortal>
  );
}
