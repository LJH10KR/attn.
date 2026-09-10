import { collection, getDocs } from "firebase/firestore";
import type { KioskStudentRow } from "@/components/academy/academy-kiosk-panel";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { maskKrPhoneForKiosk, phoneLast4Digits } from "@/lib/phone/kr-phone";

export async function loadKioskStudentRows(academyId: string): Promise<KioskStudentRow[]> {
  const db = getFirebaseDb();
  const [studentsSnap, parentsSnap] = await Promise.all([
    getDocs(collection(db, "academies", academyId, "students")),
    getDocs(collection(db, "academies", academyId, "parents")),
  ]);

  const parentNameByUid = new Map<string, string>();
  for (const d of parentsSnap.docs) {
    const authUid = d.get("authUid");
    const uid = typeof authUid === "string" && authUid ? authUid : d.id;
    const name = d.get("displayName");
    if (typeof name === "string" && name) {
      parentNameByUid.set(uid, name);
    }
  }

  const rows: KioskStudentRow[] = [];
  for (const d of studentsSnap.docs) {
    const name = d.get("name");
    if (typeof name !== "string" || !name.trim()) continue;
    const parentUserId = d.get("parentUserId");
    const parentName =
      typeof parentUserId === "string"
        ? parentNameByUid.get(parentUserId) ?? ""
        : "";
    const phoneRaw = d.get("phone");
    const phone =
      typeof phoneRaw === "string" && phoneRaw.trim() ? phoneRaw.trim() : null;
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

export function kioskModeStorageKey(academyId: string): string {
  return `attn_kiosk_mode_${academyId}`;
}

export function isKioskModeActive(academyId: string): boolean {
  if (!academyId) return false;
  try {
    return sessionStorage.getItem(kioskModeStorageKey(academyId)) === "1";
  } catch {
    return false;
  }
}
