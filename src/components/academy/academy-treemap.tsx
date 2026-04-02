"use client";

import {
  hierarchy,
  treemap,
  treemapSquarify,
  type HierarchyRectangularNode,
} from "d3-hierarchy";
import { useEffect, useMemo, useRef, useState } from "react";

export type AcademyHeatmapItem = {
  id: string;
  label: string;
  /** 면적 가중치 (건수 등) */
  value: number;
  /** -1(부정/주의) ~ 1(긍정/양호), 색상 매핑 */
  score: number;
  /** 보조 숫자 표시 (예: 요청 건수) */
  metric: string;
};

function scoreToHeatColor(score: number): { bg: string; fg: string } {
  const t = Math.max(-1, Math.min(1, score));
  if (t > 0.08) {
    const k = (t - 0.08) / 0.92;
    const dark = { r: 21, g: 128, b: 61 };
    const bright = { r: 34, g: 197, b: 94 };
    const r = Math.round(dark.r + (bright.r - dark.r) * k);
    const g = Math.round(dark.g + (bright.g - dark.g) * k);
    const b = Math.round(dark.b + (bright.b - dark.b) * k);
    return { bg: `rgb(${r},${g},${b})`, fg: "#ffffff" };
  }
  if (t < -0.08) {
    const k = (-t - 0.08) / 0.92;
    const dark = { r: 185, g: 28, b: 28 };
    const bright = { r: 239, g: 68, b: 68 };
    const r = Math.round(bright.r + (dark.r - bright.r) * k);
    const g = Math.round(bright.g + (dark.g - bright.g) * k);
    const b = Math.round(bright.b + (dark.b - bright.b) * k);
    return { bg: `rgb(${r},${g},${b})`, fg: "#ffffff" };
  }
  return { bg: "#3f3f46", fg: "#fafafa" };
}

type TreemapRoot = { children: AcademyHeatmapItem[] };

export function AcademyTreemap({ items }: { items: AcademyHeatmapItem[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 320, h: 280 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr?.width) {
        return;
      }
      const w = Math.floor(cr.width);
      const h = Math.max(200, Math.floor((w * 9) / 16));
      setSize({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const leaves = useMemo(() => {
    const layout = treemap<TreemapRoot | AcademyHeatmapItem>()
      .tile(treemapSquarify)
      .size([size.w, size.h])
      .paddingOuter(3)
      .paddingInner(2)
      .round(true);

    const root = hierarchy<TreemapRoot | AcademyHeatmapItem>({ children: items })
      .sum((d) => {
        if ("children" in d && d.children) {
          return 0;
        }
        return (d as AcademyHeatmapItem).value;
      })
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    layout(root);
    return root.leaves() as HierarchyRectangularNode<AcademyHeatmapItem>[];
  }, [items, size.w, size.h]);

  return (
    <div ref={wrapRef} className="w-full">
      <div
        className="relative w-full overflow-hidden rounded-2xl border border-[#1a1a1a]/25 bg-[#0f0f0f]/[0.03]"
        style={{ height: size.h }}
      >
        {leaves.map((leaf) => {
          const d = leaf.data;
          const { bg, fg } = scoreToHeatColor(d.score ?? 0);
          const w = leaf.x1 - leaf.x0;
          const h = leaf.y1 - leaf.y0;
          const area = w * h;
          const titleSize = Math.max(11, Math.min(16, Math.sqrt(area) * 0.22));
          const metricSize = Math.max(10, titleSize - 2);
          const left = (leaf.x0 / size.w) * 100;
          const top = (leaf.y0 / size.h) * 100;
          const pw = (w / size.w) * 100;
          const ph = (h / size.h) * 100;

          return (
            <div
              key={d.id}
              className="absolute box-border flex flex-col justify-end overflow-hidden p-2 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: `${pw}%`,
                height: `${ph}%`,
                backgroundColor: bg,
                color: fg,
              }}
            >
              <div
                className="line-clamp-3 break-words font-semibold leading-snug"
                style={{ fontSize: titleSize }}
              >
                {d.label}
              </div>
              <div
                className="mt-0.5 tabular-nums opacity-95"
                style={{ fontSize: metricSize }}
              >
                {d.metric}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-[10px] text-neutral-500">
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-emerald-800">
          <span className="h-2 w-2 rounded-sm bg-emerald-600" /> 양호
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-neutral-400/20 px-1.5 py-0.5 text-neutral-600">
          <span className="h-2 w-2 rounded-sm bg-zinc-500" /> 보통
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-1.5 py-0.5 text-red-800">
          <span className="h-2 w-2 rounded-sm bg-red-600" /> 주의
        </span>
      </div>
    </div>
  );
}
