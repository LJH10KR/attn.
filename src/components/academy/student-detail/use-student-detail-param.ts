"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import type { StudentDetailTab } from "@/lib/academy/use-student-access";

/**
 * 학생 상세 시트 주소 상태 — `?student={id}&tab={attendance|billing}`(정보 탭은 tab 생략).
 * - 열기는 push(기록 1개) → 휴대폰·브라우저 뒤로가기로 시트가 닫힌다.
 * - 탭 바꾸기는 replace(뒤로가기 한 번에 시트가 닫히게).
 * - 닫기: 이 화면에서 연 시트면 back(), 주소로 바로 들어온 시트면 replace(쿼리 제거).
 * - 모두 `scroll: false` — 시트를 열고 닫을 때 뒤의 목록 위치가 그대로 남게.
 * `useSearchParams`를 쓰므로 이 훅을 쓰는 화면은 Suspense 안에 둘 것.
 */
export function useStudentDetailParam() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const studentId = searchParams.get("student") || null;
  /** 주소의 tab 값 그대로 — 권한·값 검사는 시트가 한다 */
  const tabParam = studentId ? searchParams.get("tab") : null;
  const openedHereRef = useRef(false);

  useEffect(() => {
    if (!studentId) openedHereRef.current = false;
  }, [studentId]);

  const urlWith = useCallback(
    (next: { student: string | null; tab: StudentDetailTab | null }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("student");
      params.delete("tab");
      if (next.student) {
        params.set("student", next.student);
        if (next.tab && next.tab !== "info") params.set("tab", next.tab);
      }
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, searchParams],
  );

  const open = useCallback(
    (id: string, tab: StudentDetailTab = "info") => {
      openedHereRef.current = true;
      router.push(urlWith({ student: id, tab }), { scroll: false });
    },
    [router, urlWith],
  );

  const setTab = useCallback(
    (tab: StudentDetailTab) => {
      if (!studentId) return;
      router.replace(urlWith({ student: studentId, tab }), { scroll: false });
    },
    [router, studentId, urlWith],
  );

  const close = useCallback(() => {
    if (openedHereRef.current) {
      openedHereRef.current = false;
      router.back();
      return;
    }
    router.replace(urlWith({ student: null, tab: null }), { scroll: false });
  }, [router, urlWith]);

  return { studentId, tabParam, open, setTab, close };
}
