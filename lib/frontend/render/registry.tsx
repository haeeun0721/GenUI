"use client";

import { useState, useRef, useEffect, useLayoutEffect, Fragment } from "react";
import { ChevronDown, Heart, Check, AlertTriangle, Lightbulb, ArrowRight, Columns3, LayoutList, Sparkles, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// danuri.io / danawa.com 이미지는 hotlink protection이 걸려 있어 서버 프록시를 통해 로드
const PROXY_DOMAINS = ["img.danuri.io", "img.danawa.com", "prod.danawa.com"];
function proxyImg(url?: string): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname;
    if (PROXY_DOMAINS.some(d => host === d || host.endsWith("." + d))) {
      return `/api/img-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch { }
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
// i18n — every registry component reads its locale from allProps.bindings.locale
// (set by app/page.tsx's `locale` state), defaulting to "ko" when absent.
// =============================================================================

type UILocale = "ko" | "en";

function resolveLocale(allProps: any): UILocale {
  return allProps?.bindings?.locale === "en" ? "en" : "ko";
}

const T = {
  ko: {
    collapse: "접기 ↑",
    showMore: (n: number) => `+${n}개 ↓`,
    ragNotFoundDefault: "요청하신 기준에 해당하는 제품 데이터가 현재 DB에 없습니다.",
    ragNotFoundTitle: "DB에서 찾을 수 없는 기준이에요",
    ragNotFoundFooter: "더 일반적인 조건으로 다시 검색해보거나, 해당 기능에 대해 질문해주세요.",
    coverageTitle: "일부 기준이 반영되지 않았어요",
    applied: "반영됨",
    skipped: "미반영",
    coverageFooter: "미반영 기준은 현재 DB에 스펙 데이터가 없어요.",
    whyTradeoff: "왜 이런 딜레마가 생기나요",
    unchartedTitle: "아직 탐색하지 않은 영역",
    unexploredSectionTitle: "이 영역도 탐색해보는 건 어떨까요?",
    important: "중요",
    criteriaMapEmpty: "대화를 시작하면\n여기에 탐색 기록이 쌓여요",
    criterionColumn: "비교 항목",
    unverified: "(추정)",
    unverifiedFor: (name: string) => `${name} (추정)`,
    notFound: "정보 없음",
    notFoundFor: (name: string) => `${name} 정보 없음`,
    whyRecommended: "이렇게 추천드린 이유예요",
    cancel: "취소",
    addAndCompare: (n: number) => `${n}개의 제품 추가하여 비교하기`,
    myOptionsCompareWith: "과 함께 비교하기",
    myOptionsExpandedTitle: "에 담아뒀던 다른 제품도 함께 비교하기",
    selectToCompare: "비교에 추가할 제품을 선택해 주세요.",
    followUpBanner: "비교 결과를 누적해서 볼 수 있게 제공",
    concept: "개념 정리",
    askAboutCriterion: (label: string) => `"${label}" 기준에 대해 알려줘`,
  },
  en: {
    collapse: "Collapse ↑",
    showMore: (n: number) => `+${n} more ↓`,
    ragNotFoundDefault: "No product data in the current DB matches the requested criteria.",
    ragNotFoundTitle: "Criteria not found in DB",
    ragNotFoundFooter: "Try a more general condition, or ask about this feature directly.",
    coverageTitle: "Some criteria weren't applied",
    applied: "Applied",
    skipped: "Skipped",
    coverageFooter: "Skipped criteria have no spec data in the current DB.",
    whyTradeoff: "Why this trade-off happens",
    unchartedTitle: "Unexplored areas",
    unexploredSectionTitle: "You might also want to explore",
    important: "Key",
    criteriaMapEmpty: "Start a conversation\nand your exploration history will appear here",
    criterionColumn: "Criteria",
    unverified: "(est.)",
    unverifiedFor: (name: string) => `${name} (est.)`,
    notFound: "Not found",
    notFoundFor: (name: string) => `${name} info not found`,
    whyRecommended: "Why we recommend this",
    cancel: "Cancel",
    addAndCompare: (n: number) => `Add ${n} product${n === 1 ? "" : "s"} and compare`,
    myOptionsCompareWith: " — compare together",
    myOptionsExpandedTitle: " — compare with other items you've saved",
    selectToCompare: "Select the products to add to the comparison.",
    followUpBanner: "Comparison results are shown cumulatively",
    concept: "Concept",
    askAboutCriterion: (label: string) => `Tell me about the "${label}" criterion`,
  },
} as const;

// =============================================================================
// SpecChips — 스펙 칩 접기/펼치기 컴포넌트
// =============================================================================

const SPEC_COLLAPSED_COUNT = 4;

function SpecChips({ specs, locale = "ko" }: { specs: string[]; locale?: UILocale }) {
  const [expanded, setExpanded] = useState(false);
  const t = T[locale];
  if (!Array.isArray(specs) || specs.length === 0) return null;
  const visible = expanded ? specs : specs.slice(0, SPEC_COLLAPSED_COUNT);
  const hiddenCount = specs.length - SPEC_COLLAPSED_COUNT;
  const hasMore = hiddenCount > 0;
  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {visible.map((spec: string, i: number) => (
        <span
          key={i}
          className="text-[9px] text-[#666666] bg-[#F5F5F5] px-1.5 py-0.5 rounded-full max-w-full break-words"
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
          {expanded ? t.collapse : t.showMore(hiddenCount)}
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
    const t = T[resolveLocale(allProps)];
    const message: string = p.message || t.ragNotFoundDefault;
    const skipped: string[] = p.skippedCriteria || [];
    return (
      <div className="flex flex-col gap-3 w-full rounded-xl border border-slate-200 bg-white px-4 py-4 animate-highlight-wrap">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="text-[13px] font-semibold text-slate-700">{t.ragNotFoundTitle}</span>
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
        <p className="text-[11px] text-slate-400">{t.ragNotFoundFooter}</p>
      </div>
    );
  },


  CoverageNotice: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const t = T[resolveLocale(allProps)];
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
      <div className="flex flex-col gap-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 animate-highlight-wrap">
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-[11px] font-semibold text-slate-600">{t.coverageTitle}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {applied.map((c: string, i: number) => (
            <Chip key={`a-${i}`} label={c} badgeLabel={t.applied} badgeClass="text-emerald-600 bg-emerald-50 border-emerald-100" dotClass="bg-emerald-400" />
          ))}
          {skipped.map((c: string, i: number) => (
            <Chip key={`s-${i}`} label={c} badgeLabel={t.skipped} badgeClass="text-amber-500 bg-amber-50 border-amber-100" dotClass="bg-amber-400" />
          ))}
        </div>
        <p className="text-[10.5px] text-slate-400">{t.coverageFooter}</p>
      </div>
    );
  },

  TradeoffHint: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const t = T[resolveLocale(allProps)];
    if (!p.conflictsWith) return null;
    const whyText = p.why || p.reason;
    if (!whyText) return null;

    return (
      <div className="flex flex-col border border-slate-200 rounded-xl overflow-hidden w-full bg-white px-3.5 pt-3 pb-3 gap-2 animate-highlight-wrap">
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
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t.whyTradeoff}</span>
          <p className="text-[11px] text-slate-600 leading-relaxed">{whyText}</p>
        </div>
      </div>
    );
  },


  UnchartedTerritoryChip: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const t = T[resolveLocale(allProps)];
    const labels: string[] = Array.isArray(p.labels) ? p.labels : [];
    const onExplore: ((label: string) => void) | undefined = p.onExplore;
    const skipAnimation: boolean = p.skipAnimation === true;

    if (labels.length === 0) return null;

    return (
      <div className={`flex flex-col gap-2 p-3 rounded-[10px] bg-white${skipAnimation ? '' : ' animate-highlight-wrap'}`}>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[13.5px] font-semibold text-slate-800">{t.unchartedTitle}</span>
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
      const t = T[resolveLocale(allProps)];
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

      // 카테고리 DOM 노드 ref (label 기준) — 새로 생긴 카테고리/항목이 화면 밖에 있어도
      // 자동으로 스크롤해서 보여주기 위함
      const categoryElRefs = useRef<Record<string, HTMLDivElement | null>>({});

      // categories 배열은 매 렌더마다 새 참조가 생성되므로 JSON 직렬화로 실제 내용 변화만 감지
      const categoriesKey = JSON.stringify(categories);

      useEffect(() => {
        if (categories.length === 0) {
          globalSeenCats.clear();
          globalSeenChips.clear();
          setAnimatingKeys(new Set());
          return;
        }

        // 맨 처음 카테고리들이 한꺼번에 채워지는 시점(globalSeenCats가 비어있었음)에는
        // "새로 추가됨"으로 보지 않는다 — 그 경우 스크롤을 맨 밑으로 튀기는 게 아니라
        // 패널을 처음 열었을 때처럼 맨 위에서 시작해야 한다.
        const isFirstPopulation = globalSeenCats.size === 0;

        const newKeys = new Set<string>();
        let hasNew = false;
        const newImportantCatIndices = new Set<number>();
        // 새로 생긴 카테고리/항목이 있으면 그 위치로 자동 스크롤한다 — 새 카테고리가 있으면
        // 그걸 우선하고, 없으면(기존 카테고리에 항목만 추가된 경우) 그 항목이 속한 카테고리로.
        let scrollTargetLabel: string | null = null;

        categories.forEach((c) => {
          if (!globalSeenCats.has(c.label)) {
            newKeys.add(`cat::${c.label}`);
            globalSeenCats.add(c.label);
            hasNew = true;
            scrollTargetLabel = c.label;
          }
          (Array.isArray(c.items) ? c.items : []).forEach((i: any) => {
            const chipKey = `${c.label}::${i.name}`;
            if (!globalSeenChips.has(chipKey)) {
              newKeys.add(`chip::${chipKey}`);
              globalSeenChips.add(chipKey);
              hasNew = true;
              if (!scrollTargetLabel) scrollTargetLabel = c.label;

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

        if (!isFirstPopulation && scrollTargetLabel) {
          const label = scrollTargetLabel;
          // DOM에 새 카테고리/칩이 그려진 뒤에 스크롤해야 하므로 다음 프레임으로 미룬다
          requestAnimationFrame(() => {
            categoryElRefs.current[label]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [categoriesKey]);

      if (categories.length === 0) {
        return (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
              {t.criteriaMapEmpty.split("\n").map((line, i) => (
                <Fragment key={i}>{i > 0 && <br />}{line}</Fragment>
              ))}
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
                <span className="text-[13.5px] font-bold text-slate-600 tracking-tight">{t.unexploredSectionTitle}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {unexploredCategories.filter((cat: any) => !dismissedUnexplored.has(cat.label)).map((cat: any, i: number) => {
                  const isCatNew = animatingKeys.has(`cat::${cat.label}`);
                  return (
                    <div
                      key={i}
                      className={`flex items-center gap-1.5 rounded-full px-3 h-[32px] border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer active:scale-[0.98]${isCatNew ? " animate-highlight-wrap" : ""}`}
                      style={isCatNew ? { animationDelay: `${i * 0.05}s` } : undefined}
                      onAnimationEnd={(e) => {
                        if (isCatNew && e.animationName === 'highlight-wrap') {
                          setAnimatingKeys(prev => {
                            const next = new Set(prev);
                            next.delete(`cat::${cat.label}`);
                            return next;
                          });
                        }
                      }}
                      onClick={() => {
                        setDismissedUnexplored(prev => new Set(prev).add(cat.label));
                        allProps.bindings?.onSubmitChat?.(t.askAboutCriterion(cat.label));
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
                className={`border border-slate-200 rounded-[8px]${isCatNew ? " animate-highlight-wrap" : ""}`}
                style={isCatNew ? { animationDelay: `${ci * 0.07}s` } : undefined}
                onAnimationEnd={(e) => {
                  if (isCatNew && e.animationName === 'highlight-wrap') {
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
                          className={`relative rounded-full${isNew ? " animate-highlight-wrap" : ""}`}
                          style={isNew ? { animationDelay: `${ii * 0.05}s` } : undefined}
                          onAnimationEnd={(e) => {
                            if (isNew && e.animationName === 'highlight-wrap') {
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
                                {t.important}
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



  Table: (() => {
    // 모듈 스코프 seen-set — CriteriaMap과 동일한 패턴으로, 이미 본 기준(행)/제품(열)은
    // 다시 애니메이션하지 않고 진짜 새로 추가된 것만 하이라이트한다.
    const globalSeenRows = new Set<string>();
    const globalSeenCols = new Set<string>();

    return (allProps: any) => {
      const p = allProps?.props || allProps || {};
      const locale = resolveLocale(allProps);
      const t = T[locale];
      const rawColumns: { key: string; label: string; imageUrl?: string }[] = Array.isArray(p.columns) ? p.columns : [];
      const rows: Record<string, any>[] = Array.isArray(p.rows) ? p.rows : (Array.isArray(p.data) ? p.data : []);

      // ── TRANSPOSED TABLE (criteria = rows, products = columns) ──────────────
      const isTransposed = rawColumns[0]?.key === 'criterion';

      const transposedDataRows = isTransposed ? rows.filter(r => r.criterion !== '순위' && r.criterion !== 'Rank') : [];
      const transposedProductCols = isTransposed ? rawColumns.slice(1) : [];
      const rowsColsKey = JSON.stringify({
        rows: transposedDataRows.map(r => r.criterion),
        cols: transposedProductCols.map(c => c.key),
      });

      // rank 기준 오름차순 정렬 (1위 → 왼쪽). 훅보다 먼저 계산해 FLIP 이펙트의 의존성으로 쓴다.
      const productCols = isTransposed ? rawColumns.slice(1) : [];
      const rankRow = isTransposed ? rows.find(r => r.criterion === '순위' || r.criterion === 'Rank') : undefined;
      const sortedProductCols = rankRow
        ? [...productCols].sort((a, b) => {
          const ra = parseInt(String(rankRow[a.key] ?? '99').replace(/[^0-9]/g, '')) || 99;
          const rb = parseInt(String(rankRow[b.key] ?? '99').replace(/[^0-9]/g, '')) || 99;
          return ra - rb;
        })
        : productCols;
      const sortedColKeysStr = sortedProductCols.map(c => c.key).join(',');

      // 새로 추가된 행/열만 구분해서 하이라이트하기 위한 상태 (CriteriaMap의 animatingKeys와 동일한 목적)
      const [animatingRowKeys, setAnimatingRowKeys] = useState<Set<string>>(new Set());
      const [animatingColKeys, setAnimatingColKeys] = useState<Set<string>>(new Set());
      // 표 전체가 처음 생성되는 순간에만 켜지는 플래그 — 개별 행/열 대신 표 전체를 감싸서 하이라이트한다.
      const [justCreated, setJustCreated] = useState(false);
      const tableRef = useRef<HTMLTableElement>(null);
      // 열의 마지막 측정 위치(px) — 새 열 추가가 아니라 "기존 열의 순위가 바뀌어 자리가 이동"할 때
      // FLIP(First-Last-Invert-Play) 기법으로 이동을 보여주기 위해 이전 위치를 기억해둔다.
      const prevColRectsRef = useRef<Map<string, number>>(new Map());

      useEffect(() => {
        if (!isTransposed) return;
        if (transposedDataRows.length === 0 && transposedProductCols.length === 0) {
          globalSeenRows.clear();
          globalSeenCols.clear();
          setAnimatingRowKeys(new Set());
          setAnimatingColKeys(new Set());
          return;
        }
        // 표가 통째로 처음 채워지는 시점엔 "새로 추가됨"으로 보지 않는다(전부 애니메이션되는 것 방지).
        // 대신 표 전체를 한 번만 감싸는 하이라이트를 보여준다.
        const isFirstPopulation = globalSeenRows.size === 0 && globalSeenCols.size === 0;

        const newRowKeys = new Set<string>();
        for (const r of transposedDataRows) {
          const key = String(r.criterion ?? '');
          if (key && !globalSeenRows.has(key)) { newRowKeys.add(key); globalSeenRows.add(key); }
        }
        const newColKeys = new Set<string>();
        for (const c of transposedProductCols) {
          if (!globalSeenCols.has(c.key)) { newColKeys.add(c.key); globalSeenCols.add(c.key); }
        }

        if (isFirstPopulation) {
          setJustCreated(true);
          const t = setTimeout(() => setJustCreated(false), 2000);
          return () => clearTimeout(t);
        } else {
          if (newRowKeys.size > 0) setAnimatingRowKeys(prev => new Set([...prev, ...newRowKeys]));
          if (newColKeys.size > 0) setAnimatingColKeys(prev => new Set([...prev, ...newColKeys]));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [rowsColsKey, isTransposed]);

      // FLIP: 새 열이 아니라 기존 열의 순위가 바뀌어 자리만 이동할 때(예: 2위였던 제품이 1위가 됨)도
      // "정렬됐다"는 게 눈에 보이도록, 이전 위치 → 새 위치로 슬라이드하는 모션을 준다.
      useLayoutEffect(() => {
        if (!isTransposed || !tableRef.current) return;
        const table = tableRef.current;
        const prevRects = prevColRectsRef.current;
        const currentRects = new Map<string, number>();
        const movedKeys: string[] = [];

        for (const key of sortedColKeysStr ? sortedColKeysStr.split(',') : []) {
          const th = table.querySelector<HTMLElement>(`th[data-col-key="${key}"]`);
          if (!th) continue;
          const left = th.getBoundingClientRect().left;
          currentRects.set(key, left);
          const prevLeft = prevRects.get(key);
          if (prevLeft !== undefined && Math.abs(prevLeft - left) > 1) {
            const delta = prevLeft - left;
            const cells = table.querySelectorAll<HTMLElement>(`[data-col-key="${key}"]`);
            cells.forEach(cell => {
              cell.style.transition = 'none';
              cell.style.transform = `translateX(${delta}px)`;
            });
            movedKeys.push(key);
          }
        }

        if (movedKeys.length > 0) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              movedKeys.forEach(key => {
                const cells = table.querySelectorAll<HTMLElement>(`[data-col-key="${key}"]`);
                cells.forEach(cell => {
                  cell.style.transition = 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
                  cell.style.transform = '';
                });
              });
            });
          });
        }

        prevColRectsRef.current = currentRects;
      }, [isTransposed, sortedColKeysStr]);

      if (isTransposed) {
        const dataRows = transposedDataRows;
        const rankReasoning: string = p._rankReasoning || '';

        return (
          <div className="w-full">
            <div className={`overflow-x-auto pb-2${justCreated ? ' animate-highlight-wrap' : ''}`}>
              <table ref={tableRef} className="w-full text-[13px] border-collapse">
                <thead>
                  <tr>
                    {/* 비교 항목 헤더 */}
                    <th className="align-top text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-100 w-[120px]">
                      {rawColumns[0]?.label ?? t.criterionColumn}
                    </th>
                    {sortedProductCols.map((col, ci) => {
                      const rank = rankRow ? String(rankRow[col.key] ?? '') : '';
                      const isFirst = rank === '1위' || rank === '#1';
                      // 이름이 길면 여러 줄로 줄바꿈되면서 그 컬럼만 셀 높이가 커지고(테이블 기본
                      // vertical-align: middle 때문에) 다른 컬럼의 순위 라벨이 아래로 밀려
                      // "튀어나온" 것처럼 보인다. align-top(위에서 처리)으로 정렬을 고정하고,
                      // 여기서는 긴 이름의 글자 크기를 줄여 애초에 줄바꿈 자체를 줄인다.
                      const nameSizeClass = col.label.length > 14 ? 'text-[10px]' : col.label.length > 9 ? 'text-[11px]' : 'text-[12px]';
                      const isColNew = animatingColKeys.has(col.key);
                      return (
                        <th
                          key={col.key}
                          data-col-key={col.key}
                          className={`align-top px-3 py-2.5 border-b border-slate-100 text-center ${isFirst ? 'bg-white' : ''}${isColNew ? ' animate-highlight-wrap' : ''}`}
                          onAnimationEnd={(e) => {
                            if (isColNew && e.animationName === 'highlight-wrap') {
                              setAnimatingColKeys(prev => { const next = new Set(prev); next.delete(col.key); return next; });
                            }
                          }}
                        >
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
                          <div
                            className={`${nameSizeClass} font-semibold text-slate-700 leading-tight`}
                            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                            title={col.label}
                          >
                            {col.label}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {dataRows.map((row, ri) => {
                    const isRowNew = animatingRowKeys.has(String(row.criterion ?? ''));
                    return (
                      <tr
                        key={row.criterion ?? ri}
                        className={`border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors${isRowNew ? ' animate-highlight-wrap' : ''}`}
                        onAnimationEnd={(e) => {
                          if (isRowNew && e.animationName === 'highlight-wrap') {
                            setAnimatingRowKeys(prev => { const next = new Set(prev); next.delete(String(row.criterion ?? '')); return next; });
                          }
                        }}
                      >
                        <td className="px-3 py-2.5 text-[12px] font-semibold text-slate-700">{row.criterion}</td>
                        {sortedProductCols.map((col, ci) => {
                          const val = String(row[col.key] ?? '-');
                          const rankVal = rankRow ? String(rankRow[col.key] ?? '') : '';
                          const isFirst = rankVal === '1위' || rankVal === '#1';
                          // "배터리 수명: EVF 680장 / LCD 740장 / ..." 처럼 항목이 여러 개 나열된
                          // 값은 그대로 두면 셀을 뒤덮으므로, 헤더의 nameSizeClass와 같은 방식으로
                          // 길이에 따라 글씨를 줄여 한 셀 안에 더 자연스럽게 들어가게 한다.
                          const valSizeClass = val.length > 40 ? 'text-[11px]' : val.length > 22 ? 'text-[12px]' : 'text-[13px]';
                          return (
                            <td key={col.key} data-col-key={col.key} className={`px-3 py-2.5 text-left font-medium text-slate-700 ${valSizeClass} ${isFirst ? 'bg-slate-50/60' : ''}`}>
                              {val === '-' ? <span className="text-[11px] text-slate-300 font-medium">{t.notFound}</span> : val}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rankReasoning && (
              <div className="mt-3 px-3 py-2.5 bg-white rounded-[8px] border border-slate-100">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">{t.whyRecommended}</p>
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
            body: JSON.stringify({ products, criteria: col.key, locale }),
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
                body: JSON.stringify({ products: [product], criteria: col.key, locale }),
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
        <div className="w-full animate-highlight-wrap">
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
            <div className="mt-4 p-4 rounded-[12px] bg-white border border-slate-100 animate-highlight-wrap">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="w-[14px] h-[14px] text-slate-400 shrink-0" />
                <span className="text-[12.5px] font-bold text-slate-800">{t.whyRecommended}</span>
              </div>
              <p className="text-[12px] text-slate-600 leading-relaxed font-medium">
                {p._rankReasoning}
              </p>
            </div>
          )}



        </div>
      );
    };
  })(),


  ProductCard: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const tr = T[resolveLocale(allProps)]; // named `tr` — `t` below is already used for a setTimeout handle
    const delay = p._animationDelay || 0;
    const notFoundCriteria: string[] = Array.isArray(p._notFoundCriteria) ? p._notFoundCriteria : [];
    const isUnconfirmed = !!(p._unconfirmed || (Array.isArray(p._unconfirmedCriteria) && p._unconfirmedCriteria.length > 0) || notFoundCriteria.length > 0);
    const unconfirmedCriteria: string[] = Array.isArray(p._unconfirmedCriteria) && p._unconfirmedCriteria.length > 0
      ? p._unconfirmedCriteria
      : (p._unconfirmed ? [tr.unverified] : []);
    const justUpdated = !!p._justUpdated;   // auto-enrich 업데이트 트리거
    const justAdded = !!p._justAdded;       // mutateSurface(add)로 새로 추가된 카드인지 (ProductCardList가 판별)

    // 하이라이트 애니메이션 상태 (업데이트 시 highlight-wrap 길이(2s)만큼 활성화)
    const [isHighlighted, setIsHighlighted] = useState(false);
    useEffect(() => {
      if (justUpdated) {
        setIsHighlighted(true);
        const t = setTimeout(() => setIsHighlighted(false), 2000);
        return () => clearTimeout(t);
      }
    }, [justUpdated]);

    return (
      <div
        className={`group relative flex flex-col bg-white border rounded-[8px] overflow-hidden transition-all duration-500 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] w-full${(justAdded || isHighlighted) ? ' animate-highlight-wrap' : ''} border-[#EBEBEB] hover:border-[#D0D0D0]`}
        style={delay > 0 ? { animationDelay: `${delay}s` } : undefined}
      >
        {/* Product Image (Top) */}
        <div className="relative w-full aspect-[4/3] bg-[#F5F5F5] overflow-hidden">
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
          {(Array.isArray(p.specs) && p.specs.length > 0 || isUnconfirmed) && (
            <div className="flex flex-wrap gap-1">
              {unconfirmedCriteria.map((criterionName: string) => (
                <span
                  key={`u-${criterionName}`}
                  className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium text-[#666666] bg-[#F5F5F5]"
                >
                  {criterionName === tr.unverified ? tr.unverified : tr.unverifiedFor(criterionName)}
                </span>
              ))}
              {notFoundCriteria.map((criterionName: string) => (
                <span
                  key={`n-${criterionName}`}
                  className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium text-[#666666] bg-[#F5F5F5]"
                >
                  {tr.notFoundFor(criterionName)}
                </span>
              ))}
              {Array.isArray(p.specs) && p.specs.length > 0 && (
                <SpecChips specs={p.specs} locale={resolveLocale(allProps)} />
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


  ProductCardList: (() => {
    // 모듈 스코프 seen-set — 이미 본 카드 이름은 다시 "새로 추가됨"으로 보지 않는다.
    const globalSeenCardNames = new Set<string>();

    return (allProps: any) => {
      const p = allProps?.props || allProps || {};
      const cards = Array.isArray(p.cards) ? p.cards : [];
      const cardNamesKey = cards.map((c: any) => c.name || c.id || '').join('|');

      // key를 "이름-인덱스"에서 이름/ID만으로 바꾸면(아래 map), 정렬/필터로 순서만 바뀔 때는
      // React가 같은 DOM 노드를 재사용해 진입 애니메이션이 재생되지 않고, 진짜 mutateSurface(add)로
      // 새로 들어온 카드만 마운트되며 애니메이션이 재생된다. 여기 newCardNames는 그 새 카드들에게만
      // highlight-wrap 글로우를 추가로 씌우기 위한 것 — 최초 목록이 통째로 채워질 때는 제외한다.
      const [newCardNames, setNewCardNames] = useState<Set<string>>(new Set());
      // 목록 전체가 처음 생성되는 순간에만 켜지는 플래그 — 개별 카드 대신 목록 전체를 감싸서 하이라이트한다.
      const [justCreated, setJustCreated] = useState(false);

      useEffect(() => {
        if (cards.length === 0) {
          globalSeenCardNames.clear();
          setNewCardNames(new Set());
          return;
        }
        const isFirstPopulation = globalSeenCardNames.size === 0;
        const fresh: string[] = [];
        for (const c of cards) {
          const name = c.name || c.id;
          if (name && !globalSeenCardNames.has(name)) { fresh.push(name); globalSeenCardNames.add(name); }
        }
        if (isFirstPopulation) {
          setJustCreated(true);
          const t = setTimeout(() => setJustCreated(false), 2000);
          return () => clearTimeout(t);
        } else if (fresh.length > 0) {
          setNewCardNames(prev => new Set([...prev, ...fresh]));
          const t = setTimeout(() => {
            setNewCardNames(prev => {
              const next = new Set(prev);
              fresh.forEach(n => next.delete(n));
              return next;
            });
          }, 2000); // highlight-wrap 애니메이션 길이(2s)와 맞춤
          return () => clearTimeout(t);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [cardNamesKey]);

      return (
        <div className={`grid grid-cols-2 gap-3 w-full min-w-0 px-6${justCreated ? ' animate-highlight-wrap' : ''}`}>
          {/* popLayout: 카드가 삭제되면 그 카드만 페이드아웃하며 flow에서 빠지고,
              남은 카드들은 layout 애니메이션으로 새 위치까지 부드럽게 이동한다.
              정렬(sort)로 순서만 바뀔 때도 같은 layout 애니메이션이 재사용된다. */}
          <AnimatePresence mode="popLayout" initial={false}>
            {cards.map((card: any, idx: number) => {
              const cardKey = card.name || card.id || `card-${idx}`;
              return (
                <motion.div
                  key={cardKey}
                  layout
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ layout: { duration: 0.4, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.25 } }}
                >
                  <manualRegistry.ProductCard
                    {...allProps}
                    props={{ ...card, _animationDelay: idx * 0.1, _justAdded: newCardNames.has(cardKey) }}
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      );
    };
  })(),

  ComparisonSelector: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const t = T[resolveLocale(allProps)];
    const { currentItems = [] } = p;
    const { savedItems = [], isFollowUp = false } = allProps.bindings || {};
    const emit = allProps.emit;
    const [isExpanded, setIsExpanded] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);

    // Filter out items already in the current comparison and deduplicate
    const seenNames = new Set<string>();
    const availableItems = savedItems.filter((item: any) => {
      const name = typeof item === 'string' ? item : item.name;
      if (currentItems.includes(name) || seenNames.has(name)) return false;
      seenNames.add(name);
      return true;
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
      <div className="mt-4 flex flex-col gap-3 animate-highlight-wrap">
        {!isExpanded ? (
          <div className="flex flex-col gap-2">
            {isFollowUp && (
              <div className="flex items-center gap-2 px-1">
                <span className="text-[12px] font-bold text-primary">{t.followUpBanner}</span>
              </div>
            )}
            <button
              onClick={() => setIsExpanded(true)}
              className="flex items-center justify-between w-fit gap-4 text-xs font-semibold bg-white border border-slate-100 rounded-full py-2.5 px-5 shadow-[0_4px_20px_rgba(0,0,0,0.03)] hover:border-slate-300 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)] transition-all group"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">🛒 MY OPTIONS</span>
                <span className="text-slate-700 font-medium">{t.myOptionsCompareWith}</span>
              </div>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform text-slate-400" />
            </button>
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-2xl p-6 flex flex-col gap-5 shadow-[0_8px_40px_rgba(0,0,0,0.04)] border-slate-100/50">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                <span className="text-slate-400">🛒 MY OPTIONS</span>
                <span className="text-slate-800 font-medium">{t.myOptionsExpandedTitle}</span>
              </div>
              <p className="text-[11px] text-slate-900 font-medium">{t.selectToCompare}</p>
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
                {t.cancel}
              </button>
              <button
                onClick={handleConfirm}
                disabled={selected.length === 0}
                className="flex-[2] py-3 bg-primary text-white rounded-xl text-xs font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-all shadow-sm"
              >
                {t.addAndCompare(selected.length)}
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
  const t = T[resolveLocale(allProps)];
  const points: string[] = Array.isArray(p.points) ? p.points : [];
  return (
    <div className="my-2 flex flex-col gap-2 w-full animate-highlight-wrap">
      <div className="flex flex-col gap-1 border border-slate-200 rounded-xl bg-white px-4 pt-3.5 pb-4">
        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t.concept}</span>
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

