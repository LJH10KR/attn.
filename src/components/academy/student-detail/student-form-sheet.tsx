"use client";

import { FirebaseError } from "firebase/app";
import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useRef, useState } from "react";
import { EditableOptionSelect } from "@/components/ui/editable-option-select";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { ModalPortal } from "@/components/ui/modal-portal";
import { readStudentGuardians, type StudentVM } from "@/lib/academy/student-row";
import {
  GRADE_CODES,
  gradeLabel,
  STUDENT_STATUSES,
  STUDENT_STATUS_LABELS,
  type DisplayGrade,
  type StudentStatus,
} from "@/lib/academy/student-profile";
import type { AcademyOptionItem, StudentGuardian } from "@/lib/firebase/attn-schema";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { digitsOnly, formatKrPhoneDisplay, getKrPhoneValidationError } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const MAX_GUARDIANS = 5;
const NAME_MAX = 40;
const SCHOOL_MAX = 40;
const GUARDIAN_NAME_MAX = 30;
const MEMO_MAX = 1000;

/** 서버 `LINKED_GUARDIAN_REMOVE_MSG`(functions/src/lib/student-guardians.ts)의 앞부분 */
const LINKED_GUARDIAN_REJECT_TEXT = "앱에 연결된 보호자입니다";

/** 연결된 칸 번호를 고칠 때 바로 아래 안내(2-L L3-1-2) */
export const LINKED_PHONE_CHANGE_HINT =
  "앱에 연결된 보호자예요. 같은 분의 번호가 바뀐 경우에만 고치고, 다른 분으로 바꾸려면 학부모 관리에서 연결을 해제한 뒤 새 보호자로 추가해 주세요.";
/** 연결된 칸 번호를 바꿔 저장한 뒤 토스트 — 서버가 학부모 앱에 번호 확인 안내(푸시 + 안내 창)를 남김 */
export const PHONE_NOTICE_SENT_TOAST = "학부모 앱에 번호 확인 안내를 보냈어요.";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-sm text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 disabled:opacity-60";

const labelClass = "mb-1 block text-xs font-medium text-neutral-600";

/** 편집 중인 보호자 — 새 항목은 id 없이 저장(서버가 발급) */
type GuardianDraft = {
  key: string;
  id: string | null;
  relationId: string | null;
  name: string;
  phone: string;
  isPrimary: boolean;
  linkedParentUid: string | null;
  /** 연결된 항목의 처음 번호 — 바뀌면 안내 */
  originalPhone: string;
};

let draftSeq = 0;
function nextKey(): string {
  draftSeq += 1;
  return `g-new-${draftSeq}`;
}

function toDrafts(list: readonly StudentGuardian[]): GuardianDraft[] {
  return list.map((g) => ({
    key: g.id,
    id: g.id,
    relationId: g.relationId,
    name: g.name ?? "",
    phone: formatKrPhoneDisplay(g.phone),
    isPrimary: g.isPrimary,
    linkedParentUid: g.linkedParentUid,
    originalPhone: formatKrPhoneDisplay(g.phone),
  }));
}

