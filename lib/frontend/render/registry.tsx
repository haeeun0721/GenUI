"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, Heart, Check, AlertTriangle, Lightbulb, ArrowRight, Columns3, LayoutList, Sparkles } from "lucide-react";


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
// Registry
// =============================================================================

export const manualRegistry: Record<string, any> = {
  Empty: () => null,

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
        </div>
        {/* 왜 충돌하나요 */}
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">왜 충돌하나요</span>
          <p className="text-[11px] text-slate-600 leading-relaxed">{whyText}</p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          {p.onDismiss && (
            <button
              onClick={p.onDismiss}
              className="text-[11px] font-medium text-slate-400 hover:text-slate-600 border border-slate-200 rounded-full px-3 py-1 transition-colors"
            >
              괜찮아요
            </button>
          )}
          {p.onResolve && (
            <button
              onClick={p.onResolve}
              className="text-[11px] font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-full px-3 py-1 transition-colors"
            >
              조율 도움받기 ↗
            </button>
          )}
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
      <div className={`flex flex-col gap-2 p-3 rounded-[10px] bg-white border border-black/[0.04]${skipAnimation ? '' : ' animate-in fade-in slide-in-from-top-2 duration-300'}`}>
        <div className="flex items-center gap-1.5 mb-1">
          <Lightbulb className="w-[14px] h-[14px] text-slate-800 shrink-0" />
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
      }, [categories]);

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
    // Always ensure rank is the first column — inject if AI omitted it
    const hasRank = rawColumns.some(c => c.key === 'rank');
    const initialColumns: { key: string; label: string }[] = hasRank
      ? rawColumns
      : [{ key: 'rank', label: 'Rank' }, ...rawColumns];
    const rows: Record<string, any>[] = Array.isArray(p.rows) ? p.rows : (Array.isArray(p.data) ? p.data : []);



    const cellBadges: { row: string; column: string; label: string; type: string }[] =
      Array.isArray(p.cellBadges) ? p.cellBadges : [];

    const criteriaFromBindings: { name: string; min?: string; priority: string }[] =
      Array.isArray(allProps.bindings?.droppedCriteria) ? allProps.bindings.droppedCriteria : [];
    const savedItems: { name: string; price?: string; description?: string; specs?: string[]; link?: string }[] =
      Array.isArray(allProps.bindings?.savedItems) ? allProps.bindings.savedItems : [];

    // allColumns: 한 번이라도 추가된 컬럼 전체 (데이터 보존)
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
        {/* Table header row: trophy legend + Columns button */}
        <div className="flex items-center justify-between mb-2">
          <div />

          {/* Columns + Rows buttons — always visible */}
          {(allManageableColumns.length > 0 || allRows.length > 0) && (
            <div className="flex items-center gap-2">
              {/* Rows button */}
              {allRows.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => { setShowRowsPanel(prev => !prev); setShowColumnsPanel(false); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
                  >
                    <LayoutList className="w-3 h-3 text-slate-400" />
                    Rows
                  </button>

                  {showRowsPanel && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowRowsPanel(false)} />
                      <div className="absolute right-0 top-[calc(100%+6px)] z-20 bg-white border border-slate-200 rounded-[10px] shadow-[0_8px_30px_rgba(0,0,0,0.1)] w-[220px] py-2 animate-in fade-in zoom-in-95 duration-150">
                        {/* 현재 테이블 행들 */}
                        {allRows.map(row => {
                          const productName = String(row[firstColKey] ?? '');
                          const isChecked = !hiddenRowKeys.has(productName);
                          const isMyItem = savedItems.some(item => {
                            const a = item.name.toLowerCase(); const b = productName.toLowerCase();
                            return a === b || a.includes(b) || b.includes(a);
                          });
                          return (
                            <button
                              key={productName}
                              onClick={() => setHiddenRowKeys(prev => {
                                const s = new Set(prev);
                                if (s.has(productName)) s.delete(productName); else s.add(productName);
                                return s;
                              })}
                              className="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors text-left"
                            >
                              <div className={`w-4 h-4 rounded-[4px] border flex items-center justify-center shrink-0 transition-all ${isChecked ? 'bg-slate-900 border-slate-900' : 'border-slate-300 bg-white'
                                }`}>
                                {isChecked && <Check className="w-2.5 h-2.5 text-white stroke-[3px]" />}
                              </div>
                              <span className="text-[12px] text-slate-700 font-medium flex-1 truncate">{productName}</span>
                              {isMyItem && (
                                <span className="text-[9px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded-full px-1.5 py-0.5 shrink-0 leading-none">내 항목</span>
                              )}
                            </button>
                          );
                        })}

                        {/* 추가 가능한 My Items */}
                        {addableItems.length > 0 && (
                          <>
                            <div className="border-t border-slate-100 my-1" />
                            {addableItems.map(item => (
                              <button
                                key={item.name}
                                onClick={() => { addItemAsRow(item); setShowRowsPanel(false); }}
                                className="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors text-left"
                              >
                                <div className="w-4 h-4 rounded-[4px] border border-slate-300 bg-white flex items-center justify-center shrink-0" />
                                <span className="text-[12px] text-slate-500 font-medium flex-1 truncate">{item.name}</span>
                                <span className="text-[9px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded-full px-1.5 py-0.5 shrink-0 leading-none">내 항목</span>
                              </button>
                            ))}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Columns button */}
              {allManageableColumns.length > 0 && (
                <div className="relative" ref={columnsPanelRef}>
                  <button
                    onClick={() => setShowColumnsPanel(prev => !prev)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
                  >
                    <Columns3 className="w-3 h-3 text-slate-400" />
                    Columns
                  </button>

                  {showColumnsPanel && (
                    <>
                      {/* Backdrop */}
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setShowColumnsPanel(false)}
                      />
                      {/* Panel */}
                      <div className="absolute right-0 top-[calc(100%+6px)] z-20 bg-white border border-slate-200 rounded-[10px] shadow-[0_8px_30px_rgba(0,0,0,0.1)] w-[200px] py-2 animate-in fade-in zoom-in-95 duration-150">
                        {/* First column (product) — always on, grayed out */}
                        <div className="flex items-center gap-3 px-4 py-2 opacity-40 cursor-not-allowed">
                          <div className="w-4 h-4 rounded-[4px] bg-slate-900 flex items-center justify-center shrink-0">
                            <Check className="w-2.5 h-2.5 text-white stroke-[3px]" />
                          </div>
                          <span className="text-[12px] text-slate-700 font-medium flex-1 truncate">{allColumns[0]?.label ?? '제품'}</span>
                        </div>

                        <div className="border-t border-slate-100 my-1" />

                        {allManageableColumns.map(col => {
                          const isChecked = allColumns.some(c => c.key === col.key) && !hiddenColumnKeys.has(col.key);
                          const isLoading = loadingColumns.has(col.key);
                          const isMyCriteria = criteriaFromBindings.some(c => {
                            const a = normalize(c.name); const b = normalize(col.key);
                            return a === b || a.includes(b) || b.includes(a);
                          });
                          return (
                            <button
                              key={col.key}
                              onClick={() => toggleColumn(col)}
                              className="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors text-left"
                            >
                              <div className={`w-4 h-4 rounded-[4px] border flex items-center justify-center shrink-0 transition-all ${isChecked ? 'bg-slate-900 border-slate-900' : 'border-slate-300 bg-white'
                                }`}>
                                {isChecked && <Check className="w-2.5 h-2.5 text-white stroke-[3px]" />}
                              </div>
                              <span className="text-[12px] text-slate-700 font-medium flex-1 truncate">{col.label}</span>
                              {isMyCriteria && (
                                <span className="text-[9px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded-full px-1.5 py-0.5 shrink-0 leading-none">내 기준</span>
                              )}
                              {isLoading && (
                                <span className="w-3 h-3 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
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
                    <th key={col.key} className="text-left text-[11px] font-semibold tracking-wide uppercase px-3 py-2.5 whitespace-nowrap text-slate-400">
                      <span>{col.label}</span>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {p.emptyMessage && rows.length === 0 && (
          <p className="text-center text-[12px] text-slate-400 py-6">{p.emptyMessage}</p>
        )}

        {p._rankReasoning && visibleRows.length > 0 && (
          <div className="mt-4 p-4 rounded-[12px] bg-slate-50 border border-slate-100 animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles className="w-[14px] h-[14px] text-blue-500 shrink-0" />
              <span className="text-[12.5px] font-bold text-slate-800">순위 산정 기준 (AI 분석)</span>
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

    return (
      <div
        className="group relative flex flex-row bg-white border border-[#EBEBEB] rounded-[8px] p-3 gap-3 transition-all duration-200 hover:border-[#D0D0D0] hover:shadow-[0_2px_12px_rgba(0,0,0,0.07)] animate-in fade-in slide-in-from-bottom-3 zoom-in-98 duration-500 fill-mode-both w-full"
        style={delay > 0 ? { animationDelay: `${delay}s` } : undefined}
      >
        {/* Product Image (Left) — same height as text content */}
        <div className="relative w-[140px] self-stretch rounded-[6px] bg-[#F5F5F5] overflow-hidden shrink-0">
          {p.imageUrl ? (
            <img
              src={p.imageUrl}
              alt={p.name}
              className="w-full h-full object-contain"
              onError={(e) => {
                // CDN URL 404 fallback — replace with placeholder svg
                const el = e.currentTarget as HTMLImageElement;
                el.style.display = "none";
                const placeholder = el.nextElementSibling as HTMLElement | null;
                if (placeholder) placeholder.style.display = "flex";
              }}
            />
          ) : null}
          {/* Placeholder (shown when no imageUrl or image fails to load) */}
          <div
            style={{ display: p.imageUrl ? "none" : "flex" }}
            className="w-full h-full items-center justify-center bg-[#F5F5F5] text-[#C8C8C8] absolute inset-0"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                  // Pass p.link so My Items remembers the Danawa product URL for later spec scraping
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

        {/* Product Info (Right) */}
        <div className="flex flex-col flex-1 min-w-0 justify-between py-0.5">
          <div className="flex flex-col gap-0.5">
            {/* Brand */}
            {p.brand && (
              <span className="text-[11px] font-bold text-[#1A1A1A] leading-none">
                {p.brand}
              </span>
            )}
            {/* Product Name */}
            <p className="text-[12.5px] font-normal text-[#333333] leading-snug line-clamp-2 mt-0.5">
              {p.name}
            </p>
            {/* Spec Chips */}
            {Array.isArray(p.specs) && p.specs.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {p.specs.slice(0, 3).map((spec: string, i: number) => (
                  <span
                    key={i}
                    className="text-[10px] text-[#666666] bg-[#F5F5F5] px-2 py-0.5 rounded-full whitespace-nowrap"
                  >
                    {spec}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Price */}
          <div className="flex items-center justify-between mt-2">
            <span className="text-[15px] font-bold text-[#1A1A1A] tracking-tight">
              {p.price}
            </span>
          </div>
        </div>
      </div>
    );
  },


  ProductCardList: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const cards = Array.isArray(p.cards) ? p.cards : [];

    return (
      <div className="grid grid-cols-1 gap-3 w-full min-w-0">
        {cards.map((card: any, idx: number) => (
          <div key={`${card.name || card.id || 'card'}-${idx}`}>
            {manualRegistry.ProductCard({ ...allProps, props: { ...card, _animationDelay: idx * 0.1 } })}
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

