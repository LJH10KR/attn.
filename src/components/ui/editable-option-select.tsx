"use client";

import { FirebaseError } from "firebase/app";
import { useCallback, useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import type { AcademyOptionItem } from "@/lib/firebase/attn-schema";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 편집 중인 행 — 새로 추가한 항목은 id 없이 저장(서버가 발급) */
type DraftItem = { key: string; id?: string; label: string };

type EditableOptionSelectProps = {
  /** 시트 제목·안내에 쓰는 이름 (예: "직무") */
  noun: string;
  value: string | null;
  onChangeAction: (id: string | null) => void;
  items: AcademyOptionItem[];
  /** 없으면 편집 버튼을 숨김(권한 없음) */
  onSaveItemsAction?: (items: { id?: string; label: string }[]) => Promise<AcademyOptionItem[]>;
  /** 삭제 확인 문구에 쓰는 사용 수 */
  usageCountById?: Record<string, number>;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
};

const fieldClass =
  "flex w-full items-center justify-between rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-left text-sm text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 disabled:opacity-50";

const smallBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-neutral-300/70 bg-white/70 text-xs text-neutral-700 disabled:opacity-30";

let draftSeq = 0;
function toDraft(items: AcademyOptionItem[]): DraftItem[] {
  return items.map((i) => ({ key: i.id, id: i.id, label: i.label }));
}

/**
 * 범용 선택지 드롭다운 — 시트 안에서 선택하거나, 편집 모드에서 추가·이름 변경·순서 변경·삭제.
 * 직무·강의실·청구 항목 등 학원별 선택지(`meta/options`)에 재사용.
 */
export function EditableOptionSelect({
  noun,
  value,
  onChangeAction,
  items,
  onSaveItemsAction,
  usageCountById,
  placeholder,
  disabled = false,
  id,
}: EditableOptionSelectProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBodyScrollLock(open);

  const selected = items.find((i) => i.id === value) ?? null;

  const close = useCallback(() => {
    if (busy) return;
    setOpen(false);
    setEditing(false);
    setError(null);
    setNewLabel("");
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const startEdit = () => {
    setDraft(toDraft(items));
    setNewLabel("");
    setError(null);
    setEditing(true);
  };

  const move = (index: number, delta: -1 | 1) => {
    setDraft((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const remove = (row: DraftItem) => {
    const used = row.id ? usageCountById?.[row.id] ?? 0 : 0;
    if (
      used > 0 &&
      !window.confirm(`'${row.label}'을(를) 쓰는 항목 ${used}개는 ${noun}이(가) 비워집니다. 삭제할까요?`)
    ) {
      return;
    }
    setDraft((prev) => prev.filter((r) => r.key !== row.key));
  };

  const addDraft = () => {
    const label = newLabel.trim();
    if (!label) return;
    draftSeq += 1;
    setDraft((prev) => [...prev, { key: `new-${draftSeq}`, label }]);
    setNewLabel("");
  };

  const saveDraft = async () => {
    if (!onSaveItemsAction) return;
    const pending = newLabel.trim();
    const rows = pending ? [...draft, { key: "pending", label: pending }] : draft;
    if (rows.some((r) => !r.label.trim())) {
      setError(`${noun} 이름을 비워 둘 수 없습니다.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await onSaveItemsAction(
        rows.map((r) => (r.id ? { id: r.id, label: r.label.trim() } : { label: r.label.trim() })),
      );
      if (value && !saved.some((i) => i.id === value)) {
        onChangeAction(null);
      }
      setEditing(false);
      setNewLabel("");
    } catch (e) {
      setError(e instanceof FirebaseError && e.message ? e.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        id={id}
        className={fieldClass}
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span className={selected ? "" : "text-neutral-400"}>
          {selected?.label ?? placeholder ?? `${noun} 선택`}
        </span>
        <span aria-hidden className="text-neutral-400">
          ▾
        </span>
      </button>

      {open ? (
        <ModalPortal>
          <div
            className="fixed inset-0 z-[210] flex items-end justify-center bg-black/40 sm:items-center"
            role="presentation"
            onClick={close}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`${noun} 선택`}
              className="flex max-h-[80dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-foreground">
                  {editing ? `${noun} 편집` : `${noun} 선택`}
                </h3>
                {onSaveItemsAction && !editing ? (
                  <button
                    type="button"
                    className="rounded-[8px] border border-neutral-300/70 px-3 py-1.5 text-xs font-medium"
                    onClick={startEdit}
                  >
                    편집
                  </button>
                ) : null}
              </div>

              {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}

              {editing ? (
                <>
                  <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                    {draft.map((row, i) => (
                      <li key={row.key} className="flex items-center gap-1.5">
                        <input
                          value={row.label}
                          maxLength={20}
                          onChange={(e) =>
                            setDraft((prev) =>
                              prev.map((r) => (r.key === row.key ? { ...r, label: e.target.value } : r)),
                            )
                          }
                          className="min-w-0 flex-1 rounded-xl border border-neutral-300/60 px-3 py-2 text-sm"
                          aria-label={`${noun} 이름`}
                        />
                        <button
                          type="button"
                          className={smallBtn}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                          aria-label="위로"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className={smallBtn}
                          disabled={i === draft.length - 1}
                          onClick={() => move(i, 1)}
                          aria-label="아래로"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className={`${smallBtn} text-red-600`}
                          onClick={() => remove(row)}
                          aria-label={`${row.label} 삭제`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={newLabel}
                      maxLength={20}
                      onChange={(e) => setNewLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addDraft();
                        }
                      }}
                      placeholder={`새 ${noun} 이름`}
                      className="min-w-0 flex-1 rounded-xl border border-neutral-300/60 px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-xl border border-neutral-300/70 px-3 text-sm"
                      onClick={addDraft}
                    >
                      추가
                    </button>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium"
                      onClick={() => {
                        setEditing(false);
                        setError(null);
                      }}
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
                      onClick={() => void saveDraft()}
                    >
                      {busy ? "저장 중…" : "저장"}
                    </button>
                  </div>
                </>
              ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  <li>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-sm text-neutral-500 hover:bg-black/[0.04]"
                      onClick={() => {
                        onChangeAction(null);
                        close();
                      }}
                    >
                      선택 안 함
                      {value === null ? <span aria-hidden>✓</span> : null}
                    </button>
                  </li>
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-sm text-foreground hover:bg-black/[0.04]"
                        onClick={() => {
                          onChangeAction(item.id);
                          close();
                        }}
                      >
                        {item.label}
                        {item.id === value ? <span aria-hidden>✓</span> : null}
                      </button>
                    </li>
                  ))}
                  {items.length === 0 ? (
                    <li className="px-3 py-6 text-center text-xs text-neutral-500">
                      {onSaveItemsAction
                        ? `등록된 ${noun}이(가) 없습니다. 편집에서 추가해 주세요.`
                        : `등록된 ${noun}이(가) 없습니다.`}
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
          </div>
        </ModalPortal>
      ) : null}
    </>
  );
}