/** 비교용 — 서버처럼 대표가 없으면 첫 번째를 대표로 본다 */
function comparable(list: readonly GuardianDraft[]): string {
  const hasPrimary = list.some((g) => g.isPrimary);
  return JSON.stringify(
    list.map((g, i) => [
      g.id,
      g.relationId,
      g.name.trim() || null,
      digitsOnly(g.phone),
      hasPrimary ? g.isPrimary : i === 0,
    ]),
  );
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

export type StudentNoteState = { loaded: true; memo: string } | { loaded: false };

type StudentFormSheetProps = {
  academyId: string;
  /** null이면 새 원생 추가 */
  target: StudentVM | null;
  /** 메모 — 불러오지 못했으면 메모를 보내지 않는다(저장으로 지워지지 않게) */
  note: StudentNoteState;
  relations: AcademyOptionItem[];
  onSaveRelationsAction?: (items: { id?: string; label: string }[]) => Promise<AcademyOptionItem[]>;
  onCloseAction: () => void;
  onSavedAction: (message: string, studentId: string) => void;
};

/**
 * 원생 추가·수정 전체 화면 시트 — 저장은 `saveStudent`(권한 `operations.students`).
 * 수정 때 보호자 목록·메모는 **처음 값과 달라졌을 때만** 보낸다(서버는 생략 = 변경 없음):
 * 시트를 열어 둔 사이 학부모 관리가 연결하며 추가한 보호자나 다른 직원이 고친 메모를 예전 값으로 덮지 않게.
 */
export function StudentFormSheet({
  academyId,
  target,
  note,
  relations,
  onSaveRelationsAction,
  onCloseAction,
  onSavedAction,
}: StudentFormSheetProps) {
  useBodyScrollLock(true);
  const [name, setName] = useState(target?.name ?? "");
  const [grade, setGrade] = useState<DisplayGrade | "">(target?.displayGrade ?? "");
  const [school, setSchool] = useState(target?.school ?? "");
  const [phone, setPhone] = useState(formatKrPhoneDisplay(target?.phone));
  const [status, setStatus] = useState<StudentStatus>(target?.status ?? "enrolled");
  const [firstAttendedOn, setFirstAttendedOn] = useState(target?.firstAttendedOn ?? "");
  const [baseGuardians, setBaseGuardians] = useState<GuardianDraft[]>(() => toDrafts(target?.guardians ?? []));
  const [guardians, setGuardians] = useState<GuardianDraft[]>(baseGuardians);
  // 메모 기준값은 시트를 연 순간의 값으로 고정 — 이후 note가 바뀌어도 입력값·비교 기준이 어긋나지 않게.
  // null(읽지 못함)이면 메모를 보내지 않고 입력란도 보이지 않는다.
  const [memoBase] = useState<string | null>(() => (note.loaded ? note.memo : null));
  const [memo, setMemo] = useState(memoBase ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCloseAction]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);

  const gradeOptions = useMemo(() => {
    const codes: DisplayGrade[] = [...GRADE_CODES];
    // 졸업은 저장 값이 졸업으로 보일 때만 그대로 둘 수 있다(서버 resolveGrade)
    if (target?.displayGrade === "graduated") codes.push("graduated");
    return codes;
  }, [target?.displayGrade]);

  const relationIds = useMemo(() => new Set(relations.map((r) => r.id)), [relations]);

  const updateGuardian = (key: string, patch: Partial<GuardianDraft>) => {
    setGuardians((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  };

  const setPrimary = (key: string) => {
    setGuardians((prev) => prev.map((g) => ({ ...g, isPrimary: g.key === key })));
  };

  const addGuardian = () => {
    setGuardians((prev) => [
      ...prev,
      {
        key: nextKey(),
        id: null,
        relationId: null,
        name: "",
        phone: "",
        isPrimary: prev.length === 0,
        linkedParentUid: null,
        originalPhone: "",
      },
    ]);
  };

  const removeGuardian = (key: string) => {
    setGuardians((prev) => {
      const next = prev.filter((g) => g.key !== key);
      if (next.length > 0 && !next.some((g) => g.isPrimary)) next[0] = { ...next[0]!, isPrimary: true };
      return next;
    });
  };

  const validate = (): string | null => {
    const n = name.trim();
    if (!n || n.length > NAME_MAX) return `이름을 1~${NAME_MAX}자로 입력해 주세요.`;
    if (!grade) return "학년을 선택해 주세요.";
    if (school.trim().length > SCHOOL_MAX) return `학교는 ${SCHOOL_MAX}자 이하로 입력해 주세요.`;
    if (phone.trim()) {
      const e = getKrPhoneValidationError(phone);
      if (e) return `학생 번호: ${e}`;
    }
    const seen = new Set<string>();
    for (const [i, g] of guardians.entries()) {
      const e = getKrPhoneValidationError(g.phone);
      if (e) return `보호자 ${i + 1}: ${e}`;
      const d = digitsOnly(g.phone);
      if (seen.has(d)) return "같은 번호의 보호자가 두 번 들어 있습니다.";
      seen.add(d);
      if (g.name.trim().length > GUARDIAN_NAME_MAX) {
        return `보호자 이름은 ${GUARDIAN_NAME_MAX}자 이하로 입력해 주세요.`;
      }
    }
    if (memo.length > MEMO_MAX) return `메모는 ${MEMO_MAX}자 이하로 입력해 주세요.`;
    return null;
  };

  /** 거부된 저장 뒤 학생 문서의 최신 보호자 목록으로 다시 맞춤 */
  const reloadGuardians = async (): Promise<boolean> => {
    if (!target) return false;
    try {
      const snap = await getDoc(doc(getFirebaseDb(), "academies", academyId, "students", target.id));
      const latest = toDrafts(readStudentGuardians(snap.get("guardians")));
      setBaseGuardians(latest);
      setGuardians(latest);
      return true;
    } catch {
      return false;
    }
  };

  const onSubmit = async () => {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    const guardiansChanged = !target || comparable(guardians) !== comparable(baseGuardians);
    const memoChanged = memoBase !== null && memo.trim() !== memoBase.trim();
    setBusy(true);
    setError(null);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "saveStudent");
      const res = await fn({
        academyId,
        studentId: target?.id ?? null,
        name: name.trim(),
        grade,
        school: school.trim(),
        phone: phone.trim(),
        status,
        firstAttendedOn: firstAttendedOn || null,
        ...(guardiansChanged
          ? {
              guardians: guardians.map((g) => ({
                id: g.id,
                relationId: g.relationId,
                name: g.name.trim(),
                phone: g.phone,
                isPrimary: g.isPrimary,
              })),
            }
          : {}),
        ...(memoChanged ? { memo: memo.trim() } : {}),
      });
      const saved = res.data as { studentId?: string; phoneNoticeCount?: number };
      const studentId = saved.studentId ?? target?.id ?? "";
      onSavedAction(
        (saved.phoneNoticeCount ?? 0) > 0
          ? PHONE_NOTICE_SENT_TOAST
          : target
            ? `${name.trim()} 원생 정보를 저장했습니다.`
            : `${name.trim()} 원생을 추가했습니다.`,
        studentId,
      );
    } catch (e) {
      const message = errMsg(e, "저장하지 못했습니다.");
      // 연결된 항목을 지우지 않았는데 거부 → 시트를 연 사이 다른 곳(학부모 관리)에서 연결된 보호자가 생김
      const removedLinked = baseGuardians.some(
        (b) => b.linkedParentUid && !guardians.some((g) => g.id === b.id),
      );
      if (message.includes(LINKED_GUARDIAN_REJECT_TEXT) && !removedLinked && (await reloadGuardians())) {
        setError("다른 곳에서 보호자 정보가 바뀌었습니다. 확인 후 다시 저장해 주세요.");
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[205] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-form-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between">
            <h1 id="student-form-title" className="text-lg font-semibold text-foreground">
              {target ? "원생 정보 수정" : "원생 추가"}
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
              <label htmlFor="sf-name" className={labelClass}>
                이름 <span className="text-red-600">*</span>
              </label>
              <input
                id="sf-name"
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                disabled={busy}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="sf-grade" className={labelClass}>
                  학년 <span className="text-red-600">*</span>
                </label>
                <select
                  id="sf-grade"
                  value={grade}
                  onChange={(e) => setGrade(e.target.value as DisplayGrade | "")}
                  className={inputClass}
                  disabled={busy}
                >
                  <option value="">선택</option>
                  {gradeOptions.map((g) => (
                    <option key={g} value={g}>
                      {gradeLabel(g)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="sf-school" className={labelClass}>
                  학교
                </label>
                <input
                  id="sf-school"
                  value={school}
                  maxLength={SCHOOL_MAX}
                  onChange={(e) => setSchool(e.target.value)}
                  className={inputClass}
                  disabled={busy}
                />
              </div>
            </div>
            <p className="-mt-2 break-keep text-[11px] text-neutral-500">
              학년은 매년 1월 1일에 자동으로 올라갑니다(미취학·성인·기타 제외).
            </p>

            <div>
              <label htmlFor="sf-phone" className={labelClass}>
                학생 번호
              </label>
              <KrPhoneInput id="sf-phone" value={phone} onChange={setPhone} className={inputClass} disabled={busy} />
            </div>

            <fieldset>
              <legend className={labelClass}>상태</legend>
              <div className="grid grid-cols-4 gap-2" role="radiogroup">
                {STUDENT_STATUSES.map((s) => (
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
                    {STUDENT_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
              {status !== "enrolled" ? (
                <p className="mt-2 break-keep text-[11px] text-neutral-500">
                  재원이 아니면 원비·회차 안내, 출결 알림, 키오스크에서 빠집니다.
                </p>
              ) : null}
            </fieldset>

            <div>
              <label htmlFor="sf-first" className={labelClass}>
                최초 등원일
              </label>
              <input
                id="sf-first"
                type="date"
                value={firstAttendedOn}
                onChange={(e) => setFirstAttendedOn(e.target.value)}
                className={inputClass}
                disabled={busy}
              />
            </div>

            <section>
              <div className="mb-1 flex items-center justify-between">
                <span className={labelClass}>보호자</span>
                <span className="text-[11px] text-neutral-400">
                  {guardians.length}/{MAX_GUARDIANS}
                </span>
              </div>
              <ul className="space-y-2">
                {guardians.map((g, i) => {
                  const linked = Boolean(g.linkedParentUid);
                  const phoneChanged = linked && digitsOnly(g.phone) !== digitsOnly(g.originalPhone);
                  const relationMissing = Boolean(g.relationId && !relationIds.has(g.relationId));
                  return (
                    <li key={g.key} className="rounded-2xl border border-neutral-200/80 bg-white/40 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-neutral-700">
                          <input
                            type="radio"
                            name="sf-primary"
                            checked={g.isPrimary}
                            onChange={() => setPrimary(g.key)}
                            disabled={busy}
                            className="accent-[#222]"
                          />
                          대표 보호자
                        </label>
                        <div className="flex items-center gap-1.5">
                          {linked ? (
                            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-900">
                              앱 연결됨
                            </span>
                          ) : null}
                          <button
                            type="button"
                            disabled={busy || linked}
                            onClick={() => removeGuardian(g.key)}
                            className="rounded-[8px] border border-red-200/80 px-2 py-1 text-[11px] font-medium text-red-600 disabled:border-neutral-200 disabled:text-neutral-400"
                            aria-label={`보호자 ${i + 1} 삭제`}
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <EditableOptionSelect
                          noun="관계"
                          value={g.relationId}
                          onChangeAction={(id) => updateGuardian(g.key, { relationId: id })}
                          items={relations}
                          onSaveItemsAction={onSaveRelationsAction}
                          placeholder={relationMissing ? "관계 미지정" : "관계 선택"}
                          disabled={busy}
                        />
                        <input
                          value={g.name}
                          maxLength={GUARDIAN_NAME_MAX}
                          onChange={(e) => updateGuardian(g.key, { name: e.target.value })}
                          placeholder="이름(선택)"
                          aria-label={`보호자 ${i + 1} 이름`}
                          className={inputClass}
                          disabled={busy}
                        />
                      </div>
                      <KrPhoneInput
                        value={g.phone}
                        onChange={(v) => updateGuardian(g.key, { phone: v })}
                        aria-label={`보호자 ${i + 1} 번호`}
                        className={`${inputClass} mt-2`}
                        disabled={busy}
                      />
                      {linked ? (
                        <p
                          className={`mt-2 break-keep text-[11px] leading-relaxed ${phoneChanged ? "text-amber-800" : "text-neutral-500"}`}
                          data-linked-phone-hint={phoneChanged ? "changed" : "linked"}
                        >
                          {phoneChanged
                            ? LINKED_PHONE_CHANGE_HINT
                            : "앱에 연결된 보호자는 학부모 관리에서 연결을 해제한 뒤 삭제할 수 있어요."}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {guardians.length < MAX_GUARDIANS ? (
                <button
                  type="button"
                  onClick={addGuardian}
                  disabled={busy}
                  className="mt-2 w-full rounded-2xl border border-dashed border-neutral-300 py-2.5 text-sm text-neutral-600"
                >
                  + 보호자 추가
                </button>
              ) : null}
            </section>

            <div>
              <label htmlFor="sf-memo" className={labelClass}>
                메모 <span className="font-normal text-neutral-400">(학원 내부용 · 학부모에게 보이지 않음)</span>
              </label>
              {memoBase !== null ? (
                <>
                  <textarea
                    id="sf-memo"
                    value={memo}
                    maxLength={MEMO_MAX}
                    rows={3}
                    onChange={(e) => setMemo(e.target.value)}
                    className={`${inputClass} resize-none`}
                    disabled={busy}
                  />
                  <p className="mt-1 text-right text-[10px] text-neutral-400">
                    {memo.length}/{MEMO_MAX}
                  </p>
                </>
              ) : (
                <p className="text-xs text-neutral-500">메모를 불러오지 못해 이번 저장에서는 바꾸지 않습니다.</p>
              )}
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
