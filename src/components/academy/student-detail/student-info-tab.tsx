"use client";

import { guardianRelationLabel, type StudentVM } from "@/lib/academy/student-row";
import type { AcademyOptionItem } from "@/lib/firebase/attn-schema";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import type { StudentNoteState } from "@/components/academy/student-detail/student-form-sheet";

const sectionClass = "rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3";

/** 정보 탭 — 기본 정보·보호자·메모(원생 관리 권한일 때만) */
export function StudentInfoTab({
  student,
  relations,
  note,
}: {
  student: StudentVM;
  relations: AcademyOptionItem[];
  /** null이면 메모를 볼 권한 없음 — 영역 자체를 숨김 */
  note: StudentNoteState | "loading" | null;
}) {
  const info: { label: string; value: string }[] = [
    { label: "학년", value: student.gradeLabel || "—" },
    { label: "학교", value: student.school || "—" },
    { label: "학생 번호", value: formatKrPhoneDisplay(student.phone) || "—" },
    { label: "최초 등원일", value: student.firstAttendedOn ?? "—" },
    { label: "원생 번호", value: student.attnId || "—" },
  ];
  const guardians = [...student.guardians].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  return (
    <div className="space-y-3">
      <section className={sectionClass}>
        <dl className="space-y-1.5 text-xs">
          {info.map((row) => (
            <div key={row.label} className="flex justify-between gap-3">
              <dt className="shrink-0 text-neutral-500">{row.label}</dt>
              <dd className="min-w-0 break-all text-right text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={sectionClass}>
        <h3 className="mb-2 text-xs font-semibold text-foreground">보호자</h3>
        {guardians.length === 0 ? (
          <p className="text-xs text-neutral-500">등록된 보호자가 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {guardians.map((g) => (
              <li key={g.id} className="flex items-start justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {guardianRelationLabel(g.relationId, relations)}
                    {g.name ? <span className="font-normal text-neutral-600"> · {g.name}</span> : null}
                  </p>
                  <p className="mt-0.5 text-neutral-600">{formatKrPhoneDisplay(g.phone)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {g.isPrimary ? (
                    <span className="rounded-full bg-neutral-500/15 px-2 py-0.5 text-[10px] font-semibold text-neutral-700">
                      대표
                    </span>
                  ) : null}
                  {g.linkedParentUid ? (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-900">
                      앱 연결됨
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {note !== null ? (
        <section className={sectionClass}>
          <h3 className="mb-1 text-xs font-semibold text-foreground">
            메모 <span className="font-normal text-neutral-400">· 학원 내부용</span>
          </h3>
          <p className="whitespace-pre-wrap break-words text-xs text-neutral-700">
            {note === "loading"
              ? "메모를 불러오는 중입니다"
              : note.loaded
                ? note.memo || "메모가 없습니다."
                : "메모를 불러오지 못했습니다."}
          </p>
        </section>
      ) : null}
    </div>
  );
}
