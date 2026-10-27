"use client";

import Link from "next/link";
import { useEffect } from "react";
import { StaffAccountSection } from "@/components/academy/staff-account-section";
import { ModalPortal } from "@/components/ui/modal-portal";
import type { PermissionViewer } from "@/lib/academy/role-policy";
import type { StaffRowVM } from "@/lib/academy/staff-row";
import type { AcademyRoleVM } from "@/lib/academy/use-academy-roles";
import { STAFF_EMPLOYMENT_STATUS_LABELS } from "@/lib/firebase/attn-schema";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

type MemberSheetProps = {
  academyId: string;
  target: StaffRowVM;
  roles: AcademyRoleVM[] | null;
  viewer: PermissionViewer | null;
  jobTitleLabel: string | null;
  /** 직원 관리 권한이 있으면 인사 정보 수정 링크 */
  canEditStaff: boolean;
  onCloseAction: () => void;
  onChangedAction: (message: string) => void;
  onClosedWithMessageAction: (message: string) => void;
};

/** 멤버(계정) 상세 전체 화면 시트 — 인사 정보는 보기만, 계정·권한은 직원 관리와 같은 `StaffAccountSection` */
export function MemberSheet({
  academyId,
  target,
  roles,
  viewer,
  jobTitleLabel,
  canEditStaff,
  onCloseAction,
  onChangedAction,
  onClosedWithMessageAction,
}: MemberSheetProps) {
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCloseAction]);

  const info: { label: string; value: string }[] = [
    { label: "직무", value: jobTitleLabel ?? "—" },
    { label: "연락처", value: formatKrPhoneDisplay(target.phone) || "—" },
    { label: "재직 상태", value: STAFF_EMPLOYMENT_STATUS_LABELS[target.employmentStatus] },
  ];

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[200] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-sheet-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between">
            <h1 id="member-sheet-title" className="text-lg font-semibold text-foreground">
              {target.displayName || "(이름 없음)"}
              {target.isGuest ? (
                <span className="ml-2 rounded-full bg-neutral-500/15 px-2 py-0.5 align-middle text-[10px] font-semibold text-neutral-700">
                  게스트
                </span>
              ) : null}
            </h1>
            <button type="button" onClick={onCloseAction} className="text-sm text-neutral-500 hover:text-foreground">
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-4 px-4 py-5">
            {!target.isGuest ? (
              <section className="rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3">
                <dl className="space-y-1.5 text-xs">
                  {info.map((row) => (
                    <div key={row.label} className="flex justify-between gap-3">
                      <dt className="text-neutral-500">{row.label}</dt>
                      <dd className="text-foreground">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                {canEditStaff ? (
                  <Link
                    href={`/academy/settings/staff?id=${encodeURIComponent(academyId)}`}
                    className="mt-2 inline-block text-[11px] text-[#4a90e2] underline"
                  >
                    인사 정보는 직원 관리에서 고칠 수 있어요
                  </Link>
                ) : null}
              </section>
            ) : null}

            <StaffAccountSection
              academyId={academyId}
              target={target}
              roles={roles}
              viewer={viewer}
              onChangedAction={onChangedAction}
              onCloseSheetAction={onClosedWithMessageAction}
            />
          </div>
        </main>
      </div>
    </ModalPortal>
  );
}
