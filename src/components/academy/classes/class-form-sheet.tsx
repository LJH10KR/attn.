"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClassScheduleEditor } from "@/components/academy/classes/class-schedule-editor";
import { EditableOptionSelect } from "@/components/ui/editable-option-select";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  expandScheduleGroups,
  groupSchedule,
  sameSchedule,
  scheduleBlockingError,
  type ScheduleGroup,
} from "@/lib/academy/class-schedule";
import type { AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import type { ClassTeacherCandidate } from "@/lib/academy/use-class-teacher-candidates";
import type { AcademyClassStatus, AcademyOptionItem } from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const NAME_MAX = 40;
const MAX_TEACHERS = 10;
const CAPACITY_MAX = 500;

export const CLASS_STATUS_LABELS: Record<AcademyClassStatus, string> = {
  active: "운영중",
  preparing: "준비중",
  ended: "종강",
};

export const CLASS_STATUS_BADGE_CLASS: Record<AcademyClassStatus, string> = {
  active: "bg-emerald-500/15 text-emerald-900",
  preparing: "bg-sky-500/15 text-sky-900",
  ended: "bg-neutral-500/15 text-neutral-700",
};

const CLASS_STATUSES: AcademyClassStatus[] = ["active", "preparing", "ended"];

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-sm text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-neutral-600";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

type ClassFormSheetProps = {
  academyId: string;
  /** null이면 새 반 — 수정이면 시트를 연 순간의 값이 비교 기준(이후 실시간 값으로 바뀌지 않음) */
  target: AcademyClassBrief | null;
  rooms: AcademyOptionItem[];
  onSaveRoomsAction?: (items: { id?: string; label: string }[]) => Promise<AcademyOptionItem[]>;
  /** 강의실 삭제 확인에 쓰는 사용 반 수 */
  roomUsage: Record<string, number>;
  candidates: ClassTeacherCandidate[];
  /** 후보를 읽는 중 — 그동안은 "알 수 없는 계정" 줄을 만들지 않는다 */
  candidatesLoading: boolean;
  candidatesError: string | null;
  onReloadCandidatesAction: () => void;
  /** 학생 상세 시트가 위에 열려 있으면 Esc 무시 */
  escapeBlocked?: boolean;
  onCloseAction: () => void;
  onSavedAction: (message: string, classId: string, status: AcademyClassStatus) => void;
};

/**
 * 반 추가·수정 전체 화면 시트 — 저장은 `saveClass`(권한 `operations.classes`).
 * 수정은 **바뀐 필드만** 보낸다(서버도 빠진 필드 = 기존 값 유지). 비교 기준은 시트를 연 순간의 반 값으로 고정 —
 * 시트를 열어 둔 사이 다른 곳에서 바꾼 선생님·시간을 이름만 고친 저장이 되돌리지 않게.
 */
export function ClassFormSheet({
  academyId,
  target,
  rooms,
  onSaveRoomsAction,
  roomUsage,
  candidates,
  candidatesLoading,
  candidatesError,
  onReloadCandidatesAction,
  escapeBlocked = false,
  onCloseAction,
  onSavedAction,
}: ClassFormSheetProps) {
  useBodyScrollLock(true);
  const [base] = useState<AcademyClassBrief | null>(() => target);
  const [name, setName] = useState(base?.name ?? "");
  const [status, setStatus] = useState<AcademyClassStatus>(base?.status ?? "active");
  const [groups, setGroups] = useState<ScheduleGroup[]>(() => groupSchedule(base?.schedule ?? []));
  const [teacherUids, setTeacherUids] = useState<string[]>(base?.teacherUids ?? []);
  const [roomId, setRoomId] = useState<string | null>(base?.roomId ?? null);
  const [capacity, setCapacity] = useState(base?.capacity != null ? String(base.capacity) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !escapeBlocked) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, escapeBlocked, onCloseAction]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);

  const roomIds = useMemo(() => new Set(rooms.map((r) => r.id)), [rooms]);
  const roomMissing = Boolean(roomId && !roomIds.has(roomId));
  const baseTeachers = useMemo(() => new Set(base?.teacherUids ?? []), [base]);
  const candidateUids = useMemo(() => new Set(candidates.map((c) => c.uid)), [candidates]);
  /**
   * 반에 있지만 후보에 없는 uid(지운 계정 등) — 뺄 수만 있음.
   * 후보를 읽는 중·읽기 실패 때는 판단할 수 없으므로 만들지 않는다(기존 선생님이 잠깐 "알 수 없는 계정"으로 보이지 않게).
   */
  const candidatesReady = !candidatesLoading && !candidatesError;
  const unknownUids = candidatesReady ? (base?.teacherUids ?? []).filter((u) => !candidateUids.has(u)) : [];

  const toggleTeacher = (uid: string) => {
    setTeacherUids((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]));
  };

  const validate = (): { error: string } | { capacity: number | null } => {
    const n = name.trim();
    if (!n || n.length > NAME_MAX) return { error: `반 이름을 1~${NAME_MAX}자로 입력해 주세요.` };
    const scheduleError = scheduleBlockingError(groups);
    if (scheduleError) return { error: scheduleError };
    if (teacherUids.length > MAX_TEACHERS) return { error: `반 선생님은 최대 ${MAX_TEACHERS}명까지 지정할 수 있습니다.` };
    const c = capacity.trim();
    if (!c) return { capacity: null };
    const num = Number(c);
    if (!Number.isInteger(num) || num < 1 || num > CAPACITY_MAX) {
      return { error: `정원은 1~${CAPACITY_MAX}명으로 입력하거나 비워 두세요.` };
    }
    return { capacity: num };
  };

  const onSubmit = async () => {
    const v = validate();
    if ("error" in v) {
      setError(v.error);
      return;
    }
    const schedule = expandScheduleGroups(groups);
    const sortedTeachers = [...teacherUids].sort();
    const fields: Record<string, unknown> = {};
    if (!base) {
      Object.assign(fields, {
        name: name.trim(),
        status,
        schedule,
        teacherUids: sortedTeachers,
        roomId,
        capacity: v.capacity,
      });
    } else {
      if (name.trim() !== base.name) fields.name = name.trim();
      if (status !== base.status) fields.status = status;
      if (!sameSchedule(schedule, base.schedule)) fields.schedule = schedule;
      if (JSON.stringify(sortedTeachers) !== JSON.stringify([...base.teacherUids].sort())) {
        fields.teacherUids = sortedTeachers;
      }
      if (roomId !== base.roomId) fields.roomId = roomId;
      if (v.capacity !== base.capacity) fields.capacity = v.capacity;
      if (Object.keys(fields).length === 0) {
        onSavedAction("바뀐 내용이 없습니다.", base.id, base.status);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "saveClass")({
        academyId,
        classId: base?.id ?? null,
        ...fields,
      });
      const classId = (res.data as { classId?: string }).classId ?? base?.id ?? "";
      onSavedAction(
        base ? `${name.trim()} 반을 저장했습니다.` : `${name.trim()} 반을 추가했습니다.`,
        classId,
        status,
      );
    } catch (e) {
      setError(errMsg(e, "저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[160] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-form-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between">
            <h1 id="class-form-title" className="text-lg font-semibold text-foreground">
              {base ? "반 수정" : "반 추가"}
            </h1>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy}
              className="text-sm text-neutral-500 hover:text-foreground disabled:opacity-50"
            >
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-5 px-4 py-5">
            <div>
              <label htmlFor="cf-name" className={labelClass}>
                반 이름 <span className="text-red-600">*</span>
              </label>
              <input
                id="cf-name"
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                disabled={busy}
                placeholder="예: 초등 수학 A반, 1:1 김민준"
              />
            </div>

            <fieldset>
              <legend className={labelClass}>상태</legend>
              <div className="grid grid-cols-3 gap-2" role="radiogroup">
                {CLASS_STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={status === s}
                    disabled={busy}
                    onClick={() => setStatus(s)}
                    className={`rounded-2xl border py-2.5 text-sm font-medium transition ${
                      status === s
                        ? "border-[#222] bg-[#222] text-white"
                        : "border-neutral-300/70 bg-white/60 text-neutral-700"
                    }`}
                  >
                    {CLASS_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
              {status === "ended" ? (
                <p className="mt-2 break-keep text-[11px] text-neutral-500">
                  종강하면 반 선생님의 담당 학생에서 빠지고, 원생을 새로 추가할 수 없습니다. 원생 배정은 남아 있어 다시
                  열면 복구됩니다.
                </p>
              ) : null}
            </fieldset>

            <section>
              <span className={labelClass}>수업 시간</span>
              <ClassScheduleEditor
                groups={groups}
                onChangeAction={(next) => {
                  setGroups(next);
                  // 수업 시간 오류는 편집기가 바로 보여 주므로, 저장 때 띄운 문구는 고치는 순간 지운다
                  setError(null);
                }}
                disabled={busy}
              />
            </section>

            <section>
              <div className="mb-1 flex items-center justify-between">
                <span className={labelClass}>선생님</span>
                <span className="text-[11px] text-neutral-400">
                  {teacherUids.length}/{MAX_TEACHERS}
                </span>
              </div>
              {candidatesError ? (
                <div className="rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-800">
                  {candidatesError}{" "}
                  <button type="button" className="underline" onClick={onReloadCandidatesAction}>
                    다시 시도
                  </button>
                </div>
              ) : candidatesLoading ? (
                <p className="rounded-2xl border border-neutral-200/80 bg-white/35 px-3 py-2.5 text-xs text-neutral-500">
                  선생님 목록을 불러오는 중…
                </p>
              ) : null}
              <ul className="space-y-1.5">
                {candidates.map((c) => {
                  const checked = teacherUids.includes(c.uid);
                  // 비활성·퇴사 직원은 새로 고를 수 없음 — 원래 반에 있던 직원은 빼거나 다시 넣을 수 있음
                  const lockedOut = c.blocked && !baseTeachers.has(c.uid);
                  const full = !checked && teacherUids.length >= MAX_TEACHERS;
                  return (
                    <li key={c.uid}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        disabled={busy || lockedOut || full}
                        onClick={() => toggleTeacher(c.uid)}
                        className={`flex w-full items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left disabled:opacity-55 ${
                          checked ? "border-[#222]/40 bg-white/70" : "border-neutral-200/80 bg-white/35"
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] ${
                            checked ? "border-[#222] bg-[#222] text-white" : "border-neutral-400 bg-white"
                          }`}
                        >
                          {checked ? "✓" : ""}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground">{c.label}</span>
                          {c.blocked ? (
                            <span className="block break-keep text-[10px] text-neutral-500">
                              {checked ? "지금은 이 반을 볼 수 없습니다" : "새로 지정할 수 없습니다"}
                            </span>
                          ) : null}
                        </span>
                        {c.badge ? (
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              c.blocked ? "bg-red-500/10 text-red-800" : "bg-neutral-500/15 text-neutral-700"
                            }`}
                          >
                            {c.badge}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
                {unknownUids.map((uid) => {
                  const checked = teacherUids.includes(uid);
                  return (
                    <li key={uid}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        disabled={busy || !checked}
                        onClick={() => toggleTeacher(uid)}
                        className="flex w-full items-center gap-2.5 rounded-2xl border border-neutral-200/80 bg-white/35 px-3 py-2.5 text-left disabled:opacity-55"
                      >
                        <span
                          aria-hidden
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] ${
                            checked ? "border-[#222] bg-[#222] text-white" : "border-neutral-400 bg-white"
                          }`}
                        >
                          {checked ? "✓" : ""}
                        </span>
                        <span className="text-sm text-neutral-600">알 수 없는 계정 (빼기만 가능)</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1.5 break-keep text-[11px] text-neutral-500">
                원장과 계정이 있는 직원만 지정할 수 있습니다. 지정된 선생님은 선생님 화면에서 이 반 원생을 봅니다.
              </p>
            </section>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className={labelClass}>강의실</span>
                <EditableOptionSelect
                  noun="강의실"
                  value={roomId}
                  onChangeAction={setRoomId}
                  items={rooms}
                  onSaveItemsAction={onSaveRoomsAction}
                  usageCountById={roomUsage}
                  placeholder={roomMissing ? "강의실 미지정" : "강의실 선택"}
                  disabled={busy}
                />
              </div>
              <div>
                <label htmlFor="cf-capacity" className={labelClass}>
                  정원
                </label>
                <input
                  id="cf-capacity"
                  inputMode="numeric"
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                  className={inputClass}
                  disabled={busy}
                  placeholder="제한 없음"
                />
              </div>
            </div>

            {error ? (
              <p ref={errorRef} className="break-keep text-sm text-red-700" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </main>

        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto flex max-w-lg">
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
