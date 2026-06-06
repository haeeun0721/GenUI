"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { SpecDiagnostic } from "./spec-diagnostic";
import { useBoundProp, defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart as RechartsLineChart,
  Pie,
  PieChart as RechartsPieChart,
  XAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Search,
  Plus,
  X,
  Star,
  ChevronRight,
  ChevronDown,
  TrendingUp,
  LayoutGrid,
  Filter,
  ArrowRight,
  Check,
  TrendingDown,
  Minus,
  Info,
  Lightbulb,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trophy,
  Heart,
  LayoutList,
  Columns3,
} from "lucide-react";


import { explorerCatalog } from "./catalog";


// =============================================================================
// HeartButton — Naver Shopping style heart overlay for ProductCard
// =============================================================================

function HeartButton({ onAdd, onRemove }: { onAdd: () => void; onRemove: () => void }) {
  const [saved, setSaved] = useState(false);

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

  // From @json-render/shadcn (wrapped for resilience)
  Stack: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    const StackComp = shadcnComponents.Stack;
    return <StackComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}}>{children}</StackComp>;
  },
  Card: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    const CardComp = shadcnComponents.Card;
    return <CardComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}}>{children}</CardComp>;
  },
  SpecDiagnostic: (allProps: any) => <SpecDiagnostic allProps={allProps} />,



  Grid: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    const cols = p.cols || 2;

    return (
      <div
        className="grid w-full my-6"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap: `24px`
        }}
      >
        {children}
      </div>
    );
  },
  Heading: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const HeadingComp = shadcnComponents.Heading;
    return <HeadingComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}} />;
  },
  Separator: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const SeparatorComp = shadcnComponents.Separator;
    return <SeparatorComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}} />;
  },
  Accordion: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    const AccordionComp = shadcnComponents.Accordion;
    return <AccordionComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}}>{children}</AccordionComp>;
  },
  Progress: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const ProgressComp = shadcnComponents.Progress;
    return <ProgressComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}} />;
  },
  Skeleton: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const SkeletonComp = shadcnComponents.Skeleton;
    return <SkeletonComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}} />;
  },
  Badge: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    const BadgeComp = shadcnComponents.Badge;
    return <BadgeComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}}>{children}</BadgeComp>;
  },
  Alert: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    const AlertComp = shadcnComponents.Alert;
    return <AlertComp props={p} emit={allProps?.emit || (() => { })} on={allProps?.on || {}}>{children}</AlertComp>;
  },

  // Chat-specific components
  Text: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    return (
      <p className={p.muted ? "text-muted-foreground" : ""}>
        {p.content}
      </p>
    );
  },

  Metric: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const TrendIcon =
      p.trend === "up"
        ? TrendingUp
        : p.trend === "down"
          ? TrendingDown
          : Minus;
    const trendColor =
      p.trend === "up"
        ? "text-green-500"
        : p.trend === "down"
          ? "text-red-500"
          : "text-muted-foreground";
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{p.label}</p>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold">{p.value}</span>
          {p.trend && <TrendIcon className={`h-4 w-4 ${trendColor}`} />}
        </div>
        {p.detail && (
          <p className="text-xs text-muted-foreground">{p.detail}</p>
        )}
      </div>
    );
  },

  Link: (allProps: any) => {

    const p = allProps?.props || allProps || {};
    return (
      <a
        href={p.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-4 hover:text-primary/80"
      >
        {p.text}
      </a>
    );
  },

  BarChart: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const rawData = p.data;
    const rawItems: Array<Record<string, unknown>> = Array.isArray(rawData)
      ? rawData
      : Array.isArray((rawData as Record<string, unknown>)?.data)
        ? ((rawData as Record<string, unknown>).data as Array<
          Record<string, unknown>
        >)
        : [];

    const { items, valueKey } = processChartData(
      rawItems,
      p.xKey,
      p.yKey,
      p.aggregate,
    );

    const chartColor = p.color ?? "var(--chart-1)";
    const chartConfig = {
      [valueKey]: {
        label: valueKey,
        color: chartColor,
      },
    } satisfies ChartConfig;

    if (items.length === 0) {
      return (
        <div className="text-center py-4 text-muted-foreground">
          No data available
        </div>
      );
    }

    return (
      <div className="w-full">
        {p.title && (
          <p className="text-sm font-medium mb-2">{p.title}</p>
        )}
        <ChartContainer
          config={chartConfig}
          className="min-h-[200px] w-full"
          style={{ height: p.height ?? 300 }}
        >
          <RechartsBarChart accessibilityLayer data={items}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey={valueKey}
              fill={`var(--color-${valueKey})`}
              radius={4}
            />
          </RechartsBarChart>
        </ChartContainer>
      </div>
    );
  },

  LineChart: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const rawData = p.data;
    const rawItems: Array<Record<string, unknown>> = Array.isArray(rawData)
      ? rawData
      : Array.isArray((rawData as Record<string, unknown>)?.data)
        ? ((rawData as Record<string, unknown>).data as Array<
          Record<string, unknown>
        >)
        : [];

    const { items, valueKey } = processChartData(
      rawItems,
      p.xKey,
      p.yKey,
      p.aggregate,
    );

    const chartColor = p.color ?? "var(--chart-1)";
    const chartConfig = {
      [valueKey]: {
        label: valueKey,
        color: chartColor,
      },
    } satisfies ChartConfig;

    if (items.length === 0) {
      return (
        <div className="text-center py-4 text-muted-foreground">
          No data available
        </div>
      );
    }

    return (
      <div className="w-full">
        {p.title && (
          <p className="text-sm font-medium mb-2">{p.title}</p>
        )}
        <ChartContainer
          config={chartConfig}
          className="min-h-[200px] w-full [&_svg]:overflow-visible"
          style={{ height: p.height ?? 300 }}
        >
          <RechartsLineChart accessibilityLayer data={items}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
              interval={
                items.length > 12
                  ? Math.ceil(items.length / 8) - 1
                  : undefined
              }
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line
              type="monotone"
              dataKey={valueKey}
              stroke={`var(--color-${valueKey})`}
              strokeWidth={2}
              dot={false}
            />
          </RechartsLineChart>
        </ChartContainer>
      </div>
    );
  },

  Tabs: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    return (
      <Tabs defaultValue={p.defaultValue ?? (p.tabs ?? [])[0]?.value}>
        <TabsList>
          {(p.tabs ?? []).map((tab: any) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {children}
      </Tabs>
    );
  },

  TabContent: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const children = allProps?.children || (allProps?.props?.children);
    return <TabsContent value={p.value}>{children}</TabsContent>;
  },

  Callout: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const config = (({
      info: {
        icon: Info,
        border: "border-l-blue-500",
        bg: "bg-blue-500/5",
        iconColor: "text-blue-500",
      },
      tip: {
        icon: Lightbulb,
        border: "border-l-emerald-500",
        bg: "bg-emerald-500/5",
        iconColor: "text-emerald-500",
      },
      warning: {
        icon: AlertTriangle,
        border: "border-l-amber-500",
        bg: "bg-amber-500/5",
        iconColor: "text-amber-500",
      },
      important: {
        icon: Star,
        border: "border-l-purple-500",
        bg: "bg-purple-500/5",
        iconColor: "text-purple-500",
      },
    } as any)[p.type ?? "info"]) ?? {
      icon: Info,
      border: "border-l-blue-500",
      bg: "bg-blue-500/5",
      iconColor: "text-blue-500",
    };
    const Icon = config.icon;
    return (
      <div
        className={`border-l-4 ${config.border} ${config.bg} rounded-r-lg p-4`}
      >
        <div className="flex items-start gap-3">
          <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${config.iconColor}`} />
          <div className="flex-1 min-w-0">
            {p.title && (
              <p className="font-semibold text-sm mb-1">{p.title}</p>
            )}
            <p className="text-sm text-muted-foreground">{p.content}</p>
          </div>
        </div>
      </div>
    );
  },

  Timeline: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const turns = p.turns ?? [];
    const items = p.items ?? [];

    // turns 데이터가 있으면 새 스타일, 없으면 items로 fallback
    const renderTimeline = () => {
      if (turns.length === 0 && items.length > 0) {
        return (
          <div className="relative pl-8 mt-2">
            <div className="absolute left-[5.5px] top-3 bottom-3 w-px bg-border/60" />
            <div className="flex flex-col gap-3">
              {items.map((item: any, i: number) => (
                <div key={i} className="relative">
                  <div className="absolute -left-8 top-1.5 h-3 w-3 rounded-full bg-muted-foreground/30 ring-2 ring-background z-10" />
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/json", JSON.stringify(item));
                      e.dataTransfer.setData("text/plain", item.name);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    className="flex items-center gap-2 bg-white border border-slate-200 rounded-full px-3 h-[30px] transition-all duration-200 group/chip cursor-grab active:cursor-grabbing"
                  >
                    <div className="flex items-baseline gap-1.5 min-w-0 flex-1 px-1">
                      <span className="text-[12px] font-bold text-slate-800 whitespace-nowrap truncate">{item.name}</span>
                      {item.min && (
                        <span className="text-[10px] text-slate-500 font-medium whitespace-nowrap truncate">{item.min}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      }

      const onTurnClick = allProps.bindings?.onTurnClick;

      return (
        <div className="relative pl-10 mt-2">
          <div className="absolute left-[13px] top-3 bottom-3 w-[1.5px] bg-slate-100" />
          <div className="flex flex-col gap-10">
            {turns.map((turn: any, i: number) => (
              <div key={i} className="relative group/turn">
                <button
                  onClick={() => onTurnClick?.(turn.turn ?? i + 1)}
                  className={`absolute -left-[33.5px] top-1.5 h-[13px] w-[13px] rounded-full border-2 border-slate-200 bg-white z-20 transition-all duration-300 ${onTurnClick ? "cursor-pointer hover:border-slate-400 hover:scale-110" : "cursor-default"}`}
                />
                {turn.summary && (
                  <button
                    onClick={() => onTurnClick?.(turn.turn ?? i + 1)}
                    className={`block text-left text-[14px] font-bold text-slate-800 mb-2 tracking-tight transition-colors ${onTurnClick ? "cursor-pointer hover:text-primary" : "cursor-default"}`}
                  >
                    {turn.summary}
                  </button>
                )}
                {turn.content && (
                  <div className="text-[12px] text-slate-500 leading-relaxed mb-3 pr-4 whitespace-pre-wrap">
                    {turn.content}
                  </div>
                )}
                <div className="flex flex-wrap gap-3 pr-4">
                  {(turn.items ?? []).map((item: any, j: number) => {
                    const itemIndex = turns.slice(0, i).reduce((acc: number, t: any) => acc + (t.items?.length ?? 0), 0) + j;
                    return (
                      <div
                        key={`${turn.turn || i}-${item.name}-${j}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/json", JSON.stringify(item));
                          e.dataTransfer.setData("text/plain", item.name);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        onMouseUp={(e) => {
                          if (e.button === 0) {
                            onTurnClick?.(turn.turn ?? i + 1, item.name);
                          }
                        }}
                        className="flex items-center gap-2 bg-white border border-slate-200 rounded-full px-3 h-[30px] transition-all duration-200 group/chip cursor-grab active:cursor-grabbing hover:border-slate-400 active:scale-[0.98] animate-chip-in"
                        style={{ animationDelay: `${itemIndex * 0.08}s` }}
                      >
                        <div className="flex items-baseline gap-1.5 min-w-0 flex-1 px-1">
                          <span className="text-[12px] font-bold text-slate-800 select-none whitespace-nowrap truncate">
                            {item.name}
                          </span>
                          {item.min && (
                            <span className="text-[10px] text-slate-500 font-medium select-none whitespace-nowrap truncate">
                              {item.min}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {turns.length === 0 && (
              <p className="text-xs text-muted-foreground italic">타임라인에 항목이 없습니다.</p>
            )}
          </div>
        </div>
      );
    };

    return (
      <div className="flex flex-col gap-4 py-2">
        {renderTimeline()}
      </div>
    );
  },

  KnowledgeMap: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const categories: any[] = Array.isArray(p.categories) ? p.categories : [];
    const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
    const animatedChips = useRef<Set<string>>(new Set());
    const animatedCategories = useRef<Set<string>>(new Set());

    if (categories.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
            대화를 시작하면<br />여기에 탐색 기록이 쌓여요
          </p>
        </div>
      );
    }

    // Count new chips this render for staggered delay
    let newChipCount = 0;
    let newCatCount = 0;

    return (
      <div className="flex flex-col gap-2 py-1">
        {categories.map((cat: any, ci: number) => {
          const items: any[] = Array.isArray(cat.items) ? cat.items : [];
          const isCollapsed = collapsed[ci] ?? false;

          const catKey = cat.label;
          const isCatNew = !animatedCategories.current.has(catKey);
          if (isCatNew) {
            animatedCategories.current.add(catKey);
            newCatCount++;
          }

          return (
            <div
              key={ci}
              className={`border border-slate-200 rounded-[8px]${isCatNew ? " animate-accordion-in" : ""}`}
              style={isCatNew ? { animationDelay: `${(newCatCount - 1) * 0.07}s` } : undefined}
            >
              {/* Accordion header */}
              <button
                type="button"
                onClick={() => setCollapsed(prev => ({ ...prev, [ci]: !isCollapsed }))}
                className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 transition-colors rounded-[8px]"
              >
                <span className="text-[13px] font-semibold text-slate-800 text-left">
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
                  overflow: "hidden",
                  transition: "max-height 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease",
                  opacity: isCollapsed ? 0 : 1,
                }}
              >
                <div className="px-4 pb-3 pt-2 flex flex-wrap gap-2 border-t border-slate-100 bg-white rounded-b-[8px]">
                  {items.map((item: any, ii: number) => {
                    const chipKey = `${cat.label}::${item.name}`;
                    const isNew = !animatedChips.current.has(chipKey);
                    if (isNew) {
                      animatedChips.current.add(chipKey);
                      newChipCount++;
                    }
                    return (
                      <div
                        key={`${ci}-${ii}-${item.name}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/json", JSON.stringify(item));
                          e.dataTransfer.setData("text/plain", item.name);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        className={`flex items-center gap-1.5 rounded-full px-3 h-[30px] border transition-all duration-200 cursor-grab active:cursor-grabbing hover:shadow-sm active:scale-[0.97] bg-white border-slate-300 hover:border-slate-500${isNew ? " animate-chip-in" : ""}`}
                        style={isNew ? { animationDelay: `${(newChipCount - 1) * 0.05}s` } : undefined}
                      >
                        <span className="text-[12px] select-none whitespace-nowrap font-medium text-slate-700">
                          {item.name}
                        </span>
                        {item.min && (
                          <span className="text-[10px] font-medium select-none whitespace-nowrap text-slate-400">
                            {item.min}
                          </span>
                        )}
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
  },


  PieChart: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const rawData = p.data;
    const items: Array<Record<string, unknown>> = Array.isArray(rawData)
      ? rawData
      : Array.isArray((rawData as Record<string, unknown>)?.data)
        ? ((rawData as Record<string, unknown>).data as Array<
          Record<string, unknown>
        >)
        : [];

    if (items.length === 0) {
      return (
        <div className="text-center py-4 text-muted-foreground">
          No data available
        </div>
      );
    }

    const chartConfig: ChartConfig = {};
    items.forEach((item, i) => {
      const name = String(item[p.nameKey] ?? `Segment ${i + 1}`);
      chartConfig[name] = {
        label: name,
        color: PIE_COLORS[i % PIE_COLORS.length],
      };
    });

    return (
      <div className="w-full">
        {p.title && (
          <p className="text-sm font-medium mb-2">{p.title}</p>
        )}
        <ChartContainer
          config={chartConfig}
          className="mx-auto aspect-square w-full"
          style={{ height: p.height ?? 300 }}
        >
          <RechartsPieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie
              data={items.map((item, i) => ({
                name: String(item[p.nameKey] ?? `Segment ${i + 1}`),
                value:
                  typeof item[p.valueKey] === "number"
                    ? item[p.valueKey]
                    : parseFloat(String(item[p.valueKey])) || 0,
                fill: PIE_COLORS[i % PIE_COLORS.length],
              }))}
              dataKey="value"
              nameKey="name"
              innerRadius="40%"
              outerRadius="70%"
              paddingAngle={2}
            />
            <Legend />
          </RechartsPieChart>
        </ChartContainer>
      </div>
    );
  },

  RadioGroup: (allProps: any) => {
    const { props: p, bindings } = allProps?.props ? allProps : { props: allProps || {}, bindings: allProps?.bindings };
    const [value, setValue] = useBoundProp<string>(
      p.value as string | undefined,
      bindings?.value,
    );
    const current = value ?? "";

    return (
      <div className="flex flex-col gap-2">
        {p.label && (
          <Label className="text-sm font-medium">{p.label}</Label>
        )}
        <RadioGroup
          value={current}
          onValueChange={(v: string) => setValue(v)}
        >
          {(p.options ?? []).map((opt: any) => (
            <div key={opt.value} className="flex items-center gap-2">
              <RadioGroupItem value={opt.value} id={`rg-${opt.value}`} />
              <Label
                htmlFor={`rg-${opt.value}`}
                className="font-normal cursor-pointer"
              >
                {opt.label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
    );
  },

  SelectInput: (allProps: any) => {
    const { props: p, bindings } = allProps?.props ? allProps : { props: allProps || {}, bindings: allProps?.bindings };
    const [value, setValue] = useBoundProp<string>(
      p.value as string | undefined,
      bindings?.value,
    );
    const current = value ?? "";

    return (
      <div className="flex flex-col gap-2">
        {p.label && (
          <Label className="text-sm font-medium">{p.label}</Label>
        )}
        <Select value={current} onValueChange={(v: string) => setValue(v)}>
          <SelectTrigger>
            <SelectValue placeholder={p.placeholder ?? "Select..."} />
          </SelectTrigger>
          <SelectContent>
            {(p.options ?? []).map((opt: any) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  },

  TextInput: (allProps: any) => {
    const { props: p, bindings } = allProps?.props ? allProps : { props: allProps || {}, bindings: allProps?.bindings };
    const [value, setValue] = useBoundProp<string>(
      p.value as string | undefined,
      bindings?.value,
    );
    const current = value ?? "";

    return (
      <div className="flex flex-col gap-2">
        {p.label && (
          <Label className="text-sm font-medium">{p.label}</Label>
        )}
        <Input
          type={p.type ?? "text"}
          placeholder={p.placeholder ?? ""}
          value={current}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    );
  },

  Button: (allProps: any) => {
    const { props: p, emit } = allProps?.props ? allProps : { props: allProps || {}, emit: allProps?.emit };
    return (
      <Button
        variant={p.variant ?? "default"}
        size={p.size ?? "default"}
        disabled={p.disabled ?? false}
        onClick={() => emit?.("press")}
      >
        {p.label}
      </Button>
    );
  },

  Table: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const initialColumns: { key: string; label: string }[] = Array.isArray(p.columns) ? p.columns : [];
    const rows: Record<string, any>[] = Array.isArray(p.data) ? p.data : [];
    const [winners, setWinners] = useState<Record<string, string>>(p.winners ?? {});
    const [rationale, setRationale] = useState<Record<string, string>>(p.rationale ?? {});
    const [relevantColumns, setRelevantColumns] = useState<string[]>([]);

    // Sync winners with prop — p.winners arrives after streaming completes
    useEffect(() => {
      if (p.winners && Object.keys(p.winners).length > 0) {
        setWinners(p.winners);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(p.winners)]);

    // Trigger Comparison Agent for initial winner evaluation once rows are available.
    // The Comparison Agent is the SOLE owner of winner decisions.
    //
    // Note: ref is reset in cleanup to handle React StrictMode's double-invocation
    // in development (effect → cleanup → effect again). Without reset, the second
    // invocation sees initialEvalFiredRef.current === true and skips evaluation.
    const initialEvalFiredRef = useRef(false);
    useEffect(() => {
      if (rows.length > 0 && !initialEvalFiredRef.current) {
        initialEvalFiredRef.current = true;
        reevaluateWinners({}, rows, { triggerType: 'initial' });
      }
      return () => {
        // Reset so StrictMode remount can re-trigger correctly
        initialEvalFiredRef.current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows.length]);


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


    // Re-evaluate winners via Comparison Agent.
    // triggerType determines which evaluation mode the Comparison Agent uses:
    //   "initial"      — full evaluation of all columns on table creation
    //   "row_added"    — does the new product beat existing winners?
    //   "column_added" — is the new column relevant? if yes, who wins it?
    const reevaluateWinners = async (
      latestFetchedSpecs: Record<string, Record<string, string>>,
      currentRows: Record<string, any>[],
      options?: {
        triggerType?: 'initial' | 'row_added' | 'column_added';
        newItem?: string;
        focusColumnKeys?: string[];
        focusColumnDefs?: { key: string; label: string }[]; // bypass stale allColumns state
      }
    ) => {
      const userCtx = allProps.bindings?.userContext ?? '';
      const fk = allColumns[0]?.key ?? 'product';
      const { triggerType = 'initial', newItem, focusColumnKeys, focusColumnDefs } = options ?? {};

      const baseSpecCols = allColumns.filter(c => c.key !== fk);
      // focusColumnDefs: directly provided column definitions (avoids stale allColumns
      // state when a new column has just been added via setAllColumns which is async).
      const specCols = focusColumnDefs
        ? focusColumnDefs
        : focusColumnKeys
          ? baseSpecCols.filter(c => focusColumnKeys.includes(c.key))
          : baseSpecCols;

      if (specCols.length === 0 || currentRows.length === 0) return;

      const validProductNames = currentRows
        .map(row => String(row[fk] ?? ''))
        .filter(Boolean);

      console.log(`[reevaluateWinners] trigger=${triggerType} newItem=${newItem ?? '—'} cols=${specCols.map(c => c.key).join(',')}`);

      const tableData = currentRows.map(row => {
        const name = String(row[fk] ?? '');
        const merged: Record<string, string> = { [fk]: name };
        for (const c of specCols) {
          const fetched = latestFetchedSpecs[c.key]?.[name];
          merged[c.key] = fetched !== undefined ? fetched : (row[c.key] != null ? String(row[c.key]) : '-');
        }
        return merged;
      });

      try {
        const res = await fetch('/api/evaluate-winners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            columns: specCols,
            tableData,
            userContext: userCtx,
            validProductNames,
            previousWinners: winners,
            previousRationale: rationale,
            triggerType,
            newItem,
          }),
        });
        const data = await res.json();
        console.log('[reevaluateWinners] Comparison Agent response:', data.winners);
        // Always merge relevantColumns regardless of whether there are winners
        if (Array.isArray(data.relevantColumns) && data.relevantColumns.length > 0) {
          setRelevantColumns(prev => Array.from(new Set([...prev, ...data.relevantColumns])));
        }
        if (data.winners && Object.keys(data.winners).length > 0) {
          const validSet = new Set(validProductNames);
          const validated: Record<string, string> = {};
          const validatedRationale: Record<string, string> = {};
          for (const [colKey, productName] of Object.entries(data.winners as Record<string, string>)) {
            if (validSet.has(productName)) {
              validated[colKey] = productName;
              validatedRationale[colKey] = (data.rationale as Record<string, string>)?.[colKey] ?? '';
            }
          }
          console.log('[reevaluateWinners] validated winners:', validated);
          if (Object.keys(validated).length > 0) {
            setWinners(prev => ({ ...prev, ...validated }));
            setRationale(prev => ({ ...prev, ...validatedRationale }));
          } else {
            console.warn('[reevaluateWinners] No valid matches — keeping existing winners');
          }
        }
      } catch (err) {
        console.error('[Table] reevaluateWinners failed:', err);
      }
    };

    const addColumn = async (col: { key: string; label: string }) => {
      // 이미 allColumns에 있지만 숨겨진 경우 → 그냥 보이게만
      if (allColumns.some(c => c.key === col.key)) {
        setHiddenColumnKeys(prev => { const s = new Set(prev); s.delete(col.key); return s; });
        return;
      }

      setAllColumns(prev => [...prev, col]);

      const firstColKey = allColumns[0]?.key ?? 'product';
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
        // Evaluate ONLY the new column: check relevance → determine winner.
        // Pass col via focusColumnDefs to bypass stale allColumns state
        // (setAllColumns is async — allColumns doesn't include col yet when this runs).
        await reevaluateWinners(
          { ...fetchedSpecs, [col.key]: data },
          allCurrentRows,
          { triggerType: 'column_added', newItem: col.key, focusColumnDefs: [col] }
        );
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

    const firstColKey = allColumns[0]?.key ?? 'product';
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
        console.log(`[addItemAsRow] no columns to fetch — re-evaluating winners only`);
        await reevaluateWinners(
          fetchedSpecs,
          [...rows, ...extraRows, newRow],
          { triggerType: 'row_added', newItem: item.name }
        );
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

      // Re-evaluate winners: check if new product beats existing winners (row_added mode)
      const mergedSpecs = { ...fetchedSpecs, ...newSpecValues };
      await reevaluateWinners(
        mergedSpecs,
        [...rows, ...extraRows, newRow],
        { triggerType: 'row_added', newItem: item.name }
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

      // Check if this cell is the winner for this column
      const isWinner = ci > 0 && winners[col.key] === productName;
      if (isWinner && displayValue !== '—') {
        const allValuesInColumn = allRows.map(r => {
          const fv = fetchedSpecs[col.key]?.[String(r[firstColKey] ?? '')];
          const rv = fv !== undefined ? fv : r[col.key];
          return rv != null ? String(rv) : '—';
        });
        const hasDistinctValues = allValuesInColumn.some(v => v !== displayValue);
        if (hasDistinctValues) {
          return (
            <span className="inline-flex flex-col items-center gap-0.5">
              <Trophy className="h-3 w-3 text-green-600" />
              <span className="text-[13px] font-normal text-green-700">{displayValue}</span>
            </span>
          );
        }
      }

      return displayValue;
    };


    // allColumns(ci>0) + expandableOptions 합쳐서 패널에 표시
    const allManageableColumns = [
      ...allColumns.slice(1),
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

        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
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
                    <th key={col.key} className="text-left text-[11px] font-semibold text-slate-400 tracking-wide uppercase px-3 py-2.5 whitespace-nowrap">
                      <span>{col.label}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, i) => (
                <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                  {visibleColumns.map((col, ci) => (
                    <td key={col.key} className={`px-3 py-2.5 text-slate-700 ${ci === 0 ? 'font-semibold text-slate-900' : 'font-normal'}`}>
                      {renderCell(row, col, ci)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {p.emptyMessage && rows.length === 0 && (
          <p className="text-center text-[12px] text-slate-400 py-6">{p.emptyMessage}</p>
        )}

        {Object.keys(winners).length > 0 && (() => {
          const userCtx = (allProps.bindings?.userContext as string | undefined)?.trim();
          const contextLabel = userCtx ? userCtx : "내 구매 목적";
          return (
            <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-slate-100">
              <Trophy className="h-3 w-3 text-green-600 shrink-0" />
              <span className="text-[11px] text-slate-400">
                '<span className="text-slate-500 font-medium">{contextLabel}</span>' 기준으로 적절한 옵션을 표시합니다
              </span>
            </div>
          );
        })()}

      </div>
    );
  },


  ProductCard: (allProps: any) => {
    const p = allProps?.props || allProps || {};

    return (
      <div
        className="group relative flex flex-row bg-white border border-[#EBEBEB] rounded-[8px] p-3 gap-3 transition-all duration-200 hover:border-[#D0D0D0] hover:shadow-[0_2px_12px_rgba(0,0,0,0.07)] animate-in fade-in zoom-in-95 w-full"
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
          <HeartButton
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
      <div className="grid grid-cols-2 gap-3 w-full">
        {cards.map((card: any, idx: number) => (
          <div key={card.id || idx}>
            {manualRegistry.ProductCard({ ...allProps, props: card })}
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
                <span className="text-slate-400">🛒 MY ITEMS</span>
                <span className="text-slate-700 font-medium">과 함께 비교하기</span>
              </div>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform text-slate-400" />
            </button>
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-2xl p-6 flex flex-col gap-5 shadow-[0_8px_40px_rgba(0,0,0,0.04)] border-slate-100/50">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                <span className="text-slate-400">🛒 MY ITEMS</span>
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

export const { registry, handlers } = defineRegistry(explorerCatalog, {
  components: manualRegistry as any,
});

// =============================================================================
// Chart Helpers
// =============================================================================

const PIE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function processChartData(
  items: Array<Record<string, unknown>>,
  xKey: string,
  yKey: string,
  aggregate: "sum" | "count" | "avg" | null | undefined,
): { items: Array<Record<string, unknown>>; valueKey: string } {
  if (items.length === 0) {
    return { items: [], valueKey: yKey };
  }

  if (!aggregate) {
    const formatted = items.map((item) => ({
      ...item,
      label: String(item[xKey] ?? ""),
    }));
    return { items: formatted, valueKey: yKey };
  }

  const groups = new Map<string, Array<Record<string, unknown>>>();

  for (const item of items) {
    const groupKey = String(item[xKey] ?? "unknown");
    const group = groups.get(groupKey) ?? [];
    group.push(item);
    groups.set(groupKey, group);
  }

  const valueKey = aggregate === "count" ? "count" : yKey;
  const aggregated: Array<Record<string, unknown>> = [];
  const sortedKeys = Array.from(groups.keys()).sort();

  for (const key of sortedKeys) {
    const group = groups.get(key)!;
    let value: number;

    if (aggregate === "count") {
      value = group.length;
    } else if (aggregate === "sum") {
      value = group.reduce((sum, item) => {
        const v = item[yKey];
        return sum + (typeof v === "number" ? v : parseFloat(String(v)) || 0);
      }, 0);
    } else {
      const sum = group.reduce((s, item) => {
        const v = item[yKey];
        return s + (typeof v === "number" ? v : parseFloat(String(v)) || 0);
      }, 0);
      value = group.length > 0 ? sum / group.length : 0;
    }

    aggregated.push({ label: key, [valueKey]: value });
  }

  return { items: aggregated, valueKey };
}

// =============================================================================
// Fallback Component
// =============================================================================

export function Fallback({ type }: { type: string }) {
  // Silently ignore Empty — it's a no-data sentinel from the UI agent
  if (type === 'Empty' || type === 'empty') return null;
  return (
    <div className="p-4 border border-dashed rounded-lg text-muted-foreground text-sm">
      Unknown component: {type}
    </div>
  );
}
