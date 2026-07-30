"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, Heart, Check, AlertTriangle, Lightbulb, ArrowRight, Columns3, LayoutList, Sparkles, X } from "lucide-react";

// danuri.io / danawa.com 이미지는 hotlink protection이 걸려 있어 서버 프록시를 통해 로드
const PROXY_DOMAINS = ["img.danuri.io", "img.danawa.com", "prod.danawa.com"];
function proxyImg(url?: string): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname;
    if (PROXY_DOMAINS.some(d => host === d || host.endsWith("." + d))) {
      return `/api/img-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {}
  return url;
}

// =============================================================================
// HeartButton — Naver Shopping style heart overlay for ProductCard
// =============================================================================

function HeartButton({
  isSaved = false,
  onAdd,
  onRemove,
}: {
  isSaved?: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const [saved, setSaved] = useState(isSaved);

  useEffect(() => {
    setSaved(isSaved);
  }, [isSaved]);

  return (
    <button
      className="absolute bottom-1.5 right-1.5 w-[22px] h-[22px] rounded-full flex items-center justify-center transition-all duration-200 active:scale-90"
      style={{ background: saved ? "#ff4757" : "rgba(160,160,160,0.72)" }}
      onClick={(e) => {
        e.stopPropagation();
        const next = !saved;
        setSaved(next);
        if (next) onAdd();
        else onRemove();
      }}
    >
      <Heart
        className="w-[11px] h-[11px] transition-all duration-200"
        style={{
          fill: saved ? "white" : "none",
          stroke: "white",
          strokeWidth: 2,
        }}
      />
    </button>
  );
}

// =============================================================================
// SpecChips — 스펙 칩 접기/펼치기 컴포넌트
// =============================================================================

const SPEC_COLLAPSED_COUNT = 4;

function SpecChips({ specs, highlightFirst = false }: { specs: string[], highlightFirst?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!Array.isArray(specs) || specs.length === 0) return null;
  const visible = expanded ? specs : specs.slice(0, SPEC_COLLAPSED_COUNT);
  const hiddenCount = specs.length - SPEC_COLLAPSED_COUNT;
  const hasMore = hiddenCount > 0;
  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {visible.map((spec: string, i: number) => (
        <span
          key={i}
          className={`text-[9px] text-[#666666] bg-[#F5F5F5] px-1.5 py-0.5 rounded-full whitespace-nowrap ${
            i === 0 && highlightFirst
              ? "animate-in fade-in zoom-in-95 duration-700"
              : ""
          }`}
        >
          {spec}
        </span>
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
          className="text-[9px] text-[#888] bg-[#EBEBEB] hover:bg-[#DEDEDE] px-1.5 py-0.5 rounded-full whitespace-nowrap transition-colors cursor-pointer select-none"
        >
          {expanded ? "접기 ↑" : `+${hiddenCount}개 ↓`}
        </button>
      )}
    </div>
  );
}

// =============================================================================
// Registry
// =============================================================================

export const manualRegistry: Record<string, any> = {
  Empty: () => null,

  RagNotFound: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const message: string = p.message || "요청하신 기준에 해당하는 제품 데이터가 현재 DB에 없습니다.";
    const skipped: string[] = p.skippedCriteria || [];
    return (
      <div className="flex flex-col gap-3 w-full rounded-xl border border-slate-200 bg-white px-4 py-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="text-[13px] font-semibold text-slate-700">DB에서 찾을 수 없는 기준이에요</span>
        </div>
        <p className="text-[12px] text-slate-500 leading-relaxed">{message}</p>
        {skipped.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {skipped.map((c: string, i: number) => (
              <span
                key={i}
                className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
              >
                {c}
              </span>
            ))}
          </div>
        )}
        <p className="text-[11px] text-slate-400">더 일반적인 조건으로 다시 검색해보거나, 해당 기능에 대해 질문해주세요.</p>
      </div>
    );
  },


  CoverageNotice: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const applied: string[] = p.appliedCriteria || [];
    const skipped: string[] = p.skippedCriteria || [];
    if (applied.length === 0 && skipped.length === 0) return null;

    const Chip = ({ label, badgeLabel, badgeClass, dotClass }: {
      label: string; badgeLabel: string; badgeClass: string; dotClass: string;
    }) => (
      <div
        className="flex items-center gap-1 rounded-2xl px-2 h-[22px] w-fit shrink-0"
        style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0' }}
      >
        <div className={`flex items-center gap-0.5 border rounded-[4px] px-1 py-0 text-[8px] font-bold ${badgeClass}`}>
          <div className={`w-1 h-1 rounded-full ${dotClass}`} />
          {badgeLabel}
        </div>
        <span className="text-[11px] font-semibold whitespace-nowrap text-slate-800">{label}</span>
      </div>
    );

    return (
      <div className="flex flex-col gap-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5">
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-[11px] font-semibold text-slate-600">일부 기준이 반영되지 않았어요</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {applied.map((c: string, i: number) => (
            <Chip key={`a-${i}`} label={c} badgeLabel="반영됨" badgeClass="text-emerald-600 bg-emerald-50 border-emerald-100" dotClass="bg-emerald-400" />
          ))}
          {skipped.map((c: string, i: number) => (
            <Chip key={`s-${i}`} label={c} badgeLabel="미반영" badgeClass="text-amber-500 bg-amber-50 border-amber-100" dotClass="bg-amber-400" />
          ))}
        </div>
        <p className="text-[10.5px] text-slate-400">미반영 기준은 현재 DB에 스펙 데이터가 없어요.</p>
      </div>
    );
  },

  TradeoffHint: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    if (!p.conflictsWith) return null;
    const whyText = p.why || p.reason;
    if (!whyText) return null;

    return (
      <div className="flex flex-col border border-slate-200 rounded-xl overflow-hidden w-full bg-white px-3.5 pt-3 pb-3 gap-2">
        {/* Title row */}
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <p className="text-[12px] font-semibold text-slate-700 truncate flex-1">
            {p.newCriterion} ↔ {p.conflictsWith}
          </p>
          {p.onDismiss && (
            <button onClick={p.onDismiss} className="text-slate-300 hover:text-slate-600 transition-colors shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* 왜 이런 딜레마가 생기나요 */}
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">왜 이런 딜레마가 생기나요</span>
          <p className="text-[11px] text-slate-600 leading-relaxed">{whyText}</p>
        </div>
      </div>
    );
  },


  UnchartedTerritoryChip: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const labels: string[] = Array.isArray(p.labels) ? p.labels : [];
    const onExplore: ((label: string) => void) | undefined = p.onExplore;
    const skipAnimation: boolean = p.skipAnimation === true;

    if (labels.length === 0) return null;

    return (
      <div className={`flex flex-col gap-2 p-3 rounded-[10px] bg-white${skipAnimation ? '' : ' animate-in fade-in slide-in-from-top-2 duration-300'}`}>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[13.5px] font-semibold text-slate-800">아직 탐색하지 않은 영역</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {labels.map((label, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onExplore?.(label)}
              className="flex items-center gap-1 rounded-full px-2.5 h-[26px] border border-dashed border-slate-300 bg-white hover:bg-slate-100 text-[11.5px] font-medium text-slate-600 transition-colors cursor-pointer active:scale-[0.97] whitespace-nowrap"
            >
              {label} ↗
            </button>
          ))}
        </div>
      </div>
    );
  },

  // SpecDiagnostic inlined below manualRegistry definition


  CriteriaMap: (() => {
    const globalSeenCats = new Set<string>();
    const globalSeenChips = new Set<string>();

    return (allProps: any) => {
      const p = allProps?.props || allProps || {};
      const categories: any[] = Array.isArray(p.categories) ? p.categories : [];
      const unexploredCategories = categories.filter((c: any) => !c.items || c.items.length === 0);
      const normalCategories = categories.filter((c: any) => c.items && c.items.length > 0);
      const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
        // Initially open only categories that contain at least one "important" chip
        const initial: Record<number, boolean> = {};
        normalCategories.forEach((cat: any, ci: number) => {
          const items: any[] = Array.isArray(cat.items) ? cat.items : [];
          const hasImportant = items.some((item: any) => item.important === true);
          initial[ci] = !hasImportant; // collapsed = true if no important chips
        });
        return initial;
      });
      const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
      const [dismissedUnexplored, setDismissedUnexplored] = useState<Set<string>>(new Set());

      // Track which categories and chips are currently animating (brand new in the current turn)
      const [animatingKeys, setAnimatingKeys] = useState<Set<string>>(new Set());

      // categories 배열은 매 렌더마다 새 참조가 생성되므로 JSON 직렬화로 실제 내용 변화만 감지
      const categoriesKey = JSON.stringify(categories);

      useEffect(() => {
        if (categories.length === 0) {
          globalSeenCats.clear();
          globalSeenChips.clear();
          setAnimatingKeys(new Set());
          return;
        }

        const newKeys = new Set<string>();
        let hasNew = false;
        const newImportantCatIndices = new Set<number>();

        categories.forEach((c) => {
          if (!globalSeenCats.has(c.label)) {
            newKeys.add(`cat::${c.label}`);
            globalSeenCats.add(c.label);
            hasNew = true;
          }
          (Array.isArray(c.items) ? c.items : []).forEach((i: any) => {
            const chipKey = `${c.label}::${i.name}`;
            if (!globalSeenChips.has(chipKey)) {
              newKeys.add(`chip::${chipKey}`);
              globalSeenChips.add(chipKey);
              hasNew = true;
              
              if (i.important) {
                // Find index of this category in normalCategories to expand it
                const normalCategoriesArr = categories.filter((cat: any) => cat.items && cat.items.length > 0);
                const normalIndex = normalCategoriesArr.findIndex(nc => nc.label === c.label);
                if (normalIndex !== -1) {
                  newImportantCatIndices.add(normalIndex);
                }
              }
            }
          });
        });

        if (hasNew) {
          setAnimatingKeys(prev => {
            const next = new Set(prev);
            newKeys.forEach(k => next.add(k));
            return next;
          });
        }

        if (newImportantCatIndices.size > 0) {
          setCollapsed(prev => {
            const next = { ...prev };
            newImportantCatIndices.forEach(idx => {
              next[idx] = false; // force open
            });
            return next;
          });
        }
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [categoriesKey]);

      if (categories.length === 0) {
        return (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
              대화를 시작하면<br />여기에 탐색 기록이 쌓여요
            </p>
          </div>
        );
      }

      return (
        <div className="flex flex-col gap-2 py-1">
          {/* Fixed tooltip portal — renders above all overflow constraints */}
          {tooltip && (
            <div
              className="pointer-events-none z-[9999] fixed"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                transform: "translate(-16px, calc(-100% - 12px))",
                filter: "drop-shadow(0 2px 10px rgba(0,0,0,0.07)) drop-shadow(0 1px 3px rgba(0,0,0,0.04))",
              }}
            >
              <div className="relative bg-white text-slate-700 text-[12px] font-medium leading-relaxed rounded-[14px] px-4 py-2.5 max-w-[220px] border border-slate-100">
                {tooltip.text}
                <div
                  className="absolute"
                  style={{
                    bottom: "-9px",
                    left: "14px",
                    width: 0,
                    height: 0,
                    borderTop: "10px solid white",
                    borderRight: "12px solid transparent",
                  }}
                />
              </div>
            </div>
          )}

          {/* Unexplored Areas Section */}
          {unexploredCategories.filter((c: any) => !dismissedUnexplored.has(c.label)).length > 0 && (
            <div className="mb-4 px-1">
              <div className="flex items-center gap-1.5 mb-3">
                <Lightbulb className="w-[15px] h-[15px] text-slate-500" />
                <span className="text-[13.5px] font-bold text-slate-600 tracking-tight">이 영역도 탐색해보는 건 어떨까요?</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {unexploredCategories.filter((cat: any) => !dismissedUnexplored.has(cat.label)).map((cat: any, i: number) => {
                  const isCatNew = animatingKeys.has(`cat::${cat.label}`);
                  return (
                    <div
                      key={i}
                      className={`flex items-center gap-1.5 rounded-full px-3 h-[32px] border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer active:scale-[0.98]${isCatNew ? " animate-chip-in" : ""}`}
                      style={isCatNew ? { animationDelay: `${i * 0.05}s` } : undefined}
                      onAnimationEnd={() => {
                        if (isCatNew) {
                          setAnimatingKeys(prev => {
                            const next = new Set(prev);
                            next.delete(`cat::${cat.label}`);
                            return next;
                          });
                        }
                      }}
                      onClick={() => {
                        setDismissedUnexplored(prev => new Set(prev).add(cat.label));
                        allProps.bindings?.onSubmitChat?.(`"${cat.label}" 기준에 대해 알려줘`);
                      }}
                    >
                      <span className="text-[12.5px] font-medium text-slate-700 tracking-tight whitespace-nowrap">{cat.label} ↗</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Normal Categories Section */}
          {normalCategories.map((cat: any, ci: number) => {
            const items: any[] = Array.isArray(cat.items) ? cat.items : [];
            const isCollapsed = collapsed[ci] ?? false;

            const isCatNew = animatingKeys.has(`cat::${cat.label}`);

            return (
              <div
                key={ci}
                className={`border border-slate-200 rounded-[8px]${isCatNew ? " animate-accordion-in" : ""}`}
                style={isCatNew ? { animationDelay: `${ci * 0.07}s` } : undefined}
                onAnimationEnd={() => {
                  if (isCatNew) {
                    setAnimatingKeys(prev => {
                      const next = new Set(prev);
                      next.delete(`cat::${cat.label}`);
                      return next;
                    });
                  }
                }}
              >
                {/* Accordion header */}
                <button
                  type="button"
                  onClick={() => setCollapsed(prev => ({ ...prev, [ci]: !isCollapsed }))}
                  className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 transition-colors rounded-[8px]"
                >
                  <span className="text-[13.5px] font-semibold text-slate-800 text-left">
                    {cat.label}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 transition-transform duration-250 ${isCollapsed ? "" : "rotate-180"}`}
                  />
                </button>

                {/* Chips — max-height transition */}
                <div
                  style={{
                    maxHeight: isCollapsed ? 0 : 500,
                    overflow: isCollapsed ? "hidden" : "visible",
                    transition: "max-height 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease",
                    opacity: isCollapsed ? 0 : 1,
                  }}
                >
                  <div className="px-4 pb-3 pt-2 flex flex-wrap gap-2 border-t border-slate-100 bg-white rounded-b-[8px]">

                    {items.map((item: any, ii: number) => {
                      const chipKey = `${cat.label}::${item.name}`;
                      const isNew = animatingKeys.has(`chip::${chipKey}`);

                      const isSelected = allProps.bindings?.droppedCriteria?.some(
                        (c: any) => c.name === item.name
                      );
                      const isImportant = !!item.important;

                      return (
                        <div
                          key={`${ci}-${ii}-${item.name}`}
                          className={`relative${isNew ? " animate-chip-in" : ""}`}
                          style={isNew ? { animationDelay: `${ii * 0.05}s` } : undefined}
                          onAnimationEnd={() => {
                            if (isNew) {
                              setAnimatingKeys(prev => {
                                const next = new Set(prev);
                                next.delete(`chip::${chipKey}`);
                                return next;
                              });
                            }
                          }}
                          onMouseEnter={isImportant && item.reason ? (e) => {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setTooltip({
                              text: item.reason,
                              x: rect.left + rect.width / 2,
                              y: rect.top - 10,
                            });
                          } : undefined}
                          onMouseLeave={isImportant && item.reason ? () => setTooltip(null) : undefined}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("application/json", JSON.stringify(item));
                            e.dataTransfer.setData("text/plain", item.name);
                            e.dataTransfer.effectAllowed = "copy";
                            allProps.bindings?.onDragStartCriteria?.();
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              allProps.bindings?.onToggleCriteria?.(item);
                            }}
                            className={`flex items-center gap-1.5 rounded-full px-3 h-[32px] border transition-all duration-200 cursor-pointer hover:shadow-sm active:scale-[0.97] ${isSelected
                              ? "bg-slate-100 border-slate-400 text-slate-800"
                              : "bg-white border-slate-300 text-slate-700 hover:border-slate-500"
                              }`}
                          >
                            {isImportant && (
                              <span className={`text-[9.5px] font-bold rounded-full px-1.5 py-0.5 leading-none select-none whitespace-nowrap ${isSelected
                                ? "text-rose-400 bg-rose-100"
                                : "text-rose-400 bg-rose-100"
                                }`}>
                                중요
                              </span>
                            )}
                            <span className={`text-[12.5px] select-none whitespace-nowrap font-medium ${isSelected ? "text-slate-800" : "text-slate-700"}`}>
                              {item.name}
                            </span>
                            {item.min && (
                              <span className={`text-[10.5px] font-medium select-none whitespace-nowrap ${isSelected ? "text-slate-500" : "text-slate-400"}`}>
                                {item.min}
                              </span>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      );
    };
  })(),



  Table: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const rawColumns: { key: string; label: string }[] = Array.isArray(p.columns) ? p.columns : [];
    const rows: Record<string, any>[] = Array.isArray(p.rows) ? p.rows : (Array.isArray(p.data) ? p.data : []);

    // ── TRANSPOSED TABLE (criteria = rows, products = columns) ──────────────
    const isTransposed = rawColumns[0]?.key === 'criterion';
    if (isTransposed) {
      const productCols = rawColumns.slice(1); // prod_0, prod_1, ...
      const rankRow = rows.find(r => r.criterion === '순위' || r.criterion === 'Rank');
      const dataRows = rows.filter(r => r.criterion !== '순위' && r.criterion !== 'Rank');
      const rankReasoning: string = p._rankReasoning || '';

      // rank 기준 오름차순 정렬 (1위 → 왼쪽)
      const sortedProductCols = rankRow
        ? [...productCols].sort((a, b) => {
            const ra = parseInt(String(rankRow[a.key] ?? '99').replace(/[^0-9]/g, '')) || 99;
            const rb = parseInt(String(rankRow[b.key] ?? '99').replace(/[^0-9]/g, '')) || 99;
            return ra - rb;
          })
        : productCols;

      return (
        <div className="w-full animate-in fade-in zoom-in-98 duration-300">
          <div className="overflow-x-auto pb-2">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr>
                  {/* 비교 항목 헤더 */}
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-100 w-[120px]">
                    {rawColumns[0]?.label ?? '비교 항목'}
                  </th>
                  {sortedProductCols.map((col, ci) => {
                    const rank = rankRow ? String(rankRow[col.key] ?? '') : '';
                    const isFirst = rank === '1위';
                    return (
                      <th key={col.key} className={`px-3 py-2.5 border-b border-slate-100 text-center ${isFirst ? 'bg-white' : ''}`}>
                        {rank && <div className="text-[10px] text-slate-400 font-semibold mb-1">{rank}</div>}
                        {col.imageUrl && (
                          <div className="flex justify-center mb-3">
                            <img
                              src={proxyImg(col.imageUrl)}
                              alt={col.label}
                              className="w-12 h-12 object-contain rounded-lg bg-white border border-slate-100"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          </div>
                        )}
                        <div className="text-[12px] font-semibold text-slate-700 leading-tight">
                          {col.label}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row, ri) => (
                  <tr key={ri} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                    <td className="px-3 py-2.5 text-[12px] font-semibold text-slate-700">{row.criterion}</td>
                    {sortedProductCols.map((col, ci) => {
                      const val = String(row[col.key] ?? '-');
                      const rankVal = rankRow ? String(rankRow[col.key] ?? '') : '';
                      const isFirst = rankVal === '1위';
                      return (
                        <td key={col.key} className={`px-3 py-2.5 text-center text-[13px] font-medium text-slate-700 ${isFirst ? 'bg-slate-50/60' : ''}`}>
                          {val === '-' ? <span className="text-[11px] text-slate-300 font-medium">미확인</span> : val}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rankReasoning && (
            <div className="mt-3 px-3 py-2.5 bg-white rounded-[8px] border border-slate-100">
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">이렇게 추천드린 이유예요</p>
              <p className="text-[12.5px] text-slate-600 leading-relaxed">{rankReasoning}</p>
            </div>
          )}
        </div>
      );
    }
    // ── END TRANSPOSED ──────────────────────────────────────────────────────


    const cellBadges: { row: string; column: string; label: string; type: string }[] =
      Array.isArray(p.cellBadges) ? p.cellBadges : [];

    const criteriaFromBindings: { name: string; min?: string; priority: string }[] =
      Array.isArray(allProps.bindings?.droppedCriteria) ? allProps.bindings.droppedCriteria : [];
    const savedItems: { name: string; price?: string; description?: string; specs?: string[]; link?: string }[] =
      Array.isArray(allProps.bindings?.savedItems) ? allProps.bindings.savedItems : [];

    // allColumns: 한 번이라도 추가된 컬럼 전체 (데이터 보존)
    const hasRank = rawColumns.some(c => c.key === 'rank');
    const initialColumns: { key: string; label: string }[] = hasRank
      ? rawColumns
      : [{ key: 'rank', label: 'Rank' }, ...rawColumns];
    const [allColumns, setAllColumns] = useState<{ key: string; label: string }[]>(initialColumns);
    // hiddenColumnKeys: 현재 숨겨진 컬럼 key 집합
    const [hiddenColumnKeys, setHiddenColumnKeys] = useState<Set<string>>(new Set());
    // visibleColumns: 실제 테이블에 표시되는 컬럼 (derived)
    const visibleColumns = allColumns.filter(c => !hiddenColumnKeys.has(c.key));

    const [extraRows, setExtraRows] = useState<Record<string, any>[]>([]);
    const [fetchedSpecs, setFetchedSpecs] = useState<Record<string, Record<string, string>>>({});
    const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());
    const [loadingCells, setLoadingCells] = useState<Set<string>>(new Set());
    const [showColumnsPanel, setShowColumnsPanel] = useState(false);
    const columnsPanelRef = useRef<HTMLDivElement>(null);

    // Column resize state
    const [colWidths, setColWidths] = useState<Record<string, number>>({});
    const colDragRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

    // 공백을 제거한 normalized 값으로도 비교 (예: "저장 공간" vs "저장공간")
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    // expandableOptions: allColumns에 없는 criteria만 (숨긴 컬럼도 제외)
    const expandableOptions = criteriaFromBindings
      .filter(c => {
        const parenMatches = c.name.match(/\(([^)]+)\)/g)?.map((m: string) => m.slice(1, -1)) ?? [];
        const baseName = c.name.replace(/\s*\([^)]+\)/g, '').trim();
        const variants = [c.name, baseName, ...parenMatches].map((v: string) => v.toLowerCase()).filter(Boolean);
        const variantsNorm = variants.map(normalize);
        return !allColumns.some(col => {
          const keyNorm = col.key.toLowerCase();
          const labelNorm = col.label.toLowerCase();
          const keyNoSpace = normalize(col.key);
          const labelNoSpace = normalize(col.label);
          return variants.some((v: string) =>
            keyNorm === v || labelNorm === v ||
            labelNorm.includes(v) || v.includes(labelNorm) ||
            keyNorm.includes(v) || v.includes(keyNorm)
          ) || variantsNorm.some((v: string) =>
            keyNoSpace === v || labelNoSpace === v ||
            labelNoSpace.includes(v) || v.includes(labelNoSpace) ||
            keyNoSpace.includes(v) || v.includes(keyNoSpace)
          );
        });
      })
      .map(c => ({ key: c.name, label: c.name }));




    const addColumn = async (col: { key: string; label: string }) => {
      // 이미 allColumns에 있지만 숨겨진 경우 → 그냥 보이게만
      if (allColumns.some(c => c.key === col.key)) {
        setHiddenColumnKeys(prev => { const s = new Set(prev); s.delete(col.key); return s; });
        return;
      }

      setAllColumns(prev => [...prev, col]);

      const firstColKey = 'product';
      const allCurrentRows = [...rows, ...extraRows];
      const products = allCurrentRows
        .map(row => {
          const name = String(row.product ?? row[firstColKey] ?? '');
          // Priority for link:
          // 1. _link embedded in the row (set by UI Agent from DATA CONTEXT)
          // 2. link from savedItems (My Items — set when user saves a product)
          // 3. Danawa search URL as fallback (fetch-spec will extract pcode if possible)
          let link = String(row._link ?? '');
          // Link priority:
          // 1. _link from existing table rows (set by UI Agent from Danawa scraping — most reliable)
          // 2. _link from row data directly
          // 3. savedItems.link (saved when user clicked heart on ProductCard)
          // 4. Danawa search URL as last resort
          if (!link) {
            const rowMatch = allCurrentRows.find(r => {
              const rn = String(r[firstColKey] ?? '').toLowerCase();
              const nn = name.toLowerCase();
              return rn === nn || rn.includes(nn) || nn.includes(rn);
            });
            link = rowMatch?._link ?? '';
          }
          if (!link) {
            const savedMatch = savedItems.find(item => {
              const a = item.name.toLowerCase(); const b = name.toLowerCase();
              return a === b || a.includes(b) || b.includes(a);
            });
            link = savedMatch?.link ?? '';
          }
          if (!link && name) {
            link = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(name)}&limit=1&sort=pd`;
          }
          console.log(`[addColumn] resolved link for "${name}": ${link.slice(0, 60)}`);
          return { name, link };
        })
        .filter(p => p.name);

      if (products.length === 0) return;

      setLoadingColumns(prev => new Set([...prev, col.key]));
      try {
        const res = await fetch('/api/fetch-spec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products, criteria: col.key }),
        });
        const data = await res.json() as Record<string, string>;
        setFetchedSpecs(prev => ({ ...prev, [col.key]: data }));

      } catch (err) {
        console.error('[Table] fetch-spec failed:', err);
      } finally {
        setLoadingColumns(prev => { const s = new Set(prev); s.delete(col.key); return s; });
      }
    };

    const removeColumn = (key: string) => {
      if (key === allColumns[0]?.key) return; // 첫 컬럼(제품명)은 제거 불가
      setHiddenColumnKeys(prev => new Set([...prev, key]));
    };

    const toggleColumn = (col: { key: string; label: string }) => {
      const isInAll = allColumns.some(c => c.key === col.key);
      const isHidden = hiddenColumnKeys.has(col.key);

      if (isInAll) {
        // 데이터 보존: visible 여부만 토글
        if (isHidden) {
          setHiddenColumnKeys(prev => { const s = new Set(prev); s.delete(col.key); return s; });
        } else {
          setHiddenColumnKeys(prev => new Set([...prev, col.key]));
        }
      } else {
        // 새 컬럼: fetch 포함해서 추가
        addColumn(col);
      }
    };

    const firstColKey = 'product';
    const allRows = [...rows, ...extraRows];
    const [hiddenRowKeys, setHiddenRowKeys] = useState<Set<string>>(new Set());
    const [showRowsPanel, setShowRowsPanel] = useState(false);
    const visibleRows = allRows.filter(row => !hiddenRowKeys.has(String(row[firstColKey] ?? '')));
    const currentProductNames = allRows.map(row => String(row[firstColKey] ?? '').toLowerCase());
    // 이름이 완전히 일치하지 않을 수 있으므로 부분 매칭으로 비교
    // (LLM이 생성한 짧은 이름 vs My Items의 전체 이름)
    const isAlreadyInTable = (itemName: string) => {
      const itemLower = itemName.toLowerCase();
      return currentProductNames.some(tableName =>
        tableName === itemLower ||
        tableName.includes(itemLower) ||
        itemLower.includes(tableName)
      );
    };
    const addableItems = savedItems.filter(item => !isAlreadyInTable(item.name));

    const addItemAsRow = async (item: { name: string; price?: string; link?: string }) => {
      console.log(`[addItemAsRow] called for "${item.name}"`);
      const newRow: Record<string, any> = { [firstColKey]: item.name };
      if (item.price) newRow['price'] = item.price;
      setExtraRows(prev => [...prev, newRow]);

      // 새로 추가된 제품에 대해서만 기존 컬럼들의 값을 fetch
      // (기존 제품들은 이미 값이 있으므로 건드리지 않음)
      const columnsToFetch = visibleColumns.slice(1).filter(col => col.key !== 'price');

      if (columnsToFetch.length === 0) {

        return;
      }

      // Link priority for the new row's product:
      // 1. _link from an existing table row with matching name (highest quality — from Danawa scraping)
      // 2. item.link from savedItems (saved when user clicked heart)
      // 3. Danawa search URL fallback (fetch-spec will try to extract pcode from results)
      let resolvedLink = item.link ?? '';
      if (!resolvedLink) {
        const existingRowMatch = [...rows, ...extraRows].find(r => {
          const rn = String(r[firstColKey] ?? '').toLowerCase();
          const itemLower = item.name.toLowerCase();
          return rn === itemLower || rn.includes(itemLower) || itemLower.includes(rn);
        });
        resolvedLink = existingRowMatch?._link ?? '';
      }
      if (!resolvedLink) {
        resolvedLink = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(item.name)}&limit=1&sort=pd`;
      }
      const product = { name: item.name, link: resolvedLink };
      console.log(`[addItemAsRow] fetching ${columnsToFetch.length} columns for "${item.name}" (link: ${resolvedLink.slice(0, 70)})`);

      // 새 제품의 모든 셀을 로딩 상태로 표시
      setLoadingCells(prev => {
        const next = new Set(prev);
        columnsToFetch.forEach(col => next.add(`${item.name}__${col.key}`));
        return next;
      });

      // Accumulate fetched values to pass to reevaluateWinners
      const newSpecValues: Record<string, Record<string, string>> = {};

      await Promise.all(
        columnsToFetch.map(async col => {
          const cellKey = `${item.name}__${col.key}`;
          try {
            const res = await fetch('/api/fetch-spec', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ products: [product], criteria: col.key }),
            });
            const data = await res.json() as Record<string, string>;
            console.log(`[Table] addItemAsRow "${col.key}" for "${item.name}":`, data);
            newSpecValues[col.key] = { ...(fetchedSpecs[col.key] ?? {}), ...data };
            setFetchedSpecs(prev => ({
              ...prev,
              [col.key]: { ...(prev[col.key] ?? {}), ...data },
            }));
          } catch (err) {
            console.error(`[Table] addItemAsRow fetch-spec failed for "${col.key}":`, err);
          } finally {
            setLoadingCells(prev => { const s = new Set(prev); s.delete(cellKey); return s; });
          }
        })
      );


    };


    const renderCell = (row: Record<string, any>, col: { key: string; label: string }, ci: number) => {
      const productName = String(row[firstColKey] ?? '');

      // 셀 단위 로딩: 새로 추가된 제품의 해당 셀만 스피너 표시
      if (ci > 0 && loadingCells.has(`${productName}__${col.key}`)) {
        return <span className="inline-block w-4 h-4 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" />;
      }
      // 컬럼 단위 로딩: addColumn으로 추가된 컬럼 전체 로딩
      if (ci > 0 && loadingColumns.has(col.key)) {
        return <span className="inline-block w-4 h-4 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" />;
      }

      // Use fetched spec value if available (from /api/fetch-spec)
      const fetchedValue = fetchedSpecs[col.key]?.[productName];
      const rawValue = fetchedValue !== undefined ? fetchedValue : row[col.key];
      const displayValue = rawValue != null ? String(rawValue) : '—';

      // Check for explicit badge
      const badge = cellBadges.find(b => b.row === productName && b.column === col.key);
      if (badge) {
        const badgeStyle =
          badge.type === 'warning'
            ? 'bg-red-50 text-red-500 border border-red-100'
            : badge.type === 'success'
              ? 'bg-green-50 text-green-600 border border-green-100'
              : 'bg-slate-50 text-slate-600 border border-slate-100';
        return (
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${badgeStyle}`}>
            {badge.label}
          </span>
        );
      }


      return displayValue;
    };


    // allColumns(rank/product 제외) + expandableOptions 합쳐서 패널에 표시
    const allManageableColumns = [
      ...allColumns.filter(c => c.key !== 'rank' && c.key !== 'product'),
      ...expandableOptions,
    ];

    return (
      <div className="w-full animate-in fade-in zoom-in-98 duration-300">
        {/* Table header row */}
        <div className="flex items-center justify-between mb-2">
          <div />
        </div>

        <div className="overflow-x-auto pb-4">
          <table className="w-full min-w-[500px] text-[13px] border-collapse">
            <thead>
              <tr className="border-b border-slate-100">
                {visibleColumns.map((col, ci) => {
                  const korNums = ['한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
                  const currentNum = korNums[allRows.length - 1] ?? `${allRows.length}개`;
                  const relNote = (col as any).relevanceNote as string | undefined;
                  const dynamicNote = relNote?.replace(
                    /[한두세네다섯여섯일곱여덟아홉열]\s*제품/g,
                    `${currentNum} 제품`
                  );


                  return (
                    <th
                      key={col.key}
                      className="relative text-left text-[11px] font-semibold tracking-wide uppercase px-3 py-2.5 text-slate-400"
                      style={colWidths[col.key] ? { width: colWidths[col.key], minWidth: colWidths[col.key] } : { whiteSpace: 'nowrap' }}
                    >
                      <span>{col.label}</span>
                      {/* Column resize handle */}
                      <div
                        className="absolute top-0 right-0 bottom-0 w-3 cursor-col-resize flex items-center justify-center group/cr select-none z-10"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const th = e.currentTarget.parentElement as HTMLTableCellElement;
                          const startWidth = th.getBoundingClientRect().width;
                          colDragRef.current = { key: col.key, startX: e.clientX, startWidth };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const d = colDragRef.current;
                          if (!d || d.key !== col.key) return;
                          const newWidth = Math.max(60, d.startWidth + (e.clientX - d.startX));
                          setColWidths(prev => ({ ...prev, [col.key]: newWidth }));
                        }}
                        onPointerUp={() => { colDragRef.current = null; }}
                      >
                        <div className="w-[2px] h-4 rounded-full bg-slate-200/0 group-hover/cr:bg-slate-300 transition-colors" />
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, i) => (
                <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                  {visibleColumns.map((col, ci) => {
                    const isRankCol = col.key === "rank";
                    const isProductCol = col.key === "product";
                    const rankVal = isRankCol ? String(row["rank"] ?? i + 1) : null;
                    return (
                      <td
                        key={col.key}
                        className={`py-2.5 text-slate-700 ${isRankCol ? 'px-2 w-10 text-center' : 'px-3'} ${isProductCol ? 'font-semibold text-slate-900' : 'font-normal'}`}
                        style={colWidths[col.key] ? { width: colWidths[col.key], minWidth: colWidths[col.key] } : undefined}
                      >
                        {isRankCol ? (
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold bg-slate-100 text-slate-500">
                            {rankVal}
                          </span>
                        ) : (
                          renderCell(row, col, ci)
                        )}
                      </td>
                    );
                  })}
                  {/* Trailing empty td to match phantom resizer th */}
                  <td className="w-3 min-w-[12px] p-0" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {p.emptyMessage && rows.length === 0 && (
          <p className="text-center text-[12px] text-slate-400 py-6">{p.emptyMessage}</p>
        )}

        {p._rankReasoning && visibleRows.length > 0 && (
          <div className="mt-4 p-4 rounded-[12px] bg-white border border-slate-100 animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles className="w-[14px] h-[14px] text-slate-400 shrink-0" />
              <span className="text-[12.5px] font-bold text-slate-800">이렇게 추천드린 이유예요</span>
            </div>
            <p className="text-[12px] text-slate-600 leading-relaxed font-medium">
              {p._rankReasoning}
            </p>
          </div>
        )}



      </div>
    );
  },


  ProductCard: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const delay = p._animationDelay || 0;
    const isDimmed = !!p._dimmed;           // 기준 미충족 → 흐리게
    const isUnconfirmed = !!(p._unconfirmed || (Array.isArray(p._unconfirmedCriteria) && p._unconfirmedCriteria.length > 0));
    const unconfirmedCriteria: string[] = Array.isArray(p._unconfirmedCriteria) && p._unconfirmedCriteria.length > 0
      ? p._unconfirmedCriteria
      : (p._unconfirmed ? ['미확인'] : []);
    const justUpdated = !!p._justUpdated;   // auto-enrich 업데이트 트리거

    // 하이라이트 애니메이션 상태 (업데이트 시 1.8초간 활성화)
    const [isHighlighted, setIsHighlighted] = useState(false);
    useEffect(() => {
      if (justUpdated) {
        setIsHighlighted(true);
        const t = setTimeout(() => setIsHighlighted(false), 1800);
        return () => clearTimeout(t);
      }
    }, [justUpdated]);

    return (
      <div
        className={`group relative flex flex-col bg-white border rounded-[8px] overflow-hidden transition-all duration-500 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] animate-in fade-in slide-in-from-bottom-3 zoom-in-98 duration-500 fill-mode-both w-full ${
          isDimmed
            ? "border-[#E5E5E5] opacity-40 grayscale-[50%] hover:opacity-55"
            : "border-[#EBEBEB] hover:border-[#D0D0D0]"
        }`}
        style={delay > 0 ? { animationDelay: `${delay}s` } : undefined}
      >
        {/* Product Image (Top) */}
        <div className="relative w-full aspect-[4/3] bg-[#F5F5F5] overflow-hidden">
          {/* 기준 미충족 뱃지 — 어떤 기준인지 표시 */}
          {isDimmed && (
            <div className="absolute top-2 left-2 z-10 bg-slate-700/80 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full max-w-[calc(100%-16px)] truncate">
              {(p._dimmedReasons && p._dimmedReasons.length > 0)
                ? `${p._dimmedReasons.join(', ')} 미충족`
                : '기준 미충족'}
            </div>
          )}

          {p.imageUrl ? (
            <img
              src={proxyImg(p.imageUrl)}
              alt={p.name}
              className="w-full h-full object-contain mix-blend-multiply"
              onError={(e) => {
                const el = e.currentTarget as HTMLImageElement;
                el.style.display = "none";
                const placeholder = el.nextElementSibling as HTMLElement | null;
                if (placeholder) placeholder.style.display = "flex";
              }}
            />
          ) : null}
          {/* Placeholder */}
          <div
            style={{ display: p.imageUrl ? "none" : "flex" }}
            className="w-full h-full items-center justify-center bg-[#F5F5F5] text-[#C8C8C8] absolute inset-0"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          {/* Heart button overlay */}
          {(() => {
            const savedItems = allProps.bindings?.savedItems ?? [];
            const isSaved = savedItems.some((item: any) => {
              const name = typeof item === "string" ? item : item.name;
              return name === p.name;
            });
            return (
              <HeartButton
                isSaved={isSaved}
                onAdd={() => {
                  const onItemAdd = allProps.bindings?.onItemAdd;
                  if (onItemAdd) onItemAdd(p.name, p.imageUrl, p.price, undefined, p.specs, p.link);
                  if (allProps.emit) allProps.emit("press", { product: p.name });
                }}
                onRemove={() => {
                  const onItemRemove = allProps.bindings?.onItemRemove;
                  if (onItemRemove) onItemRemove(p.name);
                }}
              />
            );
          })()}
        </div>

        {/* Product Info (Bottom) */}
        <div className="flex flex-col gap-1 p-2">
          {/* Brand */}
          {p.brand && (
            <span className="text-[9px] font-bold text-[#1A1A1A] leading-none">
              {p.brand}
            </span>
          )}
          {/* Product Name */}
          <p className="text-[11px] font-normal text-[#333333] leading-snug line-clamp-2">
            {p.name}
          </p>
          {/* Spec Chips + 미확인 태그 */}
          {(Array.isArray(p.specs) && p.specs.length > 0 || (!isDimmed && isUnconfirmed)) && (
            <div className="flex flex-wrap gap-1">
              {!isDimmed && unconfirmedCriteria.map((criterionName: string) => (
              <span
                  key={criterionName}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-medium bg-slate-50 text-slate-300 border border-slate-100"
                >
                  {criterionName === '미확인' ? '미확인' : `${criterionName} 미확인`}
                </span>
              ))}
              {Array.isArray(p.specs) && p.specs.length > 0 && (
                <SpecChips specs={p.specs} highlightFirst={isHighlighted} />
              )}
            </div>
          )}
          {/* Price */}
          <span className="text-[12px] font-bold text-[#1A1A1A] tracking-tight mt-0.5">
            {p.price}
          </span>
        </div>
      </div>
    );
  },


  ProductCardList: (allProps: any) => {

    const p = allProps?.props || allProps || {};
    const cards = Array.isArray(p.cards) ? p.cards : [];

    return (
      <div className="grid grid-cols-2 gap-3 w-full min-w-0 px-6">
        {cards.map((card: any, idx: number) => (
          <div key={`${card.name || card.id || 'card'}-${idx}`}>
            <manualRegistry.ProductCard {...allProps} props={{ ...card, _animationDelay: idx * 0.1 }} />
          </div>
        ))}
      </div>
    );
  },

  ComparisonSelector: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const { currentItems = [] } = p;
    const { savedItems = [], isFollowUp = false } = allProps.bindings || {};
    const emit = allProps.emit;
    const [isExpanded, setIsExpanded] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);

    // Filter out items already in the current comparison
    const availableItems = savedItems.filter((item: any) => {
      const name = typeof item === 'string' ? item : item.name;
      return !currentItems.includes(name);
    });

    if (availableItems.length === 0 && !isExpanded) return null;

    const toggleItem = (item: string) => {
      setSelected(prev =>
        prev.includes(item) ? prev.filter(i => i !== item) : [...prev, item]
      );
    };

    const handleConfirm = () => {
      if (selected.length === 0) return;
      emit?.("compareRequested", {
        products: [...currentItems, ...selected]
      });
      setIsExpanded(false);
      setSelected([]);
    };

    return (
      <div className="mt-4 flex flex-col gap-3 animate-in fade-in slide-in-from-top-2 duration-500">
        {!isExpanded ? (
          <div className="flex flex-col gap-2">
            {isFollowUp && (
              <div className="flex items-center gap-2 px-1">
                <span className="text-[12px] font-bold text-primary">비교 결과를 누적해서 볼 수 있게 제공</span>
              </div>
            )}
            <button
              onClick={() => setIsExpanded(true)}
              className="flex items-center justify-between w-fit gap-4 text-xs font-semibold bg-white border border-slate-100 rounded-full py-2.5 px-5 shadow-[0_4px_20px_rgba(0,0,0,0.03)] hover:border-slate-300 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)] transition-all group"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">🛒 MY OPTIONS</span>
                <span className="text-slate-700 font-medium">과 함께 비교하기</span>
              </div>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform text-slate-400" />
            </button>
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-2xl p-6 flex flex-col gap-5 shadow-[0_8px_40px_rgba(0,0,0,0.04)] border-slate-100/50">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                <span className="text-slate-400">🛒 MY OPTIONS</span>
                <span className="text-slate-800 font-medium">에 담아뒀던 다른 제품도 함께 비교하기</span>
              </div>
              <p className="text-[11px] text-slate-900 font-medium">비교에 추가할 제품을 선택해 주세요.</p>
            </div>

            <div className="flex flex-wrap gap-2 mt-2">
              {availableItems.map((item: any) => {
                const name = typeof item === 'string' ? item : item.name;
                const isSelected = selected.includes(name);
                return (
                  <div
                    key={name}
                    onClick={() => toggleItem(name)}
                    className={`flex items-center gap-2 px-4 h-[36px] rounded-full border transition-all cursor-pointer select-none ${isSelected
                      ? "bg-primary border-primary text-white shadow-md shadow-primary/10"
                      : "bg-white border-slate-100 text-slate-600 hover:border-slate-300 shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                      }`}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5 stroke-[3px] animate-in zoom-in duration-200" />}
                    <span className={`text-[13px] font-semibold leading-none ${isSelected ? "text-white" : "text-slate-700"}`}>
                      {name}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setIsExpanded(false)}
                className="flex-1 py-3 bg-slate-50 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-100 transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleConfirm}
                disabled={selected.length === 0}
                className="flex-[2] py-3 bg-primary text-white rounded-xl text-xs font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-all shadow-sm"
              >
                {selected.length}개의 제품 추가하여 비교하기
              </button>
            </div>
          </div>
        )}
      </div>
    );
  },
};



// =============================================================================
// InformationCard
// =============================================================================

manualRegistry.InformationCard = (allProps: any) => {
  const p = allProps?.props || allProps || {};
  const points: string[] = Array.isArray(p.points) ? p.points : [];
  return (
    <div className="my-2 flex flex-col gap-2 w-full animate-in fade-in zoom-in-98 duration-300">
      <div className="flex flex-col gap-1 border border-slate-200 rounded-xl bg-white px-4 pt-3.5 pb-4">
        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">개념 정리</span>
        <h3 className="text-[15px] font-black text-slate-900 tracking-tight leading-tight">{p.term}</h3>
        {p.summary && (
          <p className="text-[12px] text-slate-500 font-medium leading-relaxed mt-0.5">{p.summary}</p>
        )}
        {points.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {points.map((pt: string, i: number) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />
                <span className="text-[12px] text-slate-600 leading-relaxed">{pt}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};


export function Fallback({ type }: { type: string }) {
  if (type === 'Empty' || type === 'empty') return null;
  return (
    <div className="p-4 border border-dashed rounded-lg text-muted-foreground text-sm">
      Unknown component: {type}
    </div>
  );
}

