"use client";

import { useMemo, useState, type ReactNode } from "react";
import { STUDENT_STATUS_BADGE_CLASS } from "@/components/academy/student-detail/student-detail-sheet";
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
import type { StudentVM } from "@/lib/academy/student-row";
import type { AcademyClassBrief } from "@/lib/academy/use-academy-classes";

/**
 * 원생 다중 선택 목록(9-3) — 반 배정(2-F), 청구·공지 대상 선택(3·4단계)에서 같이 쓴다.
 * - 선택은 부모가 가진다(`selectedIds`/`onChangeAction`). 필터·검색으로 안 보이는 원생도 선택은 유지되고 "선택 n명"에 들어간다.
 * - "보이는 원생 모두 선택/해제"는 지금 보이면서 `disabledIds`가 아닌 원생에만 적용한다.
 * - 프리셋 탭(예: 배정됨/미배정)은 `ignoreFilters`면 상태·반·학년 필터를 건너뛴다(검색만 적용).
 */
export type StudentMultiSelectPreset = {
  id: string;
  label: string;
  filter: (s: StudentVM) => boolean;
  /** 이 탭에서는 상태·반·학년 필터를 적용하지 않음 — 예: 반 배정 "배정됨"(퇴원 원생도 빼려면 보여야 함) */
  ignoreFilters?: boolean;
};

type StatusFilter = StudentStatus | "all";

export type StudentMultiSelectProps = {
  /** 표시 순서 그대로(보통 이름순) */
  students: readonly StudentVM[];
  selectedIds: readonly string[];
  onChangeAction: (next: string[]) => void;
  presets?: readonly StudentMultiSelectPreset[];
  defaultPresetId?: string;
  /** 상태 칩 보이기(기본 참) */
  statusChips?: boolean;
  defaultStatus?: StatusFilter;
  /** 주면 반 필터를 보여 준다 */
  classes?: readonly AcademyClassBrief[];
  /** 학년 필터 보이기(기본 참) */
  gradeFilter?: boolean;
  /** 고를 수 없는 원생(선택돼 있으면 해제만 가능) */
  disabledIds?: ReadonlySet<string>;
  /** 고를 수 없는 행에 붙는 짧은 안내 */
  disabledHint?: string;
  /** 행 오른쪽 배지(예: "다른 반 2") */
  badge?: (s: StudentVM) => ReactNode;
  /** 행의 "정보" 버튼 — 학생 상세 시트 열기 */
  onOpenStudentAction?: (studentId: string) => void;
  disabled?: boolean;
};

const chipClass = (active: boolean) =>
  `shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
    active ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/70 bg-white/60 text-neutral-700"
  }`;

const selectChipClass =
  "min-w-0 shrink-0 rounded-full border border-neutral-300/70 bg-white/60 px-3 py-1.5 text-xs font-medium text-neutral-700";

