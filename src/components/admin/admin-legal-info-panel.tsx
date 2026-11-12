"use client";

import { doc, getDoc, serverTimestamp, setDoc, type Timestamp } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getFirebaseDbAfterAuthReady } from "@/lib/firebase/client-app";
import {
  DEFAULT_CONTACT_EMAIL,
  EMPTY_LEGAL_INFO,
  formatBusinessNumber,
  LEGAL_INFO_DOC_PATH,
  LEGAL_INFO_FIELDS,
  LEGAL_INFO_LABELS,
  LEGAL_INFO_MAX_LENGTH,
  missingLegalInfoFields,
  normalizeLegalInfo,
  validateLegalInfoInput,
  type LegalInfo,
  type LegalInfoField,
} from "@/lib/legal/legal-info";
import { LEGAL_DOC_PATHS, LEGAL_DOC_TITLES } from "@/lib/legal/legal-docs";
import { setLegalInfoCache } from "@/lib/legal/use-legal-info";

const PLACEHOLDERS: Record<LegalInfoField, string> = {
  representativeName: "홍길동",
  businessNumber: "숫자 10자리",
  address: "사업장 주소",
  contactEmail: DEFAULT_CONTACT_EMAIL,
  privacyEffectiveDate: "",
  termsEffectiveDate: "",
};

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]";

function formatSavedAt(ts: Timestamp | null): string {
  if (!ts) return "";
  return ts.toDate().toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

/** 입력 다듬기 — 앞뒤 공백, 사업자번호는 하이픈 형식으로 */
function cleanInput(form: LegalInfo): LegalInfo {
  const out = { ...form };
  for (const k of LEGAL_INFO_FIELDS) out[k] = out[k].trim();
  out.businessNumber = out.businessNumber ? formatBusinessNumber(out.businessNumber) : "";
  return out;
}

/**
 * 관리자 — 법적 고지 정보(2-O). 처리방침·약관 본문과 사이트 하단이 이 값을 읽는다(`appConfig/legalInfo`).
 * 쓰기는 클라이언트 직접 — 규칙이 admin 클레임·형식을 검사한다(`firestore.rules` `legalInfoValid`).
 */
export function AdminLegalInfoPanel() {
  const [saved, setSaved] = useState<LegalInfo | null>(null);
  const [savedAt, setSavedAt] = useState<Timestamp | null>(null);
  const [form, setForm] = useState<LegalInfo>(EMPTY_LEGAL_INFO);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<LegalInfoField, string>>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const db = await getFirebaseDbAfterAuthReady();
      const snap = await getDoc(doc(db, ...LEGAL_INFO_DOC_PATH));
      const info = normalizeLegalInfo(snap.exists() ? snap.data() : null);
      setSaved(info);
      setSavedAt((snap.exists() ? (snap.get("updatedAt") as Timestamp | undefined) : undefined) ?? null);
      setForm({ ...info, contactEmail: info.contactEmail || DEFAULT_CONTACT_EMAIL });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const missing = useMemo(() => (saved ? missingLegalInfoFields(saved) : []), [saved]);

  const onSave = async () => {
    const next = cleanInput(form);
    setForm(next);
    const errs = validateLegalInfoInput(next);
    setErrors(errs);
    setSavedNote(false);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setSaveError(null);
    try {
      const db = await getFirebaseDbAfterAuthReady();
      await setDoc(doc(db, ...LEGAL_INFO_DOC_PATH), { ...next, updatedAt: serverTimestamp() });
      setLegalInfoCache(next);
      await load();
      setSavedNote(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card-soft p-5" data-testid="admin-legal-info-panel">
      <h2 className="text-sm font-semibold text-foreground">법적 고지 정보</h2>
      <p className="mt-1 break-keep text-xs text-neutral-500">
        개인정보 처리방침·이용약관 본문과 로그인·설정·가입 화면 하단의 사업자 정보에 그대로 표시됩니다. 상호(에이티티앤)와
        문서 버전은 코드에 있습니다.
      </p>

      {loadError ? (
        <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {loadError}
        </p>
      ) : null}

      {saved && missing.length > 0 ? (
        <div
          className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-500/20"
          role="status"
          data-legal-info-missing
        >
          <p className="break-keep font-medium">비어 있는 값: {missing.map((k) => LEGAL_INFO_LABELS[k]).join(", ")}</p>
          <p className="mt-0.5 break-keep">
            실사용자를 받기 전에 모두 입력해 주세요. 비어 있는 값은 문서에 &quot;(준비 중)&quot;으로 보이고 하단에서는
            빠집니다.
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LEGAL_INFO_FIELDS.map((k) => {
          const isDate = k === "privacyEffectiveDate" || k === "termsEffectiveDate";
          return (
            <label key={k} className={`block ${k === "address" ? "sm:col-span-2" : ""}`}>
              <span className="mb-1.5 block text-xs font-medium text-neutral-600">{LEGAL_INFO_LABELS[k]}</span>
              <input
                type={isDate ? "date" : k === "contactEmail" ? "email" : "text"}
                inputMode={k === "businessNumber" ? "numeric" : undefined}
                value={form[k]}
                maxLength={k === "businessNumber" ? 12 : LEGAL_INFO_MAX_LENGTH[k]}
                placeholder={PLACEHOLDERS[k] || undefined}
                onChange={(e) => {
                  setForm((f) => ({ ...f, [k]: e.target.value }));
                  setSavedNote(false);
                }}
                aria-invalid={errors[k] ? true : undefined}
                className={inputClass}
                data-legal-info-input={k}
              />
              {errors[k] ? (
                <span className="mt-1 block text-[11px] text-red-700" data-legal-info-error={k}>
                  {errors[k]}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>

      {saveError ? (
        <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15" role="alert">
          {saveError}
        </p>
      ) : null}

      <button
        type="button"
        disabled={busy || !saved}
        onClick={() => void onSave()}
        className="mt-4 w-full rounded-2xl bg-[#222] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#333] disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white"
        data-legal-info-save
      >
        {busy ? "저장하는 중…" : "저장"}
      </button>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
        <span data-legal-info-saved-at>
          {savedNote ? "저장했습니다. " : ""}
          {savedAt ? `마지막 저장 ${formatSavedAt(savedAt)}` : saved ? "아직 저장한 적 없음" : ""}
        </span>
        <span className="flex gap-3">
          {(["privacy", "terms"] as const).map((kind) => (
            <a key={kind} href={LEGAL_DOC_PATHS[kind]} target="_blank" rel="noopener noreferrer" className="underline">
              {LEGAL_DOC_TITLES[kind]} 보기
            </a>
          ))}
        </span>
      </div>
    </section>
  );
}
