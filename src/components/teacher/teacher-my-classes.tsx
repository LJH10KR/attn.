"use client";

import { STUDENT_STATUS_BADGE_CLASS } from "@/components/academy/student-detail/student-detail-sheet";
import { scheduleSummary, slotsOnWeekday } from "@/lib/academy/class-schedule";
import { STUDENT_STATUS_LABELS, isActiveStudent } from "@/lib/academy/student-profile";
import { compareStudentsByName, type StudentVM } from "@/lib/academy/student-row";
import { compareClassesByOrder, type AcademyClassBrief } from "@/lib/academy/use-academy-classes";

const glassCard = "glass-card";

type ClassGroup = {
  key: string;
  cls: AcademyClassBrief | null;
  todayLabel: string | null;
  students: StudentVM[];
};

/**
 * 내 반 묶음 — 종강 반은 빼고(D5: 종강 반은 담당 계산에서 빠짐), 오늘(서울 요일) 수업이 있는 반을 먼저
 * 오늘 시작 시각 순으로, 나머지는 반 목록 순서대로. 내 반 어디에도 없는 담당 학생(트리거 지연 등)은 따로 모은다.
 */
export function groupMyClasses(
  classes: readonly AcademyClassBrief[],
  students: readonly StudentVM[],
  todayWeekday: number,
): ClassGroup[] {
  const open = classes.filter((c) => c.status !== "ended");
  const withToday = open.map((c) => ({ c, today: slotsOnWeekday(c.schedule, todayWeekday) }));
  withToday.sort((a, b) => {
    if (a.today.length > 0 !== b.today.length > 0) return a.today.length > 0 ? -1 : 1;
    if (a.today.length > 0) {
      const t = a.today[0]!.start.localeCompare(b.today[0]!.start);
      if (t !== 0) return t;
    }
    return compareClassesByOrder(a.c, b.c);
  });
  const openIds = new Set(open.map((c) => c.id));
  const groups: ClassGroup[] = withToday.map(({ c, today }) => ({
    key: c.id,
    cls: c,
    todayLabel: today.length > 0 ? today.map((s) => `${s.start}–${s.end}`).join(", ") : null,
    students: students.filter((s) => s.classIds.includes(c.id)).sort(compareStudentsByName),
  }));
  const others = students.filter((s) => !s.classIds.some((id) => openIds.has(id))).sort(compareStudentsByName);
  if (others.length > 0) groups.push({ key: "__others", cls: null, todayLabel: null, students: others });
  return groups;
}

/** 선생님 화면 "내 반" — 반별 학생, 학생을 누르면 학생 상세 시트(정보 탭), 재원 학생만 출석·결석 알림 */
export function TeacherMyClasses({
  groups,
  roomLabelOf,
  notifyBusyKey,
  onNotifyAction,
  onOpenStudentAction,
}: {
  groups: ClassGroup[];
  roomLabelOf: (roomId: string) => string | null;
  notifyBusyKey: string | null;
  onNotifyAction: (studentId: string, kind: "present" | "absent") => void;
  onOpenStudentAction: (studentId: string) => void;
}) {
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const c = g.cls;
        const room = c?.roomId ? roomLabelOf(c.roomId) : null;
        const schedule = c ? scheduleSummary(c.schedule) : "";
        return (
          <section key={g.key} aria-label={c ? c.name : "그 밖의 담당 학생"}>
            <div className="mb-2 px-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="text-sm font-semibold text-foreground">{c ? c.name : "그 밖의 담당 학생"}</h3>
                {g.todayLabel ? (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-900">
                    오늘 {g.todayLabel}
                  </span>
                ) : null}
                {c?.status === "preparing" ? (
                  <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-900">
                    준비중
                  </span>
                ) : null}
                <span className="ml-auto text-[11px] text-neutral-500">{g.students.length}명</span>
              </div>
              {c ? (
                <p className="mt-0.5 truncate text-[11px] text-neutral-500">
                  {[schedule || "수업 시간 미정", room, c.teacherUids.length > 1 ? `선생님 ${c.teacherUids.length}명` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : (
                <p className="mt-0.5 break-keep text-[11px] text-neutral-500">
                  반 정보가 아직 반영되지 않았습니다. 잠시 후 목록을 새로고침해 주세요.
                </p>
              )}
            </div>
            {g.students.length === 0 ? (
              <p className={`py-6 text-center text-xs text-neutral-500 ${glassCard}`}>배정된 학생이 없습니다.</p>
            ) : (
              <ul className={`divide-y divide-neutral-200/70 ${glassCard}`}>
                {g.students.map((s) => {
                  const active = isActiveStudent(s);
                  return (
                    <li key={s.id} className="flex items-center gap-2 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => onOpenStudentAction(s.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <span className="min-w-0 truncate text-sm font-medium text-foreground">
                          {s.name || "(이름 없음)"}
                        </span>
                        <span className="shrink-0 text-[11px] text-neutral-500">{s.gradeLabel || "학년 미입력"}</span>
                        {!active ? (
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[s.status]}`}
                          >
                            {STUDENT_STATUS_LABELS[s.status]}
                          </span>
                        ) : null}
                      </button>
                      {active ? (
                        <div className="flex shrink-0 gap-1.5">
                          <button
                            type="button"
                            disabled={notifyBusyKey !== null}
                            onClick={() => onNotifyAction(s.id, "present")}
                            className="rounded-[8px] border border-emerald-400/60 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-medium text-emerald-950 hover:bg-emerald-500/25 disabled:opacity-50"
                          >
                            {notifyBusyKey === `${s.id}-present` ? "기록 중…" : "출석"}
                          </button>
                          <button
                            type="button"
                            disabled={notifyBusyKey !== null}
                            onClick={() => onNotifyAction(s.id, "absent")}
                            className="rounded-[8px] border border-amber-400/60 bg-amber-500/12 px-2.5 py-1.5 text-[11px] font-medium text-amber-950 hover:bg-amber-500/22 disabled:opacity-50"
                          >
                            {notifyBusyKey === `${s.id}-absent` ? "기록 중…" : "결석"}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
