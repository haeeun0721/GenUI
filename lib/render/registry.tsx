"use client";

import { useState, useRef, type ReactNode } from "react";
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
} from "lucide-react";


import { explorerCatalog } from "./catalog";


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
  SpecDiagnostic: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const items: Array<{ name: string; weight: number }> = Array.isArray(p.items) ? p.items : [];
    const isBattery = p.inputType === "slider";

    // slider state: per-item hours
    const [sliderValues, setSliderValues] = useState<Record<string, number>>(() =>
      Object.fromEntries(items.map((it) => [it.name, 0]))
    );
    // chip state: multi-select
    const [selectedChips, setSelectedChips] = useState<string[]>([]);

    // ── Battery calculation ──────────────────────────────────────────────────
    const sliderMax = p.sliderMax ?? 8;
    const totalHours = Object.values(sliderValues).reduce((a, b) => a + b, 0);
    const avgPower = totalHours > 0
      ? items.reduce((acc, it) => acc + (sliderValues[it.name] || 0) * it.weight, 0) / totalHours
      : (items[0]?.weight ?? 10);
    const capacity = p.capacity ?? 75;
    const expectedHours = capacity / avgPower;

    const threshold = p.verdictGoodThreshold ?? 6;
    const isGood = isBattery
      ? expectedHours >= threshold
      : selectedChips.reduce((acc, name) => {
        const it = items.find((i) => i.name === name);
        return acc + (it?.weight ?? 0);
      }, 0) / (p.totalCapacity ?? 1) <= threshold;

    // ── RAM calculation ──────────────────────────────────────────────────────
    const totalRam = p.totalCapacity ?? 32;
    const usedRam = selectedChips.reduce((acc, name) => {
      const it = items.find((i) => i.name === name);
      return acc + (it?.weight ?? 0);
    }, 0);
    const ramGood = usedRam <= totalRam * (p.verdictGoodThreshold ?? 0.8);

    return (
      <div className="bg-white border border-slate-100/80 rounded-[20px] p-4 my-2 flex flex-col gap-4 w-full animate-in fade-in zoom-in-98 duration-300">
        <style dangerouslySetInnerHTML={{
          __html: `
          input[type=range].sd-slider { -webkit-appearance: none; width: 100%; background: transparent; }
          input[type=range].sd-slider:focus { outline: none; }
          input[type=range].sd-slider::-webkit-slider-runnable-track { width: 100%; height: 1px; background: #f1f5f9; border-radius: 0; cursor: pointer; }
          input[type=range].sd-slider::-webkit-slider-thumb { -webkit-appearance: none; height: 16px; width: 16px; border-radius: 50%; background: #fff; border: 1px solid #94a3b8; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-top: -7.5px; cursor: pointer; }
          input[type=range].sd-slider::-moz-range-track { width: 100%; height: 1px; background: #f1f5f9; cursor: pointer; }
          input[type=range].sd-slider::-moz-range-thumb { height: 16px; width: 16px; border-radius: 50%; background: #fff; border: 1px solid #94a3b8; cursor: pointer; }
        `}} />

        {/* Title & Question */}
        <div className="flex flex-col gap-1 px-1">
          <h3 className="text-[15px] font-black text-slate-900 tracking-tight leading-tight">{p.title}</h3>
          <p className="text-[11px] text-slate-400 font-medium">{p.question}</p>
        </div>

        {/* ── Slider Mode (배터리 등) ── */}
        {isBattery && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2.5 px-1">
              {items.map((item) => (
                <div key={item.name} className="grid grid-cols-[80px_1fr_32px] items-center gap-3">
                  <span className="text-[11px] font-bold text-slate-500 truncate">{item.name}</span>
                  <input
                    type="range"
                    className="sd-slider"
                    min={0}
                    max={sliderMax}
                    step={0.5}
                    value={sliderValues[item.name] ?? 0}
                    onChange={(e) =>
                      setSliderValues((prev) => ({ ...prev, [item.name]: Number(e.target.value) }))
                    }
                  />
                  <span className="text-[10px] font-bold text-slate-300 text-right tabular-nums">
                    {sliderValues[item.name] ?? 0}시간
                  </span>
                </div>
              ))}
            </div>

            <div className="h-[1px] bg-slate-50 w-full" />

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-[#f8f9fa] p-3 rounded-lg flex flex-col border border-slate-100/50">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">예상 사용 시간</span>
                <span className={`text-[18px] font-black tracking-tighter tabular-nums ${totalHours > 0 ? "text-[#1a6e64]" : "text-slate-900"}`}>
                  {totalHours > 0 ? expectedHours.toFixed(1) : `${(capacity / (items[0]?.weight ?? 10)).toFixed(1)}`}시간
                </span>
              </div>
              <div className="bg-[#f8f9fa] p-3 rounded-lg flex flex-col border border-slate-100/50">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">시간당 소모량</span>
                <span className="text-[18px] font-black text-slate-900 tracking-tighter tabular-nums">
                  {avgPower.toFixed(1)}w
                </span>
              </div>
            </div>

            <div className={`p-2.5 rounded-lg text-[11px] font-bold border text-center transition-all duration-300 ${isGood
              ? "bg-[#e0f7f4] border-[#80e0d4]/30 text-[#1a6e64]"
              : "bg-amber-50 border-amber-100/50 text-amber-700"
              }`}>
              {isGood ? p.verdictGoodMessage ?? "충전 없이 충분히 사용 가능합니다." : p.verdictWarningMessage ?? "외출 시 충전기를 챙기세요."}
            </div>
          </div>
        )}

        {/* ── Chip Mode (RAM 등) ── */}
        {!isBattery && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-1.5 px-1">
              {items.map((item) => {
                const isSelected = selectedChips.includes(item.name);
                return (
                  <button
                    key={item.name}
                    onClick={() =>
                      setSelectedChips((prev) =>
                        prev.includes(item.name)
                          ? prev.filter((i) => i !== item.name)
                          : [...prev, item.name]
                      )
                    }
                    className={`px-3 py-1.5 rounded-[10px] text-[12px] font-bold border transition-all duration-200 ${isSelected
                      ? "bg-[#e0f7f4] border-[#80e0d4] text-[#1a6e64]"
                      : "bg-white border-slate-100 text-slate-400 hover:border-slate-300 hover:bg-slate-50"
                      }`}
                  >
                    {item.name}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col gap-2 px-1">
              <div className="flex justify-between text-[9px] font-bold text-slate-300 tabular-nums">
                <span>0</span>
                <span>{Math.round(totalRam / 2)}{p.capacityUnit ?? "GB"}</span>
                <span>{totalRam}{p.capacityUnit ?? "GB"}</span>
              </div>
              <div className="w-full h-1 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#80e0d4] transition-all duration-700 ease-out"
                  style={{ width: `${Math.min((usedRam / totalRam) * 100, 100)}%` }}
                />
              </div>
            </div>

            <div className={`p-3 rounded-lg border text-[11px] font-bold text-center transition-all duration-300 ${ramGood
              ? "bg-[#e0f7f4] border-[#80e0d4]/30 text-[#1a6e64]"
              : "bg-amber-50 border-amber-100/50 text-amber-700"
              }`}>
              {usedRam}{p.capacityUnit ?? "GB"} 사용 중 — 여유 {totalRam - usedRam}{p.capacityUnit ?? "GB"} — {ramGood ? p.verdictGoodMessage ?? "작업 환경 쾌적" : p.verdictWarningMessage ?? "메모리 부족 예상"}
            </div>
          </div>
        )}
      </div>
    );
  },



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

  Table: (allProps: any) => {
    const p = allProps?.props || allProps || {};
    const rawData = p.data;
    const items: Array<Record<string, unknown>> = Array.isArray(rawData)
      ? rawData
      : Array.isArray((rawData as Record<string, unknown>)?.data)
        ? ((rawData as Record<string, unknown>).data as Array<
          Record<string, unknown>
        >)
        : [];

    const [sortKey, setSortKey] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

    if (items.length === 0) {
      return (
        <div className="text-center py-8 text-slate-400 bg-slate-50/50 rounded-2xl border border-dashed border-slate-200">
          {p.emptyMessage ?? "비교할 데이터가 없습니다."}
        </div>
      );
    }

    const sorted = sortKey
      ? [...items].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (typeof av === "number" && typeof bv === "number") {
          return sortDir === "asc" ? av - bv : bv - av;
        }
        const as = String(av ?? "");
        const bs = String(bv ?? "");
        return sortDir === "asc"
          ? as.localeCompare(bs, undefined, { numeric: true })
          : bs.localeCompare(as, undefined, { numeric: true });
      })
      : items;

    const handleSort = (key: string) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    };

    const columns = p.columns || (items.length > 0 ? Object.keys(items[0]).map(k => ({ key: k, label: k })) : []);

    return (
      <div className="overflow-x-auto border border-slate-100 rounded-2xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] bg-white my-4">
        <Table className="min-w-max">
          <TableHeader className="bg-slate-50/50">
            <TableRow className="hover:bg-transparent border-slate-100">
              {columns.map((col: any) => {
                const SortIcon =
                  sortKey === col.key
                    ? sortDir === "asc"
                      ? ArrowUp
                      : ArrowDown
                    : ArrowUpDown;
                return (
                  <TableHead key={col.key} className="h-12 py-0 px-6 border-r border-slate-50 last:border-r-0">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-900 transition-colors"
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}
                      <SortIcon className="h-3.5 w-3.5 text-slate-300" />
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((item, i) => (
              <TableRow key={i} className="group hover:bg-slate-50/30 border-slate-50 transition-colors">
                {columns.map((col: any) => {
                  const val = String(item[col.key] ?? "");
                  const isHighlight = val.includes("✓") || val.toLowerCase() === "yes" || val.toLowerCase() === "true";
                  return (
                    <TableCell key={col.key} className={`py-4 px-6 text-[14px] border-r border-slate-50 last:border-r-0 ${isHighlight ? "font-bold text-slate-900 bg-slate-50/20" : "text-slate-600"}`}>
                      {val}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
                {/* 턴 포인트 (Hollow circle) */}
                <button
                  onClick={() => onTurnClick?.(turn.turn ?? i + 1)}
                  className={`absolute -left-[33.5px] top-1.5 h-[13px] w-[13px] rounded-full border-2 border-slate-200 bg-white z-20 transition-all duration-300 ${onTurnClick ? "cursor-pointer hover:border-slate-400 hover:scale-110" : "cursor-default"}`}
                />

                {/* 턴 요약 (Bold Title) */}
                {turn.summary && (
                  <button
                    onClick={() => onTurnClick?.(turn.turn ?? i + 1)}
                    className={`block text-left text-[14px] font-bold text-slate-800 mb-2 tracking-tight transition-colors ${onTurnClick ? "cursor-pointer hover:text-primary" : "cursor-default"}`}
                  >
                    {turn.summary}
                  </button>
                )}

                {/* 추가 내용 (General Discovery Content) */}
                {turn.content && (
                  <div className="text-[12px] text-slate-500 leading-relaxed mb-3 pr-4 whitespace-pre-wrap">
                    {turn.content}
                  </div>
                )}

                {/* Chips (Row layout) */}
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
                          // 드래그가 아닌 단순 클릭인 경우에만 실행
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
    const winners: Record<string, string> = p.winners ?? {};
    const cellBadges: { row: string; column: string; label: string; type: string }[] =
      Array.isArray(p.cellBadges) ? p.cellBadges : [];

    const criteriaFromBindings: { name: string; min?: string; priority: string }[] =
      Array.isArray(allProps.bindings?.droppedCriteria) ? allProps.bindings.droppedCriteria : [];
    const savedItems: { name: string; price?: string; description?: string; specs?: string[]; link?: string }[] =
      Array.isArray(allProps.bindings?.savedItems) ? allProps.bindings.savedItems : [];

    const [visibleColumns, setVisibleColumns] = useState<{ key: string; label: string }[]>(initialColumns);
    const [extraRows, setExtraRows] = useState<Record<string, any>[]>([]);
    const [fetchedSpecs, setFetchedSpecs] = useState<Record<string, Record<string, string>>>({});
    const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());
    const [loadingCells, setLoadingCells] = useState<Set<string>>(new Set());

    // 공백을 제거한 normalized 값으로도 비교 (예: "저장 공간" vs "저장공간")
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    const expandableOptions = criteriaFromBindings
      .filter(c => {
        const parenMatches = c.name.match(/\(([^)]+)\)/g)?.map((m: string) => m.slice(1, -1)) ?? [];
        const baseName = c.name.replace(/\s*\([^)]+\)/g, '').trim();
        const variants = [c.name, baseName, ...parenMatches].map((v: string) => v.toLowerCase()).filter(Boolean);
        const variantsNorm = variants.map(normalize);
        return !visibleColumns.some(col => {
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
      setVisibleColumns(prev => [...prev, col]);

      // Collect product info from row data (link optional — falls back to LLM knowledge)
      const allCurrentRows = [...rows, ...extraRows];
      const products = allCurrentRows
        .map(row => ({ name: String(row.product ?? row[visibleColumns[0]?.key ?? 'product'] ?? ''), link: String(row._link ?? '') }))
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

    const removeColumn = (index: number) => {
      if (index === 0) return;
      setVisibleColumns(prev => prev.filter((_, i) => i !== index));
    };

    const firstColKey = visibleColumns[0]?.key ?? 'product';
    const allRows = [...rows, ...extraRows];
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
      const newRow: Record<string, any> = { [firstColKey]: item.name };
      if (item.price) newRow['price'] = item.price;
      setExtraRows(prev => [...prev, newRow]);

      // 새로 추가된 제품에 대해서만 기존 컬럼들의 값을 fetch
      // (기존 제품들은 이미 값이 있으므로 건드리지 않음)
      const columnsToFetch = visibleColumns.slice(1).filter(col => col.key !== 'price');
      if (columnsToFetch.length === 0) return;

      const product = { name: item.name, link: item.link ?? '' };
      console.log(`[Table] addItemAsRow: fetching ${columnsToFetch.length} columns for "${item.name}"`);

      // 새 제품의 모든 셀을 로딩 상태로 표시
      setLoadingCells(prev => {
        const next = new Set(prev);
        columnsToFetch.forEach(col => next.add(`${item.name}__${col.key}`));
        return next;
      });

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

    return (
      <div className="w-full overflow-x-auto animate-in fade-in zoom-in-98 duration-300">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="border-b border-slate-100">
              {visibleColumns.map((col, ci) => {
                const rel = (col as any).relevance as 'high' | 'medium' | 'low' | undefined;
                const relNote = (col as any).relevanceNote as string | undefined;

                // 현재 제품 수에 맞게 한국어 수 표현 동적 교체
                // 예: "두 제품 모두 충분" → "네 제품 모두 충분" (4개 제품일 때)
                const korNums = ['한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
                const currentNum = korNums[allRows.length - 1] ?? `${allRows.length}개`;
                const dynamicNote = relNote?.replace(
                  /[한두세네다섯여섯일곱여덟아홉열]\s*제품/g,
                  `${currentNum} 제품`
                );

                const relStyle = rel === 'high'
                  ? { dot: 'bg-emerald-400', text: 'text-emerald-600', label: dynamicNote ?? '핵심 기준' }
                  : rel === 'low'
                  ? { dot: 'bg-slate-300', text: 'text-slate-400', label: dynamicNote ?? '이 용도엔 무관' }
                  : rel === 'medium'
                  ? { dot: 'bg-amber-400', text: 'text-amber-600', label: dynamicNote ?? '참고 가능' }
                  : null;

                return (
                  <th key={col.key} className="text-left text-[11px] font-semibold text-slate-400 tracking-wide uppercase px-3 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5 group/col">
                      <span>{col.label}</span>
                      {ci > 0 && (
                        <button
                          onClick={() => removeColumn(ci)}
                          className="opacity-0 group-hover/col:opacity-100 p-0.5 rounded-full text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-all"
                          title="컬럼 제거"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                    {/* relevance annotation — currently hidden */}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {allRows.map((row, i) => (
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

        {p.emptyMessage && rows.length === 0 && (
          <p className="text-center text-[12px] text-slate-400 py-6">{p.emptyMessage}</p>
        )}

        {Object.keys(winners).length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 px-1">
            <Trophy className="h-3 w-3 text-green-600" />
            <span className="text-[11px] text-slate-400">대화에서 나눠 목적에 더 적합한 스펙</span>
          </div>
        )}

        {allProps.bindings?.isLatestMessage && (expandableOptions.length > 0 || addableItems.length > 0) && (
          <div className="flex flex-col gap-1.5 mt-3 pt-3 border-t border-slate-100">
            {expandableOptions.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-slate-400 shrink-0 pr-3 border-r border-slate-100 whitespace-nowrap">비교 기준 추가하기</span>
                {expandableOptions.map(col => (
                  <button
                    key={col.key}
                    onClick={() => addColumn(col)}
                    className="flex items-center gap-1.5 text-[12px] font-medium text-slate-600 bg-white border border-slate-200 rounded-full px-3 py-1 hover:bg-slate-50 hover:border-slate-300 active:scale-95 transition-all shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
                  >
                    <Plus className="w-2.5 h-2.5 text-slate-400" />
                    {col.label}
                  </button>
                ))}
              </div>
            )}
            {addableItems.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-slate-400 shrink-0 pr-3 border-r border-slate-100 whitespace-nowrap">제품 함께 비교하기</span>
                {addableItems.map(item => (
                  <button
                    key={item.name}
                    onClick={() => addItemAsRow(item)}
                    className="flex items-center gap-1.5 text-[12px] font-medium text-slate-600 bg-white border border-slate-200 rounded-full px-3 py-1 hover:bg-slate-50 hover:border-slate-300 active:scale-95 transition-all shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
                  >
                    <Plus className="w-2.5 h-2.5 text-slate-400" />
                    {item.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}


      </div>
    );
  },


  ProductCard: (allProps: any) => {
    const p = allProps?.props || allProps || {};

    return (
      <div
        className="group relative flex flex-row bg-white border border-[#EBEBEB] rounded-[8px] p-3 gap-3 transition-all duration-200 hover:border-[#D0D0D0] hover:shadow-[0_2px_12px_rgba(0,0,0,0.07)] animate-in fade-in zoom-in-95 w-full"
      >
        {/* Product Image (Left) */}
        <div className="relative w-[88px] h-[88px] rounded-[4px] bg-[#F5F5F5] overflow-hidden shrink-0">
          {p.imageUrl ? (
            <img
              src={p.imageUrl}
              alt={p.name}
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-[#F5F5F5] text-[#C8C8C8]">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          )}
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

          {/* Price & Add Button */}
          <div className="flex items-center justify-between mt-2">
            <span className="text-[15px] font-bold text-[#1A1A1A] tracking-tight">
              {p.price}
            </span>
            <button
              className="w-7 h-7 bg-[#1A1A1A] text-white rounded-full hover:scale-105 active:scale-95 transition-all flex items-center justify-center flex-shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                const onItemAdd = allProps.bindings?.onItemAdd;
                if (onItemAdd) onItemAdd(p.name, p.imageUrl, p.price, undefined, undefined);
                if (allProps.emit) allProps.emit("press", { product: p.name });
              }}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
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
  return (
    <div className="p-4 border border-dashed rounded-lg text-muted-foreground text-sm">
      Unknown component: {type}
    </div>
  );
}
