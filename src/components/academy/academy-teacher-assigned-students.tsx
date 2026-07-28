"use client";

import { FirebaseError } from "firebase/app";
import {
  collection,
  deleteField,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { docToStudentRow, type StudentRowVM } from "@/components/academy/academy-student-panel";
import {
  MAX_ASSIGNED_TEACHERS_PER_STUDENT,
  type TeacherRegistrationStatus,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const glassCard = "glass-card";

const miniBtnClass =
  "rounded-[18px] border border-neutral-300/70 bg-white/55 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-white/90 disabled:opacity-45";

function fsErr(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

function sortStudentsByName(a: StudentRowVM, b: StudentRowVM): number {
  return a.name.localeCompare(b.name, "ko");
}

function AssignStudentsModal({
  academyId,
  teacherName,
  open,
  candidates,
  busy,
  error,
  selectedIds,
  toggleId,
  selectAllEligible,
  onClose,
  onConfirm,
}: {
  academyId: string;
  teacherName: string;
  open: boolean;
  candidates: StudentRowVM[];
  busy: boolean;
  error: string | null;
  selectedIds: Set<string>;
  toggleId: (id: string) => void;
  selectAllEligible: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useBodyScrollLock(open);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-students-title"
        className={`${glassCard} flex max-h-[min(88dvh,560px)] w-full max-w-md flex-col p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="assign-students-title" className="shrink-0 text-base font-semibold text-foreground">
          학생 전담 연결
        </h2>
        <p className="mt-2 shrink-0 text-xs leading-relaxed text-neutral-600">
          <span className="font-medium text-foreground">{teacherName}</span> 선생님을 전담에 추가합니다.
          이미 다른 선생님 전담이 있어도 그대로 두고, 이 선생님만{" "}
          <span className="font-medium">추가</span>됩니다(학생당 최대 {MAX_ASSIGNED_TEACHERS_PER_STUDENT}
          명). 학원: <span className="font-mono text-[10px]">{academyId}</span>
        </p>
        <div className="mt-2 flex shrink-0 gap-2">
          <button
            type="button"
            className="text-[11px] font-medium text-sky-800 underline-offset-2 hover:underline"
            onClick={selectAllEligible}
            disabled={busy || candidates.length === 0}
          >
            전체 선택
          </button>
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-white/50 bg-white/20 py-1">
          {candidates.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-neutral-500">연결 가능한 학생이 없습니다.</p>
          ) : (
            <ul className="space-y-0.5">
              {candidates.map((s) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-start gap-2 px-3 py-2 text-xs hover:bg-white/40">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleId(s.id)}
                      disabled={busy}
                      className="mt-0.5 h-4 w-4 rounded border-neutral-400"
                    />
                    <span>
                      <span className="font-medium text-foreground">{s.name}</span>
                      <span className="text-neutral-500"> · 만 {s.age}세</span>
                      {s.assignedTeacherUids.length > 0 ? (
                        <span className="ml-1 text-[10px] text-neutral-600">
                          · 현재 전담 {s.assignedTeacherUids.length}명
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error ? <p className="mt-2 shrink-0 text-sm text-red-700">{error}</p> : null}
        <div className="mt-4 flex shrink-0 flex-wrap justify-end gap-2">
          <button
            ref={ref}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
            onClick={() => onConfirm()}
          >
            {busy ? "저장 중…" : `선택 ${selectedIds.size}명 연결`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 선생님 카드 확장 영역: 전담 학생 목록 + 추가 연결 */
export function TeacherAssignedStudentsBlock({
  academyId,
  teacherId,
  teacherName,
  teacherStatus,
  setNoticeAction,
}: {
  academyId: string;
  teacherId: string;
  teacherName: string;
  teacherStatus: TeacherRegistrationStatus;
  setNoticeAction: (msg: string | null) => void;
}) {
  const [assigned, setAssigned] = useState<StudentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [allStudents, setAllStudents] = useState<StudentRowVM[]>([]);
  const [loadCandidatesBusy, setLoadCandidatesBusy] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignErr, setAssignErr] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [unlinkBusyId, setUnlinkBusyId] = useState<string | null>(null);

  const isActiveTeacher = teacherStatus === "active";

  const loadAssigned = useCallback(async () => {
    if (!isActiveTeacher) {
      setAssigned([]);
      return;
    }
    try {
      const db = getFirebaseDb();
      const studentsCol = collection(db, "academies", academyId, "students");
      const [arrSnap, legSnap] = await Promise.all([
        getDocs(query(studentsCol, where("assignedTeacherUids", "array-contains", teacherId))),
        getDocs(query(studentsCol, where("assignedTeacherUid", "==", teacherId))),
      ]);
      const map = new Map<string, StudentRowVM>();
      for (const d of arrSnap.docs) {
        map.set(d.id, docToStudentRow(d.id, d.data() as Record<string, unknown>));
      }
      for (const d of legSnap.docs) {
        map.set(d.id, docToStudentRow(d.id, d.data() as Record<string, unknown>));
      }
      setAssigned([...map.values()].sort(sortStudentsByName));
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
      setAssigned([]);
    }
  }, [academyId, isActiveTeacher, teacherId]);

  const { refresh: refreshAssigned } = useAcademyListPoll(loadAssigned, [
    academyId,
    teacherId,
    isActiveTeacher,
  ]);

  const openAssignModal = useCallback(async () => {
    setAssignErr(null);
    setSelectedIds(new Set());
    setAssignOpen(true);
    setLoadCandidatesBusy(true);
    try {
      const db = getFirebaseDb();
      const snap = await getDocs(collection(db, "academies", academyId, "students"));
      const list = snap.docs.map((d) =>
        docToStudentRow(d.id, d.data() as Record<string, unknown>),
      );
      setAllStudents(list);
    } catch (e) {
      setAssignErr(fsErr(e));
      setAllStudents([]);
    } finally {
      setLoadCandidatesBusy(false);
    }
  }, [academyId]);

  const candidates = useMemo(() => {
    return allStudents
      .filter((s) => !s.assignedTeacherUids.includes(teacherId))
      .sort(sortStudentsByName);
  }, [allStudents, teacherId]);

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllEligible = useCallback(() => {
    setSelectedIds(new Set(candidates.map((c) => c.id)));
  }, [candidates]);

  const closeAssign = useCallback(() => {
    if (!assignBusy) setAssignOpen(false);
  }, [assignBusy]);

  const confirmAssign = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setAssignErr(null);
    setAssignBusy(true);
    try {
      const ids = [...selectedIds];
      for (const id of ids) {
        const s = allStudents.find((x) => x.id === id);
        if (!s) continue;
        const next = [...new Set([...s.assignedTeacherUids, teacherId])];
        if (next.length > MAX_ASSIGNED_TEACHERS_PER_STUDENT) {
          setAssignErr(
            `「${s.name}」 학생은 전담 선생님이 이미 ${MAX_ASSIGNED_TEACHERS_PER_STUDENT}명입니다. 일부를 먼저 조정해 주세요.`,
          );
          return;
        }
      }
      const db = getFirebaseDb();
      const ts = serverTimestamp();
      for (let i = 0; i < ids.length; i += 450) {
        const chunk = ids.slice(i, i + 450);
        const batch = writeBatch(db);
        for (const id of chunk) {
          const s = allStudents.find((x) => x.id === id);
          const next = s
            ? [...new Set([...s.assignedTeacherUids, teacherId])]
            : [teacherId];
          batch.update(doc(db, "academies", academyId, "students", id), {
            assignedTeacherUids: next,
            assignedTeacherUid: deleteField(),
            updatedAt: ts,
          });
        }
        await batch.commit();
      }
      setNoticeAction(`${selectedIds.size}명의 전담 선생님을 연결했습니다.`);
      setAssignOpen(false);
      setSelectedIds(new Set());
      refreshAssigned();
    } catch (e) {
      setAssignErr(fsErr(e));
    } finally {
      setAssignBusy(false);
    }
  }, [academyId, allStudents, refreshAssigned, selectedIds, setNoticeAction, teacherId]);

  const unlinkStudent = useCallback(
    async (studentId: string) => {
      const s = assigned.find((x) => x.id === studentId);
      const next = (s?.assignedTeacherUids ?? []).filter((t) => t !== teacherId);
      setUnlinkBusyId(studentId);
      setNoticeAction(null);
      try {
        const db = getFirebaseDb();
        await updateDoc(doc(db, "academies", academyId, "students", studentId), {
          assignedTeacherUids: next,
          assignedTeacherUid: deleteField(),
          updatedAt: serverTimestamp(),
        });
        setNoticeAction("이 선생님과의 전담 연결을 해제했습니다.");
        refreshAssigned();
      } catch (e) {
        setNoticeAction(fsErr(e));
      } finally {
        setUnlinkBusyId(null);
      }
    },
    [academyId, assigned, refreshAssigned, setNoticeAction, teacherId],
  );

  if (!isActiveTeacher) {
    return (
      <div className="mb-3 rounded-xl bg-neutral-500/10 px-3 py-2 text-[11px] text-neutral-700 ring-1 ring-neutral-500/15">
        활성 상태인 선생님만 학생 전담을 연결할 수 있습니다.
      </div>
    );
  }

  return (
    <div className="mb-4 border-b border-white/50 pb-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-foreground">전담 학생</h4>
        <button
          type="button"
          className={miniBtnClass}
          onClick={() => void openAssignModal()}
          disabled={loadCandidatesBusy}
        >
          학생 전담 연결
        </button>
      </div>
      {listError ? <p className="text-xs text-red-600">{listError}</p> : null}
      {assigned.length === 0 ? (
        <p className="text-xs text-neutral-500">연결된 전담 학생이 없습니다.</p>
      ) : (
        <ul className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
          {assigned.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-white/60 bg-white/25 px-3 py-2 text-xs"
            >
              <span className="min-w-0">
                <span className="font-medium text-foreground">{s.name}</span>
                <span className="text-neutral-500"> · 만 {s.age}세</span>
              </span>
              <button
                type="button"
                className={miniBtnClass}
                disabled={unlinkBusyId !== null}
                onClick={() => void unlinkStudent(s.id)}
              >
                {unlinkBusyId === s.id ? "…" : "연결 해제"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {assignOpen ? (
        <AssignStudentsModal
          academyId={academyId}
          teacherName={teacherName}
          open={assignOpen}
          candidates={candidates}
          busy={assignBusy || loadCandidatesBusy}
          error={assignErr}
          selectedIds={selectedIds}
          toggleId={toggleId}
          selectAllEligible={selectAllEligible}
          onClose={closeAssign}
          onConfirm={() => void confirmAssign()}
        />
      ) : null}
    </div>
  );
}
