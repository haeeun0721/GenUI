import { NextRequest, NextResponse } from "next/server";
import { evaluateWinners, type TriggerType } from "@/lib/agents/comparison_agent";

export async function POST(req: NextRequest) {
  try {
    const {
      columns,
      tableData,
      userContext,
      validProductNames,
      previousWinners,
      previousRationale,
      triggerType,
      newItem,
    } = await req.json() as {
      columns: { key: string; label: string }[];
      tableData: Record<string, string>[];
      userContext?: string;
      validProductNames?: string[];
      previousWinners?: Record<string, string>;
      previousRationale?: Record<string, string>;
      triggerType?: TriggerType;
      newItem?: string;
    };

    if (!columns?.length || !tableData?.length) {
      return NextResponse.json({ winners: {}, rationale: {} });
    }

    const result = await evaluateWinners({
      columns,
      tableData,
      userContext,
      validProductNames,
      previousWinners,
      previousRationale,
      triggerType,
      newItem,
    });

    // Validate: only keep entries where the product name exactly matches a valid row
    const validSet = new Set(validProductNames ?? []);
    const validated: Record<string, string> = {};
    const validatedRationale: Record<string, string> = {};

    for (const [colKey, productName] of Object.entries(result.winners)) {
      if (!validSet.size || validSet.has(productName)) {
        validated[colKey] = productName;
        validatedRationale[colKey] = result.rationale[colKey] ?? "";
      }
    }

    console.log(`[evaluate-winners] trigger=${triggerType} validated:`, validated);
    return NextResponse.json({ winners: validated, rationale: validatedRationale, relevantColumns: result.relevantColumns ?? [] });
  } catch (err) {
    console.error("[evaluate-winners] Error:", err);
  }

  return NextResponse.json({ winners: {}, rationale: {}, relevantColumns: [] });
}
