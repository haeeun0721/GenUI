import { tool } from "ai";
import { z } from "zod";
import { currentRequestId, pushSidePanelResult } from "./sidebar-store";

/**
 * mutateCriteriaMap — 이미 화면에 표시된 CriteriaMap(Exploration Journey)의 카테고리/항목을 추가/삭제
 *
 * add_item: 프론트엔드(app/page.tsx sidebarSpec useMemo)가 CriteriaMap 타입 스펙을 label 기준으로
 *           이미 "병합"하도록 구현되어 있으므로, 추가할 카테고리/항목만 담은 부분 스펙을 기존 생성
 *           흐름과 동일한 채널(SPEC_DATA_PART_TYPE)로 내보내면 된다.
 * remove_item: 위 병합 로직은 추가만 처리하고 삭제 개념이 없다. 그래서 별도 타입("CriteriaMapRemoval")의
 *           스펙을 같은 채널로 내보내고, sidebarSpec useMemo에 그 타입을 인식해 해당 항목을 누적된
 *           categories에서 걸러내는 분기를 추가했다(app/page.tsx 참고). 기존 CriteriaMap 병합 분기는
 *           건드리지 않았다.
 */
export const mutateCriteriaMap = tool({
  description: `
Add or remove a category/items on the CURRENTLY DISPLAYED CriteriaMap (Exploration Journey panel).
Only use when [CURRENT_CRITERIA_MAP] is present.
`.trim(),
  inputSchema: z.object({
    surface: z.literal("criteriaMap"),
    op: z.enum(["add_item", "remove_item"]),
    category_label: z.string().describe(
      "add_item: existing label to merge into, or a new label to create a category. " +
      "remove_item: an existing label copied exactly from CURRENT_CRITERIA_MAP."
    ),
    item_names: z.array(z.string()).min(1).describe(
      "add_item: new item names to add. remove_item: exact existing item names to remove " +
      "(list every item under the category to remove the whole category)."
    ),
    op_summary: z.string().describe("Brief Korean description of the action."),
  }),
  execute: async (args) => {
    const capturedRequestId = currentRequestId;
    const itemNames = args.item_names.map((n) => n.trim()).filter(Boolean);
    console.log(`[mutateCriteriaMap] op=${args.op} category="${args.category_label}" items=[${itemNames.join(', ')}]`);

    if (itemNames.length === 0) {
      console.warn('[mutateCriteriaMap] item_names가 전부 빈 문자열 — 스킵');
      return { surface: "criteriaMap", op_summary: args.op_summary, spec: null };
    }

    const spec = args.op === "remove_item"
      ? {
        type: "CriteriaMapRemoval",
        props: {
          category_label: args.category_label,
          item_names: itemNames,
        },
      }
      : {
        type: "CriteriaMap",
        props: {
          categories: [
            {
              label: args.category_label,
              items: itemNames.map((name) => ({ name })),
            },
          ],
        },
      };

    if (capturedRequestId) pushSidePanelResult(capturedRequestId, spec);

    return { surface: "criteriaMap", op_summary: args.op_summary, spec };
  },
});
