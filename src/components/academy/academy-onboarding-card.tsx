"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { academyMenuPath } from "@/lib/academy/academy-routes";
import type { useAcademyOnboarding } from "@/lib/academy/use-academy-onboarding";

/**
 * 홈 맨 위 "시작하기" 체크리스트 카드(2-M, L4-2·M2) — 원장만, 서버가 "보임"이라고 할 때만.
 * 4단계(M2-1): ① 반 ② 원생 ③ 학부모 연결 또는 QR 공유 ④ 직원(계정·미리 등록) 또는 "직원 없이 운영".
 * 단계 버튼은 해당 화면·시트를 바로 연다(`?new=1`·`?bulk=1`·`?invite=qr`, 학부모 QR은 홈 카드로 스크롤).
 * [숨기기]·다 끝나면 사라지고, 설정 › 전체설정 "시작하기 안내"에서 다시 켠다.
 */

const btn =
  "rounded-[8px] border border-neutral-300/70 bg-white/70 px-2.5 py-1.5 text-[11px] font-medium text-foreground dark:bg-white/10";

function Step({
  n,
  done,
  title,
  status,
  desc,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  status: string | null;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3 py-2.5" data-onboarding-step={n} data-done={done ? "1" : "0"}>
      <span
        aria-hidden
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
          done ? "bg-emerald-600 text-white" : "bg-neutral-200 text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          {title}
          {done && status ? <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-400">{status}</span> : null}
          <span className="sr-only">{done ? " (완료)" : " (아직)"}</span>
        </p>
        {desc ? <p className="break-keep text-[11px] text-neutral-500">{desc}</p> : null}
        {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
      </div>
    </li>
  );
}

export function AcademyOnboardingCard({
  academyId,
  onboarding,
  onOpenParentQrAction,
}: {
  academyId: string;
  onboarding: ReturnType<typeof useAcademyOnboarding>;
  /** ③ [QR 보기] — 홈의 학부모 가입 QR 카드로 스크롤하고 QR을 펼침 */
  onOpenParentQrAction: () => void;
}) {
  const { view, error, busy, act } = onboarding;
  const [hiddenNote, setHiddenNote] = useState(false);

  if (hiddenNote) {
    return (
      <p className="break-keep rounded-2xl bg-neutral-500/10 px-3 py-2 text-center text-[11px] text-neutral-600" role="status">
        시작하기를 숨겼어요. 설정 › 전체설정의 「시작하기 안내」에서 다시 켤 수 있어요.
      </p>
    );
  }
  // 읽기 실패·숨김·다 끝남이면 카드를 그리지 않음(홈의 다른 내용은 그대로)
  if (!view || !view.visible) return null;
  const s = view.steps;
  return (
    <section className="glass-card px-4 py-3" data-onboarding-card aria-labelledby="onboarding-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="onboarding-title" className="text-sm font-semibold text-foreground">
            시작하기 <span className="ml-1 text-xs font-normal tabular-nums text-neutral-500">{view.doneCount}/4</span>
          </h2>
          <p className="mt-0.5 break-keep text-[11px] text-neutral-500">학원 운영 준비를 차례로 해 보세요.</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await act("hide")) setHiddenNote(true);
          }}
          className="shrink-0 text-xs text-neutral-500 underline-offset-2 hover:underline disabled:opacity-50"
          data-onboarding-hide
        >
          숨기기
        </button>
      </div>
      <ol className="mt-1 divide-y divide-neutral-200/70 dark:divide-white/10">
        <Step n={1} done={s.classes.done} title="반 만들기" status={`반 ${s.classes.count}개`}>
          <Link href={`${academyMenuPath(academyId, "operations.classes")}?new=1`} className={btn}>
            반 추가
          </Link>
        </Step>
        <Step n={2} done={s.students.done} title="원생 입력" status={`원생 ${s.students.count}명`}>
          <Link href={`${academyMenuPath(academyId, "operations.students")}?bulk=1`} className={btn}>
            표로 입력
          </Link>
        </Step>
        <Step
          n={3}
          done={s.parents.done}
          title="학부모 가입 QR 공유"
          status={s.parents.linkedCount > 0 ? `연결 ${s.parents.linkedCount}명` : "공유함"}
          desc="번호가 맞으면 자동으로 자녀와 연결돼요."
        >
          <button type="button" onClick={onOpenParentQrAction} className={btn}>
            QR 보기
          </button>
        </Step>
        <Step
          n={4}
          done={s.staff.done}
          title="직원 미리 등록 · 직원 가입 QR"
          status={s.staff.count > 0 ? `직원 ${s.staff.count}명` : "직원 없이 운영"}
        >
          <Link href={`${academyMenuPath(academyId, "settings.staff")}?bulk=1`} className={btn}>
            미리 등록 표
          </Link>
          <Link href={`${academyMenuPath(academyId, "settings.members")}?invite=qr`} className={btn}>
            직원 가입 QR
          </Link>
          {s.staff.count === 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(s.staff.noStaff ? "undo_no_staff" : "no_staff")}
              className="text-[11px] text-neutral-500 underline underline-offset-2 disabled:opacity-50"
              data-onboarding-no-staff
            >
              {s.staff.noStaff ? "되돌리기" : "직원 없이 운영해요"}
            </button>
          ) : null}
        </Step>
      </ol>
      {error ? (
        <p className="mt-1 break-keep text-[11px] text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
