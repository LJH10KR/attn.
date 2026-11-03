"use client";

import {
  expandScheduleGroups,
  MAX_SCHEDULE_SLOTS,
  newScheduleGroupKey,
  scheduleBlockingError,
  scheduleHasOverlap,
  WEEKDAYS,
  WEEKDAY_LABELS,
  type ScheduleGroup,
} from "@/lib/academy/class-schedule";

const timeInputClass =
  "min-w-0 flex-1 rounded-xl border border-neutral-300/60 bg-white/60 px-3 py-2 text-sm text-foreground outline-none focus:border-[#4a90e2]/50 disabled:opacity-60";

/**
 * 수업 시간 편집 — 줄마다 요일 칩(여러 개) + 시작·끝. 저장 때 요일 × 시간대 칸으로 풀린다.
 * 막는 조건(서버와 같음)은 부모가 `scheduleBlockingError`로 다시 검사하고, 여기서는 바로 보여 준다.
 * 한 반 안의 겹침은 경고만, 다른 반·강의실과는 비교하지 않는다.
 */
export function ClassScheduleEditor({
  groups,
  onChangeAction,
  disabled = false,
}: {
  groups: ScheduleGroup[];
  onChangeAction: (next: ScheduleGroup[]) => void;
  disabled?: boolean;
}) {
  const slots = expandScheduleGroups(groups);
  const blocking = groups.length > 0 ? scheduleBlockingError(groups) : null;
  const overlap = !blocking && scheduleHasOverlap(slots);

  const update = (key: string, patch: Partial<ScheduleGroup>) =>
    onChangeAction(groups.map((g) => (g.key === key ? { ...g, ...patch } : g)));

  const toggleDay = (g: ScheduleGroup, day: number) =>
    update(g.key, {
      weekdays: g.weekdays.includes(day)
        ? g.weekdays.filter((d) => d !== day)
        : [...g.weekdays, day].sort((a, b) => a - b),
    });

  const addRow = () => {
    const last = groups[groups.length - 1];
    onChangeAction([
      ...groups,
      { key: newScheduleGroupKey(), weekdays: [], start: last?.start ?? "16:00", end: last?.end ?? "17:00" },
    ]);
  };

  return (
    <div className="space-y-2">
      {groups.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-500">
          수업 시간이 없습니다. 아래에서 추가해 주세요.
        </p>
      ) : null}
      <ul className="space-y-2">
        {groups.map((g, i) => (
          <li key={g.key} className="rounded-2xl border border-neutral-200/80 bg-white/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium text-neutral-600">수업 시간 {i + 1}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChangeAction(groups.filter((x) => x.key !== g.key))}
                className="rounded-[8px] border border-red-200/80 px-2 py-1 text-[11px] font-medium text-red-600 disabled:opacity-50"
                aria-label={`수업 시간 ${i + 1} 삭제`}
              >
                삭제
              </button>
            </div>
            <div className="flex gap-1" role="group" aria-label={`수업 시간 ${i + 1} 요일`}>
              {WEEKDAYS.map((d) => {
                const on = g.weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => toggleDay(g, d)}
                    className={`h-9 flex-1 rounded-xl border text-xs font-medium transition ${
                      on ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/70 bg-white/60 text-neutral-700"
                    }`}
                  >
                    {WEEKDAY_LABELS[d]}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="time"
                step={300}
                value={g.start}
                disabled={disabled}
                onChange={(e) => update(g.key, { start: e.target.value })}
                className={timeInputClass}
                aria-label={`수업 시간 ${i + 1} 시작`}
              />
              <span className="text-xs text-neutral-500">~</span>
              <input
                type="time"
                step={300}
                value={g.end}
                disabled={disabled}
                onChange={(e) => update(g.key, { end: e.target.value })}
                className={timeInputClass}
                aria-label={`수업 시간 ${i + 1} 끝`}
              />
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={addRow}
        disabled={disabled}
        className="w-full rounded-2xl border border-dashed border-neutral-300 py-2.5 text-sm text-neutral-600 disabled:opacity-50"
      >
        + 수업 시간 추가
      </button>
      <p
        className={`text-right text-[11px] ${slots.length > MAX_SCHEDULE_SLOTS ? "font-semibold text-red-700" : "text-neutral-400"}`}
      >
        요일별 {slots.length}/{MAX_SCHEDULE_SLOTS}칸
      </p>
      {blocking ? (
        <p className="break-keep text-xs text-red-700" role="alert">
          {blocking}
        </p>
      ) : overlap ? (
        <p className="break-keep rounded-xl bg-amber-500/12 px-3 py-2 text-xs text-amber-950" role="status">
          이 반 안에 겹치는 수업 시간이 있습니다. 확인 후 그대로 저장해도 됩니다.
        </p>
      ) : null}
    </div>
  );
}
