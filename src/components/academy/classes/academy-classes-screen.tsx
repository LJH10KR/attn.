"use client";

import { FirebaseError } from "firebase/app";
import { collection, getDocs } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import { useAcademyShell } from "@/components/academy/academy-shell";
import { ClassAssignSheet } from "@/components/academy/classes/class-assign-sheet";
import { ClassDetailSheet } from "@/components/academy/classes/class-detail-sheet";
import {
  CLASS_STATUS_BADGE_CLASS,
  CLASS_STATUS_LABELS,
  ClassFormSheet,
} from "@/components/academy/classes/class-form-sheet";
import { StudentDetailSheet } from "@/components/academy/student-detail/student-detail-sheet";
import { useStudentDetailParam } from "@/components/academy/student-detail/use-student-detail-param";
import { scheduleSummary } from "@/lib/academy/class-schedule";
import { compareStudentsByName, docToStudent, type StudentVM } from "@/lib/academy/student-row";
import { useAcademyClasses, type AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { useAcademyOptionList } from "@/lib/academy/use-academy-option-list";
import { teacherSummary, useClassTeacherCandidates } from "@/lib/academy/use-class-teacher-candidates";
import { academyStudentsPath, type AcademyClassStatus } from "@/lib/firebase/attn-schema";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { useQueryFlag } from "@/lib/ui/use-query-flag";

type StatusFilter = AcademyClassStatus | "all";
const STATUS_FILTERS: AcademyClassStatus[] = ["active", "preparing", "ended"];

type FormState = { kind: "create" } | { kind: "edit"; cls: AcademyClassBrief } | null;

const chipClass = (active: boolean) =>
  `shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
    active ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/70 bg-white/60 text-neutral-700"
  }`;

const smallBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-neutral-300/70 bg-white/70 text-xs text-neutral-700 disabled:opacity-30";

/**
 * 운영 › 반 관리(9-4) — 반 목록(정렬 순서·상태 필터·원생 수/정원·선생님·강의실·시간), ↑↓ 순서 모드,
 * 반 상세 시트(원생 목록·수정·배정·삭제), 추가·수정 시트, 원생 배정 시트. 원생을 누르면 학생 상세 시트.
 * 원생 수는 저장하지 않으므로 학생 목록을 한 번 읽어 `classIds`로 센다(반 권한은 학생 읽기 가능).
 */
export function AcademyClassesScreen() {
  const { academyId, permissions } = useAcademyShell();
  const detail = useStudentDetailParam();
  const { classes, loading: classesLoading, error: classesError, retry: retryClasses } = useAcademyClasses(academyId);
  const [students, setStudents] = useState<StudentVM[]>([]);
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  /** 마지막 읽기가 성공했는지 — 배정 시트는 이때만 연다 */
  const [studentsOk, setStudentsOk] = useState(false);
  const [studentsError, setStudentsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [reorderDraft, setReorderDraft] = useState<AcademyClassBrief[] | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [openClassId, setOpenClassId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  // 2-M 홈 "시작하기" [반 추가] — `?new=1`이면 만들기 시트를 바로 연다
  useQueryFlag("new", "1", permissions.can("operations.classes"), () => setForm({ kind: "create" }));
  const [assignClass, setAssignClass] = useState<AcademyClassBrief | null>(null);
  const { items: rooms, save: saveRooms } = useAcademyOptionList(academyId, "rooms");
  const teachers = useClassTeacherCandidates(academyId, permissions.viewer?.uid ?? null);

  const loadStudents = useCallback(async () => {
    try {
      const snap = await getDocs(collection(getFirebaseDb(), academyStudentsPath(academyId)));
      const list = snap.docs.map((d) => docToStudent(d.id, d.data() as Record<string, unknown>));
      list.sort(compareStudentsByName);
      setStudents(list);
      setStudentsOk(true);
      setStudentsError(null);
    } catch {
      setStudentsOk(false);
      setStudentsError("원생 목록을 불러오지 못했습니다.");
    } finally {
      setStudentsLoaded(true);
    }
  }, [academyId]);

  const { refresh: refreshStudents, busy: studentsBusy } = useAcademyListPoll(loadStudents, [academyId]);

  const membersByClass = useMemo(() => {
    const m = new Map<string, StudentVM[]>();
    for (const s of students) {
      for (const id of s.classIds) {
        const list = m.get(id);
        if (list) list.push(s);
        else m.set(id, [s]);
      }
    }
    return m;
  }, [students]);

  const roomLabelById = useMemo(() => new Map(rooms.map((r) => [r.id, r.label])), [rooms]);
  const roomUsage = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of classes) if (c.roomId) out[c.roomId] = (out[c.roomId] ?? 0) + 1;
    return out;
  }, [classes]);
  const classById = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);

  const statusCounts = useMemo(() => {
    const m: Record<AcademyClassStatus, number> = { active: 0, preparing: 0, ended: 0 };
    for (const c of classes) m[c.status] += 1;
    return m;
  }, [classes]);
  const filtered = statusFilter === "all" ? classes : classes.filter((c) => c.status === statusFilter);

  const openClass = openClassId ? classById.get(openClassId) ?? null : null;
  // 다른 곳에서 반이 삭제되면 상세 시트를 닫는다
  useEffect(() => {
    if (openClassId && !classesLoading && !classesError && !classById.has(openClassId)) setOpenClassId(null);
  }, [openClassId, classesLoading, classesError, classById]);

  const studentOpen = detail.studentId !== null;
  const roomLabel = (c: AcademyClassBrief) =>
    c.roomId ? roomLabelById.get(c.roomId) ?? "강의실 미지정" : null;
  const teacherNamesOf = (c: AcademyClassBrief) => teachers.sortUids(c.teacherUids).map(teachers.teacherName);

  const startReorder = () => {
    setReorderError(null);
    setReorderDraft(classes);
  };

  const moveDraft = (index: number, delta: -1 | 1) => {
    setReorderDraft((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const saveReorder = async () => {
    if (!reorderDraft) return;
    setReorderBusy(true);
    setReorderError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "reorderClasses")({
        academyId,
        orderedIds: reorderDraft.map((c) => c.id),
      });
      setReorderDraft(null);
      setNotice("반 순서를 저장했습니다.");
    } catch (e) {
      const message = e instanceof FirebaseError && e.message ? e.message : "순서를 저장하지 못했습니다.";
      setReorderError(message);
      // 반 목록이 바뀐 경우 — 최신 목록으로 다시 맞춘다
      if (e instanceof FirebaseError && e.code === "functions/failed-precondition") setReorderDraft(classes);
    } finally {
      setReorderBusy(false);
    }
  };

  const onDetailChanged = useCallback(
    (message: string) => {
      setNotice(message);
      refreshStudents();
    },
    [refreshStudents],
  );

  if (classesError) {
    return (
      <div className="glass-card space-y-3 px-4 py-10 text-center">
        <p className="break-keep text-sm text-red-800">{classesError}</p>
        <button
          type="button"
          onClick={retryClasses}
          className="rounded-2xl border border-neutral-300/80 bg-white/60 px-4 py-2 text-sm"
        >
          다시 시도
        </button>
      </div>
    );
  }

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
      {studentsError ? (
        <p className="break-keep rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {studentsError} 원생 수가 비어 보일 수 있습니다.{" "}
          <button type="button" className="underline" onClick={refreshStudents}>
            다시 시도
          </button>
        </p>
      ) : null}

      {reorderDraft ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="break-keep text-sm text-neutral-600">↑↓로 반 목록 순서를 바꿉니다(전체 반).</p>
          </div>
          {reorderError ? (
            <p className="break-keep text-xs text-red-700" role="alert">
              {reorderError}
            </p>
          ) : null}
          <ul className="space-y-2">
            {reorderDraft.map((c, i) => (
              <li key={c.id} className="glass-card flex items-center gap-2 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{c.name}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${CLASS_STATUS_BADGE_CLASS[c.status]}`}
                >
                  {CLASS_STATUS_LABELS[c.status]}
                </span>
                <button
                  type="button"
                  className={smallBtn}
                  disabled={reorderBusy || i === 0}
                  onClick={() => moveDraft(i, -1)}
                  aria-label={`${c.name} 위로`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={smallBtn}
                  disabled={reorderBusy || i === reorderDraft.length - 1}
                  onClick={() => moveDraft(i, 1)}
                  aria-label={`${c.name} 아래로`}
                >
                  ↓
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 pb-8">
            <button
              type="button"
              disabled={reorderBusy}
              onClick={() => setReorderDraft(null)}
              className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="button"
              disabled={reorderBusy}
              onClick={() => void saveReorder()}
              className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {reorderBusy ? "저장 중…" : "순서 저장"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-neutral-600">
              <span className="font-semibold text-foreground">{filtered.length}</span>개
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setForm({ kind: "create" })}
                className="rounded-[8px] bg-[#222] px-3 py-2 text-xs font-medium text-white"
              >
                + 반 추가
              </button>
              <button
                type="button"
                onClick={startReorder}
                disabled={classes.length < 2}
                className="rounded-[8px] border border-neutral-300/70 bg-white/55 px-3 py-2 text-xs font-medium text-neutral-700 disabled:opacity-40"
              >
                순서 바꾸기
              </button>
              <AcademyPanelRefreshButton busy={studentsBusy} onRefreshAction={refreshStudents} />
            </div>
          </div>

          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="반 상태 필터">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={statusFilter === s}
                onClick={() => setStatusFilter(s)}
                className={chipClass(statusFilter === s)}
              >
                {CLASS_STATUS_LABELS[s]} {statusCounts[s]}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={statusFilter === "all"}
              onClick={() => setStatusFilter("all")}
              className={chipClass(statusFilter === "all")}
            >
              전체 {classes.length}
            </button>
          </div>

          <ul className="space-y-2 pb-8">
            {classesLoading ? (
              <li className="glass-card py-10 text-center text-sm text-neutral-400">불러오는 중…</li>
            ) : filtered.length === 0 ? (
              <li className="glass-card break-keep px-4 py-10 text-center text-sm text-neutral-500">
                {classes.length === 0
                  ? "등록된 반이 없습니다. 1:1 수업도 1인 반으로 만들어 주세요."
                  : "이 상태의 반이 없습니다."}
              </li>
            ) : (
              filtered.map((c) => {
                const count = membersByClass.get(c.id)?.length ?? 0;
                const over = studentsOk && c.capacity !== null && count > c.capacity;
                const schedule = scheduleSummary(c.schedule);
                const room = roomLabel(c);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setOpenClassId(c.id)}
                      className="glass-card block w-full px-4 py-3 text-left transition hover:bg-white/45 active:bg-white/55"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate font-medium text-foreground">{c.name}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${CLASS_STATUS_BADGE_CLASS[c.status]}`}
                        >
                          {CLASS_STATUS_LABELS[c.status]}
                        </span>
                        <span
                          className={`ml-auto shrink-0 text-xs ${over ? "font-semibold text-amber-800" : "text-neutral-600"}`}
                        >
                          {studentsLoaded ? `원생 ${count}` : "원생 …"}
                          {c.capacity !== null ? ` / ${c.capacity}` : ""}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-neutral-600">
                        {teacherSummary(teachers.sortUids(c.teacherUids), teachers.teacherName)}
                        {room ? ` · ${room}` : ""}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500">{schedule || "수업 시간 미정"}</p>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </>
      )}

      {openClass ? (
        <ClassDetailSheet
          key={openClass.id}
          academyId={academyId}
          cls={openClass}
          members={membersByClass.get(openClass.id) ?? []}
          studentsReady={studentsLoaded && studentsOk}
          studentsError={studentsError}
          teacherNames={teacherNamesOf(openClass)}
          roomLabel={roomLabel(openClass)}
          permissions={permissions}
          escapeBlocked={studentOpen || form !== null || assignClass !== null}
          onEditAction={() => setForm({ kind: "edit", cls: openClass })}
          onAssignAction={() => {
            if (studentsLoaded && studentsOk) setAssignClass(openClass);
          }}
          onOpenStudentAction={(id) => detail.open(id)}
          onRetryStudentsAction={refreshStudents}
          onDeletedAction={(message) => {
            setOpenClassId(null);
            setNotice(message);
            refreshStudents();
          }}
          onCloseAction={() => setOpenClassId(null)}
        />
      ) : null}

      {form ? (
        <ClassFormSheet
          academyId={academyId}
          target={form.kind === "edit" ? form.cls : null}
          rooms={rooms}
          onSaveRoomsAction={saveRooms}
          roomUsage={roomUsage}
          candidates={teachers.candidates}
          candidatesLoading={teachers.loading}
          candidatesError={teachers.error}
          onReloadCandidatesAction={teachers.reload}
          escapeBlocked={studentOpen}
          onCloseAction={() => setForm(null)}
          onSavedAction={(message, classId, status) => {
            const created = form.kind === "create";
            setForm(null);
            setNotice(message);
            // 새 반이 지금 필터에 안 보이면 그 상태로 바꾼다
            if (created && statusFilter !== "all" && statusFilter !== status) setStatusFilter(status);
            if (created && classId) setOpenClassId(classId);
          }}
        />
      ) : null}

      {assignClass ? (
        <ClassAssignSheet
          academyId={academyId}
          cls={assignClass}
          students={students}
          classNameOf={(id) => classById.get(id)?.name ?? null}
          onOpenStudentAction={(id) => detail.open(id)}
          escapeBlocked={studentOpen}
          onReloadStudentsAction={refreshStudents}
          onCloseAction={() => setAssignClass(null)}
          onDoneAction={(message) => {
            setAssignClass(null);
            setNotice(message);
          }}
        />
      ) : null}

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
    </div>
  );
}
