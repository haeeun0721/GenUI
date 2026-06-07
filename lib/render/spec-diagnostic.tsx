"use client";
import { useState } from "react";

/** Parse **bold** markers into <strong> spans */
function parseBold(text: string): React.ReactNode[] {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-black">{part}</strong> : part
  );
}

/** Korean particle selector based on final consonant (받침) */
function josa(word: string, form: '을/를' | '은/는'): string {
  if (!word) return form.split('/')[1];
  const last = word[word.length - 1];
  const code = last.charCodeAt(0);
  const hasBatchim = code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 !== 0;
  const [withBatchim, withoutBatchim] = form.split('/');
  return hasBatchim ? withBatchim : withoutBatchim;
}

export function SpecDiagnostic({ allProps }: { allProps: any }) {
  const p = allProps?.props || allProps || {};

  const specName: string    = p.specName    ?? "";
  const specUnit: string    = p.specUnit    ?? "";
  const productValue: number = p.productValue ?? 0;
  const productLabel: string = p.productLabel ?? "검색한 수치";
  const thresholdLow: number  = p.thresholdLow  ?? 0;
  const thresholdHigh: number = p.thresholdHigh ?? 100;
  const contextSummary: string = p.contextSummary ?? "";

  const zoneLow:  { label: string; tooltip: string } = p.zoneLow  ?? { label: "부족해요",   tooltip: "이 수치는 해당 용도에 충분하지 않습니다." };
  const zoneMid:  { label: string; tooltip: string } = p.zoneMid  ?? { label: "충분해요",   tooltip: "이 수치는 해당 용도에 적합합니다."       };
  const zoneHigh: { label: string; tooltip: string } = p.zoneHigh ?? { label: "여유로워요", tooltip: "이 수치는 필요 이상으로 충분합니다."       };

  const rangeMax   = thresholdHigh * 1.5;
  const lowPct     = (thresholdLow  / rangeMax) * 100;
  const highPct    = (thresholdHigh / rangeMax) * 100;
  const productPct = Math.min(98, (productValue / rangeMax) * 100);

  const zone: "low" | "mid" | "high" =
    productValue < thresholdLow ? "low" : productValue <= thresholdHigh ? "mid" : "high";

  const zoneColors = {
    low:  { text: "text-red-500",     dot: "bg-red-500"     },
    mid:  { text: "text-emerald-600", dot: "bg-emerald-500" },
    high: { text: "text-sky-500",     dot: "bg-sky-500"     },
  };

  const currentZoneColor = zoneColors[zone];
  const currentZoneInfo  = zone === "low" ? zoneLow : zone === "mid" ? zoneMid : zoneHigh;

  const [hoveredZone, setHoveredZone] = useState<"low" | "mid" | "high" | null>(null);

  const tooltipInfo =
    hoveredZone === "low" ? zoneLow : hoveredZone === "mid" ? zoneMid : hoveredZone === "high" ? zoneHigh : null;

  // Tooltip arrow x: center of each zone
  const tooltipAnchors: Record<"low" | "mid" | "high", number> = {
    low:  lowPct / 2,
    mid:  (lowPct + highPct) / 2,
    high: (highPct + 100) / 2,
  };

  return (
    <div className="my-2 flex flex-col gap-4 w-full animate-in fade-in zoom-in-98 duration-300">

      {/* Title */}
      <h3 className="text-[15px] font-black text-slate-900 tracking-tight leading-tight">
        {contextSummary && (
          <span className="text-slate-900 font-medium">{contextSummary}{josa(contextSummary, '을/를')} 고려했을때 </span>
        )}
        <span className={currentZoneColor.text}>
          {specName} {productValue.toLocaleString()}{specUnit}
        </span>
        <span className="text-slate-900">{josa(specUnit, '은/는')} </span>
        <span className={currentZoneColor.text}>{currentZoneInfo.label}</span>
      </h3>

      {/* ── 3-zone section ── */}
      <div className="relative flex flex-col gap-0">

        {/* Zone labels — plain text above bar */}
        <div className="flex w-full items-end mb-1">
          <div className="flex items-end justify-center pb-1 select-none cursor-pointer" style={{ width: `${lowPct}%`, minWidth: "22%" }}>
            <span className={`text-[10px] font-bold transition-colors duration-150 ${
              hoveredZone === "low" ? "text-red-500" : zone === "low" ? "text-red-400" : "text-slate-300"
            }`}>{zoneLow.label}</span>
          </div>
          <div className="flex flex-1 items-end justify-center pb-1 select-none cursor-pointer">
            <span className={`text-[10px] font-bold transition-colors duration-150 ${
              hoveredZone === "mid" ? "text-emerald-600" : zone === "mid" ? "text-emerald-500" : "text-slate-300"
            }`}>{zoneMid.label}</span>
          </div>
          <div className="flex items-end justify-center pb-1 select-none cursor-pointer" style={{ width: `${100 - highPct}%`, minWidth: "22%" }}>
            <span className={`text-[10px] font-bold transition-colors duration-150 ${
              hoveredZone === "high" ? "text-sky-500" : zone === "high" ? "text-sky-400" : "text-slate-300"
            }`}>{zoneHigh.label}</span>
          </div>
        </div>


        {/* Bar + invisible hover zones */}
        <div className="relative w-full">
          {/* Visual track */}
          <div className="relative w-full h-1.5 rounded-full overflow-hidden bg-slate-100 pointer-events-none">
            <div className={`absolute left-0 top-0 h-full rounded-full transition-colors duration-200 ${hoveredZone === 'low' ? 'bg-red-300' : 'bg-red-200'}`}    style={{ width: `${lowPct}%` }} />
            <div className={`absolute top-0 h-full transition-colors duration-200 ${hoveredZone === 'mid' ? 'bg-emerald-300' : 'bg-emerald-200'}`}                   style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }} />
            <div className={`absolute top-0 h-full rounded-full transition-colors duration-200 ${hoveredZone === 'high' ? 'bg-sky-300' : 'bg-sky-200'}`}             style={{ left: `${highPct}%`, right: 0 }} />
          </div>

          {/* Threshold dividers */}
          <div className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-slate-300 pointer-events-none" style={{ left: `${lowPct}%` }} />
          <div className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-slate-300 pointer-events-none" style={{ left: `${highPct}%` }} />

          {/* Product dot */}
          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 pointer-events-none" style={{ left: `${productPct}%` }}>
            <div className={`w-4 h-4 rounded-full border-2 border-white shadow-md ${currentZoneColor.dot}`} />
          </div>

          {/* Invisible hover zones — tall hit targets over the bar */}
          <div className="absolute inset-0 flex" style={{ top: "-10px", bottom: "-10px" }}>
            <div style={{ width: `${lowPct}%`, minWidth: "22%" }}
              onMouseEnter={() => setHoveredZone("low")}
              onMouseLeave={() => setHoveredZone(null)} />
            <div className="flex-1"
              onMouseEnter={() => setHoveredZone("mid")}
              onMouseLeave={() => setHoveredZone(null)} />
            <div style={{ width: `${100 - highPct}%`, minWidth: "22%" }}
              onMouseEnter={() => setHoveredZone("high")}
              onMouseLeave={() => setHoveredZone(null)} />
          </div>
        </div>

        {/* Value labels + product pin */}
        <div className="relative w-full" style={{ height: "2.8rem" }}>
          <div className="absolute top-1 -translate-x-1/2 flex flex-col items-center pointer-events-none" style={{ left: `${lowPct}%` }}>
            <span className="text-[10px] font-medium text-slate-400 whitespace-nowrap tabular-nums">
              {thresholdLow.toLocaleString()}{specUnit}
            </span>
          </div>
          <div className="absolute top-1 -translate-x-1/2 flex flex-col items-center pointer-events-none" style={{ left: `${highPct}%` }}>
            <span className="text-[10px] font-medium text-slate-400 whitespace-nowrap tabular-nums">
              {thresholdHigh.toLocaleString()}{specUnit}
            </span>
          </div>
          <div className="absolute top-0 -translate-x-1/2 flex flex-col items-center pointer-events-none" style={{ left: `${productPct}%` }}>
            <div className={`w-px h-3 ${currentZoneColor.dot}`} />
            <span className={`text-[10px] font-black whitespace-nowrap tabular-nums ${currentZoneColor.text}`}>
              {productValue.toLocaleString()}{specUnit}
            </span>
            <span className="text-[9px] text-slate-400 whitespace-nowrap">{productLabel}</span>
          </div>
        </div>

        {/* Tooltip — absolutely positioned so it doesn't affect layout */}
        {hoveredZone && tooltipInfo && (() => {
          const tc = {
            low:  { label: "text-red-500",     dot: "bg-red-400",     divider: "bg-red-100"     },
            mid:  { label: "text-emerald-600", dot: "bg-emerald-400", divider: "bg-emerald-100" },
            high: { label: "text-sky-500",     dot: "bg-sky-400",     divider: "bg-sky-100"     },
          }[hoveredZone];
          const arrowPct = Math.min(90, Math.max(10, tooltipAnchors[hoveredZone]));
          return (
            <div className="absolute left-0 right-0 z-50" style={{ top: 'calc(100% + 6px)' }}>
              <div className="relative">
                {/* Arrow: rotated square, card overlaps the bottom half */}
                <div
                  className="absolute w-3 h-3 bg-white border-t border-l border-slate-200 rotate-45 -translate-x-1/2"
                  style={{ left: `${arrowPct}%`, top: '-5px', zIndex: 1 }}
                />
                {/* Card — sits on top of arrow bottom half */}
                <div className="relative bg-white rounded-2xl border border-slate-200 shadow-[0_2px_8px_rgba(0,0,0,0.06)] px-5 py-4" style={{ zIndex: 2 }}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${tc.dot}`} />
                    <span className={`text-[13px] font-black tracking-tight ${tc.label}`}>{tooltipInfo.label}</span>
                  </div>
                  <div className={`w-full h-px mb-3 ${tc.divider}`} />
                  <p className="text-[13px] font-medium text-slate-600 leading-relaxed">
                    {parseBold(tooltipInfo.tooltip)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}




      </div>
      <p className="text-[11px] text-slate-400 mt-1">👆 각 구간에 마우스를 가져다 대면 구체적인 이유를 확인할 수 있어요</p>
    </div>
  );
}
