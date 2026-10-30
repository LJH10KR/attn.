import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import type { KioskStudentRow } from "@/components/academy/academy-kiosk-panel";
import { academyOptionsPath, type StudentGuardian } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { maskKrPhoneForKiosk, phoneLast4Digits } from "@/lib/phone/kr-phone";

/**
 * 키오스크 학생 목록 — 재원 원생만. 보호자 이름은 원생 문서의 대표 보호자(이름, 없으면 관계 라벨)에서 읽고
 * 학부모 계정 목록(`parents`)은 읽지 않는다. 번호 뒷자리는 학생 번호, 없으면 대표 보호자 번호(3단계 출첵번호 전까지).
 */
export async function loadKioskStudentRows(academyId: string): Promise<KioskStudentRow[]> {
  const db = getFirebaseDb();
  const [studentsSnap, optionsSnap] = await Promise.all([
    getDocs(query(collection(db, "academies", academyId, "students"), where("status", "==", "enrolled"))),
    // 관계 라벨은 보조 정보 — 못 읽어도 학생 목록은 보여 준다
    getDoc(doc(db, academyOptionsPath(academyId))).catch(() => null),
  ]);

  const relationLabelById = new Map<string, string>();
  const relations: unknown = optionsSnap?.get("guardianRelations");
  if (Array.isArray(relations)) {
    for (const r of relations as { id?: unknown; label?: unknown }[]) {
      if (typeof r?.id === "string" && typeof r.label === "string") relationLabelById.set(r.id, r.label);
    }
  }

  const rows: KioskStudentRow[] = [];
  for (const d of studentsSnap.docs) {
    const name = d.get("name");
    if (typeof name !== "string" || !name.trim()) continue;
    const guardians: unknown = d.get("guardians");
    const list = Array.isArray(guardians) ? (guardians as StudentGuardian[]) : [];
    const primary = list.find((g) => g?.isPrimary) ?? list[0];
    const parentName =
      (typeof primary?.name === "string" && primary.name) ||
      (primary?.relationId ? relationLabelById.get(primary.relationId) ?? "" : "");
    const studentPhone = d.get("phone");
    const phone =
      typeof studentPhone === "string" && studentPhone.trim()
        ? studentPhone.trim()
        : typeof primary?.phone === "string" && primary.phone
          ? primary.phone
          : null;
    rows.push({
      studentId: d.id,
      name: name.trim(),
      phoneLast4: phoneLast4Digits(phone),
      phoneMasked: maskKrPhoneForKiosk(phone),
      parentName,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return rows;
}

const KIOSK_MODE_KEY_PREFIX = "attn_kiosk_mode_";

export function kioskModeStorageKey(academyId: string): string {
  return `${KIOSK_MODE_KEY_PREFIX}${academyId}`;
}

/** 이 탭에서 키오스크가 켜진 학원 — 없으면 null(다른 학원 주소로 빠져나가는 것을 막을 때 사용) */
export function activeKioskAcademyId(): string | null {
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(KIOSK_MODE_KEY_PREFIX) && sessionStorage.getItem(key) === "1") {
        return key.slice(KIOSK_MODE_KEY_PREFIX.length) || null;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isKioskModeActive(academyId: string): boolean {
  if (!academyId) return false;
  try {
    return sessionStorage.getItem(kioskModeStorageKey(academyId)) === "1";
  } catch {
    return false;
  }
}