export function StudentMultiSelect({
  students,
  selectedIds,
  onChangeAction,
  presets,
  defaultPresetId,
  statusChips = true,
  defaultStatus = "all",
  classes,
  gradeFilter: showGrade = true,
  disabledIds,
  disabledHint,
  badge,
  onOpenStudentAction,
  disabled = false,
}: StudentMultiSelectProps) {
  const [presetId, setPresetId] = useState<string | null>(defaultPresetId ?? presets?.[0]?.id ?? null);
  const [status, setStatus] = useState<StatusFilter>(defaultStatus);
  const [classFilter, setClassFilter] = useState<string>("all");
  const [grade, setGrade] = useState<GradeFilter>("all");
  const [queryText, setQueryText] = useState("");

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const preset = presets?.find((p) => p.id === presetId) ?? null;

  const visible = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    const useFilters = !preset?.ignoreFilters;
    return students.filter((s) => {
      if (preset && !preset.filter(s)) return false;
      if (useFilters) {
        if (statusChips && status !== "all" && s.status !== status) return false;
        if (classes && classFilter === "none" && s.classIds.length > 0) return false;
        if (classes && classFilter !== "all" && classFilter !== "none" && !s.classIds.includes(classFilter)) {
          return false;
        }
        if (showGrade && grade !== "all" && gradeGroup(s.displayGrade) !== grade) return false;
      }
      return studentMatchesSearch(s, q);
    });
  }, [students, preset, statusChips, status, classes, classFilter, showGrade, grade, queryText]);

  const selectable = visible.filter((s) => !disabledIds?.has(s.id));
  const allVisibleSelected = selectable.length > 0 && selectable.every((s) => selected.has(s.id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeAction([...next]);
  };

  const toggleVisible = () => {
    const next = new Set(selected);
    for (const s of selectable) {
      if (allVisibleSelected) next.delete(s.id);
      else next.add(s.id);
    }
    onChangeAction([...next]);
  };

  const presetCounts = useMemo(
    () => new Map((presets ?? []).map((p) => [p.id, students.filter(p.filter).length])),
    [presets, students],
  );

  return (
    <div className="space-y-2.5">
      {presets && presets.length > 0 ? (
        <div className="flex gap-1 rounded-2xl bg-black/[0.04] p-1" role="tablist" aria-label="원생 묶음">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={presetId === p.id}
              onClick={() => setPresetId(p.id)}
              className={`flex-1 rounded-xl py-2 text-xs font-medium transition ${
                presetId === p.id ? "bg-white text-foreground shadow-sm" : "text-neutral-500"
              }`}
            >
              {p.label} {presetCounts.get(p.id) ?? 0}
            </button>
          ))}
        </div>
      ) : null}

      <input
        type="search"
        className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70"
        placeholder="이름·학교·번호로 검색"
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        aria-label="원생 검색"
      />

      {!preset?.ignoreFilters ? (
        <>
          {statusChips ? (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="상태 필터">
              <button
                type="button"
                aria-pressed={status === "all"}
                onClick={() => setStatus("all")}
                className={chipClass(status === "all")}
              >
                전체 상태
              </button>
              {STUDENT_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={status === s}
                  onClick={() => setStatus(s)}
                  className={chipClass(status === s)}
                >
                  {STUDENT_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          ) : null}
          {classes || showGrade ? (
            <div className="flex gap-1.5">
              {classes ? (
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
              {showGrade ? (
                <select
                  value={grade}
                  onChange={(e) => setGrade(e.target.value as GradeFilter)}
                  className={`${selectChipClass} ${grade !== "all" ? "border-[#222] text-foreground" : ""}`}
                  aria-label="학년 필터"
                >
                  {GRADE_FILTERS.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="flex items-center justify-between gap-2 text-xs text-neutral-600">
        <span>
          보이는 {visible.length}명 · <span className="font-semibold text-foreground">선택 {selected.size}명</span>
        </span>
        <button
          type="button"
          disabled={disabled || selectable.length === 0}
          onClick={toggleVisible}
          className="rounded-[8px] border border-neutral-300/70 bg-white/60 px-2.5 py-1.5 text-[11px] font-medium text-neutral-700 disabled:opacity-40"
        >
          {allVisibleSelected ? "보이는 원생 선택 해제" : "보이는 원생 모두 선택"}
        </button>
      </div>

      <ul className="space-y-1.5">
        {visible.length === 0 ? (
          <li className="rounded-2xl border border-dashed border-neutral-300 py-8 text-center text-xs text-neutral-500">
            {students.length === 0 ? "등록된 원생이 없습니다." : "조건에 맞는 원생이 없습니다."}
          </li>
        ) : (
          visible.map((s) => {
            const checked = selected.has(s.id);
            const rowDisabled = disabled || (disabledIds?.has(s.id) === true && !checked);
            return (
              <li
                key={s.id}
                className={`flex items-center gap-2 rounded-2xl border px-3 py-2 ${
                  checked ? "border-[#222]/40 bg-white/70" : "border-neutral-200/80 bg-white/35"
                } ${rowDisabled ? "opacity-55" : ""}`}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={rowDisabled}
                  onClick={() => toggle(s.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 py-0.5 text-left"
                >
                  <span
                    aria-hidden
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] ${
                      checked ? "border-[#222] bg-[#222] text-white" : "border-neutral-400 bg-white"
                    }`}
                  >
                    {checked ? "✓" : ""}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">{s.name || "(이름 없음)"}</span>
                      {s.gradeLabel ? <span className="shrink-0 text-[11px] text-neutral-500">{s.gradeLabel}</span> : null}
                      {s.status !== "enrolled" ? (
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[s.status]}`}
                        >
                          {STUDENT_STATUS_LABELS[s.status]}
                        </span>
                      ) : null}
                    </span>
                    {disabledIds?.has(s.id) && disabledHint && !checked ? (
                      <span className="block text-[10px] text-neutral-500">{disabledHint}</span>
                    ) : null}
                  </span>
                </button>
                {badge ? <span className="shrink-0">{badge(s)}</span> : null}
                {onOpenStudentAction ? (
                  <button
                    type="button"
                    onClick={() => onOpenStudentAction(s.id)}
                    className="shrink-0 rounded-[8px] border border-neutral-300/70 bg-white/60 px-2 py-1 text-[11px] text-neutral-700"
                    aria-label={`${s.name} 정보 보기`}
                  >
                    정보
                  </button>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
