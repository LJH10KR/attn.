"use client";

import { collection, getDocs } from "firebase/firestore";
import { useCallback, useMemo, useState } from "react";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import { useAcademyShell } from "@/components/academy/academy-shell";
import {
  StudentDetailSheet,
  STUDENT_STATUS_BADGE_CLASS,
} from "@/components/academy/student-detail/student-detail-sheet";
import { StudentFormSheet } from "@/components/academy/student-detail/student-form-sheet";
import { useStudentDetailParam } from "@/components/academy/student-detail/use-student-detail-param";
import { DefaultTuitionTypeModal } from "@/components/academy/students/default-tuition-type-modal";
import {
  compareStudentsByName,
  docToStudent,
  guardianRelationLabel,
  primaryGuardian,
  type StudentVM,
} from "@/lib/academy/student-row";
import {
  GRADE_FILTERS,
  gradeGroup,
  studentMatchesSearch,
  type GradeFilter,
} from "@/lib/academy/student-filters";
import {
  STUDENT_STATUSES,
  STUDENT_STATUS_LABELS,
  type StudentStatus,
} from "@/lib/academy/student-profile";
import { useAcademyClasses, type AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { useAcademyOptionList } from "@/lib/academy/use-academy-option-list";
import { useStudentAccess } from "@/lib/academy/use-student-access";
import { academyStudentsPath, type AcademyOptionItem } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import { downloadCsv, type CsvColumn } from "@/lib/ui/csv";

type StatusFilter = StudentStatus | "all";
/** 반 필터 — 반 id, "none"(반 없음), "all" */
type ClassFilter = string;

const chipClass = (active: boolean) =>
  `shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
    active ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/70 bg-white/60 text-neutral-700"
  }`;

const selectChipClass =
  "min-w-0 shrink-0 rounded-full border border-neutral-300/70 bg-white/60 px-3 py-1.5 text-xs font-medium text-neutral-700";

function seoulYmd(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
}

function csvColumns(
  classNameOf: (id: string) => string | null,
  relations: AcademyOptionItem[],
  memoById: Map<string, string> | null,
): CsvColumn<StudentVM>[] {
  const cols: CsvColumn<StudentVM>[] = [
    { header: "이름", value: (s) => s.name },
    { header: "학년", value: (s) => s.gradeLabel },
    { header: "학교", value: (s) => s.school },
    { header: "상태", value: (s) => STUDENT_STATUS_LABELS[s.status] },
    {
      header: "반",
      value: (s) => s.classIds.flatMap((id) => classNameOf(id) ?? []).join(", "),
    },
    {
      header: "대표 보호자",
      value: (s) => {
        const g = primaryGuardian(s);
        return g ? [guardianRelationLabel(g.relationId, relations), g.name].filter(Boolean).join(" ") : "";
      },
    },
    { header: "보호자 번호", value: (s) => formatKrPhoneDisplay(primaryGuardian(s)?.phone) },
    { header: "학생 번호", value: (s) => formatKrPhoneDisplay(s.phone) },
    { header: "최초 등원일", value: (s) => s.firstAttendedOn ?? "" },
  ];
  if (memoById) cols.push({ header: "메모", value: (s) => memoById.get(s.id) ?? "" });
  return cols;
}

/** 운영 › 원생 관리(9-2) — 카드 목록·검색·필터 칩·추가·CSV, 카드를 누르면 학생 상세 시트 */
export function AcademyStudentsScreen() {
  const { academyId, permissions } = useAcademyShell();
  const access = useStudentAccess(permissions);
  const detail = useStudentDetailParam();
  const [students, setStudents] = useState<StudentVM[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queryText, setQueryText] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("enrolled");
  const [classFilter, setClassFilter] = useState<ClassFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [defaultTuitionOpen, setDefaultTuitionOpen] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const { items: relations, save: saveRelations } = useAcademyOptionList(academyId, "guardianRelations");
  const { classes } = useAcademyClasses(academyId, access.readClasses);

  const loadStudents = useCallback(async () => {
    try {
      const snap = await getDocs(collection(getFirebaseDb(), academyStudentsPath(academyId)));
      const list = snap.docs.map((d) => docToStudent(d.id, d.data() as Record<string, unknown>));
      list.sort(compareStudentsByName);
      setStudents(list);
      setListError(null);
    } catch (err) {
      setStudents([]);
      setListError(err instanceof Error ? err.message : "원생 목록을 불러오지 못했습니다.");
    } finally {
      setLoaded(true);
    }
  }, [academyId]);

  const { refresh, busy: listBusy } = useAcademyListPoll(loadStudents, [academyId]);

  const classById = useMemo(() => new Map<string, AcademyClassBrief>(classes.map((c) => [c.id, c])), [classes]);

  const statusCounts = useMemo(() => {
    const m: Record<StudentStatus, number> = { enrolled: 0, prospect: 0, on_leave: 0, withdrawn: 0 };
    for (const s of students) m[s.status] += 1;
    return m;
  }, [students]);

  const filtered = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return students.filter((s) => {
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (classFilter === "none" && s.classIds.length > 0) return false;
      if (classFilter !== "all" && classFilter !== "none" && !s.classIds.includes(classFilter)) return false;
      if (gradeFilter !== "all" && gradeGroup(s.displayGrade) !== gradeFilter) return false;
      return studentMatchesSearch(s, q);
    });
  }, [students, statusFilter, classFilter, gradeFilter, queryText]);

  const showNotice = useCallback((message: string) => setNotice(message), []);

  const exportCsv = async () => {
    setMenuOpen(false);
    setCsvBusy(true);
    try {
      let memoById: Map<string, string> | null = null;
      if (access.readNotes) {
        const snap = await getDocs(collection(getFirebaseDb(), "academies", academyId, "studentNotes"));
        memoById = new Map(
          snap.docs.map((d) => [d.id, typeof d.get("memo") === "string" ? (d.get("memo") as string) : ""]),
        );
      }
      downloadCsv(
        `원생목록_${seoulYmd()}.csv`,
        csvColumns((id) => classById.get(id)?.name ?? null, relations, memoById),
        filtered,
      );
      setNotice(`${filtered.length}명을 CSV로 내보냈습니다.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "CSV를 만들지 못했습니다.");
    } finally {
      setCsvBusy(false);
    }
  };

  const onDetailChanged = useCallback(
    (message: string) => {
      setNotice(message);
      refresh();
    },
    [refresh],
  );

  return (
    <div className="space-y-3">
      {notice ? (
        <p
          className="break-keep rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {listError ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {listError}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-neutral-600">
          <span className="font-semibold text-foreground">{filtered.length}</span>명
        </p>
        <div className="flex items-center gap-2">
          {access.manage ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="rounded-[8px] bg-[#222] px-3 py-2 text-xs font-medium text-white"
            >
              + 원생 추가
            </button>
          ) : null}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={csvBusy}
              className="rounded-[8px] border border-neutral-300/70 bg-white/55 px-3 py-2 text-xs font-medium text-neutral-700 disabled:opacity-50"
              aria-label="원생 목록 메뉴"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {csvBusy ? "…" : "⋯"}
            </button>
            {menuOpen ? (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-2xl border border-neutral-200 bg-white py-1 shadow-xl"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-4 py-2.5 text-left text-sm hover:bg-black/[0.04]"
                    onClick={() => void exportCsv()}
                  >
                    CSV 내보내기
                  </button>
                  {access.tuitionEdit ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-4 py-2.5 text-left text-sm hover:bg-black/[0.04]"
                      onClick={() => {
                        setMenuOpen(false);
                        setDefaultTuitionOpen(true);
                      }}
                    >
                      기본 원비 설정
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          <AcademyPanelRefreshButton busy={listBusy} onRefreshAction={refresh} />
        </div>
      </div>

      <input
        type="search"
        className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70"
        placeholder="이름·학교·학생/보호자 번호로 검색"
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        aria-label="원생 검색"
      />

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="상태 필터">
        {STUDENT_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            className={chipClass(statusFilter === s)}
          >
            {STUDENT_STATUS_LABELS[s]} {statusCounts[s]}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
          className={chipClass(statusFilter === "all")}
        >
          전체 {students.length}
        </button>
      </div>
      <div className="flex gap-1.5">
        {access.readClasses ? (
          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className={`${selectChipClass} ${classFilter !== "all" ? "border-[#222] text-foreground" : ""}`}
            aria-label="반 필터"
          >
            <option value="all">전체 반</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === "ended" ? " (종강)" : ""}
              </option>
            ))}
            <option value="none">반 없음</option>
          </select>
        ) : null}
        <select
          value={gradeFilter}
          onChange={(e) => setGradeFilter(e.target.value as GradeFilter)}
          className={`${selectChipClass} ${gradeFilter !== "all" ? "border-[#222] text-foreground" : ""}`}
          aria-label="학년 필터"
        >
          {GRADE_FILTERS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </div>

      <ul className="space-y-2 pb-8">
        {!loaded ? (
          <li className="glass-card py-10 text-center text-sm text-neutral-400">불러오는 중…</li>
        ) : filtered.length === 0 ? (
          <li className="glass-card py-10 text-center text-sm text-neutral-500">
            {students.length === 0 ? "등록된 원생이 없습니다." : "조건에 맞는 원생이 없습니다."}
          </li>
        ) : (
          filtered.map((s) => {
            const g = primaryGuardian(s);
            const classChips = s.classIds.flatMap((id) => classById.get(id) ?? []);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => detail.open(s.id)}
                  className="glass-card block w-full px-4 py-3 text-left transition hover:bg-white/45 active:bg-white/55"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-medium text-foreground">{s.name}</span>
                    {s.gradeLabel ? <span className="shrink-0 text-xs text-neutral-500">{s.gradeLabel}</span> : null}
                    <span
                      className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[s.status]}`}
                    >
                      {STUDENT_STATUS_LABELS[s.status]}
                    </span>
                  </div>
                  {classChips.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {classChips.map((c) => (
                        <span
                          key={c.id}
                          className="rounded-full border border-neutral-300/70 px-2 py-0.5 text-[10px] text-neutral-700"
                        >
                          {c.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-neutral-600">
                    <span className="min-w-0 truncate">
                      {g
                        ? `${guardianRelationLabel(g.relationId, relations)} ${formatKrPhoneDisplay(g.phone)}`
                        : "보호자 없음"}
                    </span>
                    {s.parentUids.length > 0 ? (
                      <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-900">
                        앱 연결 {s.parentUids.length}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>

      {detail.studentId ? (
        <StudentDetailSheet
          key={detail.studentId}
          academyId={academyId}
          studentId={detail.studentId}
          tabParam={detail.tabParam}
          permissions={permissions}
          onTabChangeAction={detail.setTab}
          onCloseAction={detail.close}
          onChangedAction={onDetailChanged}
        />
      ) : null}
      {addOpen ? (
        <StudentFormSheet
          academyId={academyId}
          target={null}
          note={{ loaded: true, memo: "" }}
          relations={relations}
          onSaveRelationsAction={access.manage ? saveRelations : undefined}
          onCloseAction={() => setAddOpen(false)}
          onSavedAction={(message, studentId) => {
            setAddOpen(false);
            showNotice(message);
            refresh();
            if (studentId) detail.open(studentId);
          }}
        />
      ) : null}
      {defaultTuitionOpen ? (
        <DefaultTuitionTypeModal
          academyId={academyId}
          onClose={() => {
            setDefaultTuitionOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
