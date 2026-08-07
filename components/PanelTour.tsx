"use client";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

const STEPS = [
  {
    id: "exploration", accentColor: "#6366f1",
    title: "EXPLORATION JOURNEY", 
    desc: "채팅 중 제품의 특징이 언급되거나 새로운 개념을 탐색할 때 생성되는 패널입니다. 해당 카테고리에서 고려해야 할 주요 구매 기준과 관련 상세 정보를 구조화하여 시각적으로 제공합니다.",
    descEn: "This panel appears when product features are mentioned or new concepts are explored during the chat. It visually structures and provides key purchase criteria and detailed information for the category.",
    help: "탐색 과정에서 본인에게 중요하다고 판단되는 기준을 클릭하여 Decision Criteria로 저장할 수 있습니다.",
    helpEn: "You can click on criteria you find important during exploration to save them as your Decision Criteria.",
    marks: [],
  },
  {
    id: "optionList", accentColor: "#6366f1",
    title: "OPTION LIST", 
    desc: "사용자가 특정 조건을 제시하거나 제품 추천을 요청할 때 생성되는 패널입니다. 현재까지 파악된 사용자의 요구사항을 바탕으로 필터링된 맞춤형 제품 후보군을 리스트 형태로 제공합니다.",
    descEn: "This panel is generated when you provide specific conditions or ask for recommendations. It displays a filtered list of tailored product candidates based on your identified requirements.",
    help: "추천된 제품 리스트를 확인하고, 비교하고 싶은 제품의 우측 상단 ♥ 아이콘을 클릭하여 My Options에 추가할 수 있습니다.",
    helpEn: "Review the recommended products and click the ♥ icon in the top right of any item to add it to My Options for comparison.",
    marks: [],
  },
  {
    id: "compTable", accentColor: "#6366f1",
    title: "COMPARISON TABLE", 
    desc: "My Options에 2개 이상의 제품이 추가된 상태에서 상세 비교를 요청할 때 생성되는 패널입니다. 사용자가 저장한 Decision Criteria를 바탕으로 각 제품의 스펙과 특징을 표 형태로 대조하여 보여줍니다.",
    descEn: "This panel is created when you request a detailed comparison with at least 2 products in My Options. It contrasts the specs and features of each product in a table format based on your saved Decision Criteria.",
    help: "각 기준별 제품 간의 차이점을 한눈에 파악하고, AI가 도출한 맞춤형 추천 순위를 종합적으로 참고하여 최종 결정을 내릴 수 있습니다.",
    helpEn: "Easily spot differences between products for each criterion, and make your final decision using the AI's tailored recommendations.",
    marks: [],
  },
  {
    id: "sidebar", accentColor: "#6366f1",
    title: "SAVED ITEMS",
    desc: "우측 사이드바는 전체 탐색 과정을 관통하는 나만의 개인 저장소입니다. 상단의 Decision Criteria에는 내가 중요하다고 판단한 기준들이, 하단의 My Options에는 비교를 위해 담아둔 관심 제품들이 모이게 됩니다.",
    descEn: "The right sidebar serves as your personal repository throughout the exploration process. The top Decision Criteria section holds your saved key factors, while the bottom My Options section gathers products you've favorited for comparison.",
    help: "화면 중앙의 패널들과 상호작용하며 이곳에 나만의 기준과 관심 제품을 하나씩 채워나가 보세요.",
    helpEn: "Interact with the main panels to fill this space with your personalized criteria and favorite products.",
    marks: [],
  },
];

/* ── Coach mark pill ─────────────────────────────────────────────── */
function CoachMark({ text, top, left, accent, arrowLeft, arrowRight }: { text: string; top: number; left: number; accent: string; arrowLeft?: boolean; arrowRight?: boolean }) {
  const arrow = (dir: "left" | "right") => (
    <svg width="24" height="14" viewBox="0 0 24 14" fill="none" style={{ flexShrink: 0 }}>
      {dir === "left"
        ? <path d="M22 7 L4 7 M4 7 L10 3 M4 7 L10 11" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M2 7 L20 7 M20 7 L14 3 M20 7 L14 11" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      }
    </svg>
  );
  return (
    <div style={{ position: "absolute", top, left, zIndex: 20, display: "flex", alignItems: "center", gap: 4 }}>
      {arrowLeft && arrow("left")}
      <div style={{ background: "white", border: `2px solid ${accent}`, borderRadius: 20, padding: "6px 12px", boxShadow: "0 4px 16px rgba(0,0,0,0.18)", whiteSpace: "pre-line", lineHeight: 1.45, cursor: "default" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: accent }}>{text}</span>
      </div>
      {arrowRight && arrow("right")}
    </div>
  );
}

/* ── Large panel renderers ───────────────────────────────────────── */

function PanelExploration({ active, accent, locale }: { active: boolean; accent: string; locale: 'ko' | 'en' }) {
  const isEn = locale === 'en';
  return (
    <div style={{ flex: 1, borderRadius: 14, background: "white", border: active ? `2px solid ${accent}` : "1px solid #e2e8f0", boxShadow: active ? "0 16px 40px rgba(0,0,0,0.12)" : "0 2px 12px rgba(0,0,0,0.06)", transition: "all 0.3s", display: "flex", flexDirection: "column", overflow: "hidden", opacity: active ? 1 : 0.3 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 15, opacity: active ? 1 : 0.5 }}>🧭</span>
        <span style={{ fontSize: 10.5, fontWeight: 900, color: "#475569", textTransform: "uppercase", letterSpacing: "0.09em" }}>Exploration Journey</span>
      </div>
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px" }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b" }}>{isEn ? "Stroller Type" : "유모차 종류"}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
          <div style={{ padding: "4px 14px 14px", display: "flex", flexWrap: "wrap", gap: 6 }}>
            <div style={{ padding: "4px 10px", borderRadius: 99, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 10, color: "#64748b", fontWeight: 500 }}>{isEn ? "Full-size" : "디럭스 유모차"}</div>
            <div style={{ padding: "4px 10px", borderRadius: 99, background: "#f8fafc", border: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ background: "#ffe4e6", color: "#f43f5e", fontSize: 8.5, fontWeight: 700, padding: "2px 6px", borderRadius: 99 }}>{isEn ? "High" : "중요"}</span>
              <span style={{ fontSize: 10, color: "#64748b", fontWeight: 500 }}>{isEn ? "Compact" : "절충형 유모차"}</span>
            </div>
          </div>
        </div>
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px" }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b" }}>{isEn ? "Brand" : "브랜드"}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
          <div style={{ padding: "4px 14px 14px", display: "flex", flexWrap: "wrap", gap: 6 }}>
            <div style={{ padding: "4px 10px", borderRadius: 99, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 10, color: "#64748b", fontWeight: 500 }}>{isEn ? "Nuna" : "뉴나 (Nuna)"}</div>
            <div style={{ padding: "4px 10px", borderRadius: 99, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 10, color: "#64748b", fontWeight: 500 }}>{isEn ? "Bugaboo" : "부가부"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}



function PanelOptionList({ active, accent, locale }: { active: boolean; accent: string; locale: 'ko' | 'en' }) {
  const isEn = locale === 'en';
  const products = [
    { brand: "Nuna", name: isEn ? "Nuna Triv Next" : "뉴나 트리브 넥스트", price: isEn ? "$700" : "1,100,000원" },
    { brand: "Bugaboo", name: isEn ? "Bugaboo Butterfly" : "부가부 버터플라이", price: isEn ? "$450" : "850,000원" },
    { brand: "Cybex", name: isEn ? "Cybex Melio" : "사이벡스 멜리오 카본", price: isEn ? "$550" : "980,000원" }
  ];
  return (
    <div style={{ flex: 1, borderRadius: 14, background: "white", border: active ? `2px solid ${accent}` : "1px solid #e2e8f0", boxShadow: active ? "0 16px 40px rgba(0,0,0,0.12)" : "0 2px 12px rgba(0,0,0,0.06)", transition: "all 0.3s", display: "flex", flexDirection: "column", overflow: "hidden", opacity: active ? 1 : 0.3 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 15, opacity: active ? 1 : 0.5 }}>📝</span>
        <span style={{ fontSize: 10.5, fontWeight: 900, color: "#475569", textTransform: "uppercase", letterSpacing: "0.09em" }}>Option List</span>
      </div>
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
        {products.map((p, i) => (
          <div key={i} style={{ borderRadius: 10, border: "1px solid #e2e8f0", padding: "10px", display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ width: 50, height: 50, borderRadius: 6, background: "#f1f5f9", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              <div style={{ position: "absolute", bottom: -4, right: -4, width: 20, height: 20, borderRadius: "50%", background: "#cbd5e1", border: "2px solid white", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 2 }}>
              <span style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700 }}>{p.brand}</span>
              <span style={{ fontSize: 12, color: "#334155", fontWeight: 700, letterSpacing: "-0.02em" }}>{p.name}</span>
              <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600, marginTop: 2 }}>{p.price}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PanelCompTable({ active, accent, locale }: { active: boolean; accent: string; locale: 'ko' | 'en' }) {
  const isEn = locale === 'en';
  return (
    <div style={{ flex: 1, borderRadius: 14, background: "white", border: active ? `2px solid ${accent}` : "1px solid #e2e8f0", boxShadow: active ? "0 16px 40px rgba(0,0,0,0.12)" : "0 2px 12px rgba(0,0,0,0.06)", transition: "all 0.3s", display: "flex", flexDirection: "column", overflow: "hidden", opacity: active ? 1 : 0.3 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 15, opacity: active ? 1 : 0.5 }}>📊</span>
        <span style={{ fontSize: 10.5, fontWeight: 900, color: "#475569", textTransform: "uppercase", letterSpacing: "0.09em" }}>Comparison Table</span>
      </div>
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "flex", paddingBottom: 10, borderBottom: "1px solid #e2e8f0", marginBottom: 6 }}>
          <div style={{ width: 24 }}></div>
          <div style={{ flex: 2, fontSize: 10, color: "#94a3b8", fontWeight: 700 }}>{isEn ? "Product" : "제품명"}</div>
          <div style={{ flex: 1.2, fontSize: 10, color: "#94a3b8", fontWeight: 700, textAlign: "center" }}>{isEn ? "Weight" : "무게"}</div>
          <div style={{ flex: 1, fontSize: 10, color: "#94a3b8", fontWeight: 700, textAlign: "center" }}>{isEn ? "Folding" : "폴딩"}</div>
        </div>
        {[
          { rank: 1, name: isEn ? "Nuna Triv" : "뉴나 트리브", w: "8.8kg", f: "✓" },
          { rank: 2, name: isEn ? "Bugaboo" : "버터플라이", w: "7.3kg", f: "✓" },
          { rank: 3, name: isEn ? "Cybex" : "멜리오 카본", w: "5.9kg", f: "-" },
        ].map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
            <div style={{ width: 24, fontSize: 10, color: "#94a3b8", fontWeight: 800 }}>{r.rank}</div>
            <div style={{ flex: 2, fontSize: 11.5, color: "#475569", fontWeight: 700, letterSpacing: "-0.02em" }}>{r.name}</div>
            <div style={{ flex: 1.2, fontSize: 11, color: "#64748b", fontWeight: 500, textAlign: "center" }}>{r.w}</div>
            <div style={{ flex: 1, fontSize: 11, color: accent, fontWeight: 700, textAlign: "center" }}>{r.f}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PanelSidebar({ active, accent, locale }: { active: boolean; accent: string; locale: 'ko' | 'en' }) {
  const isEn = locale === 'en';
  return (
    <div style={{ width: 180, flexShrink: 0, borderRadius: 14, background: "white", border: active ? `2px solid ${accent}` : "1px solid #e2e8f0", boxShadow: active ? "0 16px 40px rgba(0,0,0,0.12)" : "0 2px 12px rgba(0,0,0,0.06)", transition: "all 0.3s", display: "flex", flexDirection: "column", overflow: "hidden", opacity: active ? 1 : 0.3 }}>
      <div style={{ padding: "16px", borderBottom: "1px solid #f1f5f9", display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
           <span style={{ fontSize: 13, opacity: active ? 1 : 0.5 }}>🎯</span>
           <span style={{ fontSize: 10.5, fontWeight: 900, color: "#475569", textTransform: "uppercase", letterSpacing: "0.09em" }}>Decision Criteria</span>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
           <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "white", border: "1px solid #e2e8f0", borderRadius: 99, gap: 4 }}>
             <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
               <span style={{ background: "#fef3c7", color: "#d97706", fontSize: 8.5, fontWeight: 700, padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                 {isEn ? "Med" : "보통"}
                 <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
               </span>
               <span style={{ fontSize: 9.5, color: "#334155", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                 {isEn ? "Compact" : "절충형 유모차"}
               </span>
             </div>
             <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
               <span style={{ fontSize: 8.5, color: "#94a3b8" }}>{isEn ? "Input" : "입력"}</span>
               <div style={{ width: 1, height: 8, background: "#e2e8f0" }}></div>
               <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
               <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
             </div>
           </div>
           
           <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "white", border: "1px solid #e2e8f0", borderRadius: 99, gap: 4 }}>
             <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
               <span style={{ background: "#ffe4e6", color: "#f43f5e", fontSize: 8.5, fontWeight: 700, padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                 {isEn ? "High" : "중요"}
                 <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
               </span>
               <span style={{ fontSize: 9.5, color: "#334155", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                 {isEn ? "Budget" : "예산"}
               </span>
             </div>
             <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
               <span style={{ fontSize: 8.5, color: "#64748b" }}>{isEn ? "< $500" : "50만↓"}</span>
               <div style={{ width: 1, height: 8, background: "#e2e8f0" }}></div>
               <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
               <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
             </div>
           </div>

           <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "white", border: "1px solid #e2e8f0", borderRadius: 99, gap: 4 }}>
             <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
               <span style={{ background: "#fef3c7", color: "#d97706", fontSize: 8.5, fontWeight: 700, padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                 {isEn ? "Med" : "보통"}
                 <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
               </span>
               <span style={{ fontSize: 9.5, color: "#334155", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                 {isEn ? "1-hand fold" : "원핸드 폴딩"}
               </span>
             </div>
             <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
               <span style={{ fontSize: 8.5, color: "#94a3b8" }}>{isEn ? "Input" : "입력"}</span>
               <div style={{ width: 1, height: 8, background: "#e2e8f0" }}></div>
               <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
               <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
             </div>
           </div>
        </div>
      </div>
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
           <span style={{ fontSize: 13, opacity: active ? 1 : 0.5 }}>🛒</span>
           <span style={{ fontSize: 10.5, fontWeight: 900, color: "#475569", textTransform: "uppercase", letterSpacing: "0.09em" }}>My Options</span>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
           <div style={{ padding: "10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0", display: "flex", gap: 8, alignItems: "center" }}>
             <div style={{ width: 24, height: 24, borderRadius: 4, background: "#e2e8f0" }}></div>
             <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
               <span style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700 }}>Nuna</span>
               <span style={{ fontSize: 11, color: "#334155", fontWeight: 700 }}>{isEn ? "Triv Next" : "트리브 넥스트"}</span>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────── */
export default function PanelTour({ open, onClose, locale }: { open: boolean; onClose: () => void; locale: 'ko' | 'en' }) {
  const [step, setStep] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => { if (open) setStep(0); }, [open]);

  const cur = STEPS[step];
  const close = () => onClose();
  const next = () => step < STEPS.length - 1 ? setStep(s => s + 1) : close();
  const prev = () => step > 0 && setStep(s => s - 1);

  const modal = open && (
    <div style={{ position: "fixed", inset: 0, zIndex: 2147483647, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} onClick={close}>
      <div style={{ width: 1320, maxWidth: "96vw", maxHeight: "94vh", background: "white", borderRadius: 24, overflow: "auto", boxShadow: "0 40px 100px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 28px 12px", flexShrink: 0 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", margin: 0 }}>
              {locale === 'en' ? 'Interface Guide' : '인터페이스 안내'}
            </h2>
            <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 3, marginBottom: 0 }}>
              {locale === 'en' ? 'Learn how each panel supports your decision-making' : '각 패널이 의사결정을 어떻게 도와주는지 알아보세요'}
            </p>
          </div>
          <button onClick={close} style={{ width: 32, height: 32, borderRadius: "50%", border: "none", background: "transparent", cursor: "pointer", color: "#94a3b8", fontSize: 16 }}>✕</button>
        </div>

        {/* Large panels mock-up with coach marks */}
        <div style={{ padding: "8px 28px", position: "relative", flex: 1 }}>
          <div style={{ display: "flex", gap: 16, height: 400, position: "relative" }}>
            <PanelExploration active={step === 0} accent={STEPS[0].accentColor} locale={locale} />
            <PanelOptionList  active={step === 1} accent={STEPS[1].accentColor} locale={locale} />
            <PanelCompTable   active={step === 2} accent={STEPS[2].accentColor} locale={locale} />
            <PanelSidebar     active={step === 3} accent={STEPS[3].accentColor} locale={locale} />
            {cur.marks.map((m, i) => (
              <CoachMark key={`${step}-${i}`} text={m.text} top={m.top} left={m.left} accent={cur.accentColor} arrowLeft={(m as any).arrowLeft} arrowRight={(m as any).arrowRight} />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
            <div style={{ display: "flex", gap: 6 }}>
              {STEPS.map((_, i) => (
                <button key={i} onClick={() => setStep(i)} style={{ width: i === step ? 22 : 7, height: 7, borderRadius: 99, background: i === step ? "#6366f1" : "#cbd5e1", transition: "all 0.25s", border: "none", padding: 0, cursor: "pointer" }} />
              ))}
            </div>
          </div>
        </div>

        {/* Description */}
        <div style={{ padding: "16px 28px 20px", flexShrink: 0 }}>
          <div style={{ padding: "4px 8px" }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", margin: "0 0 6px" }}>{cur.title}</p>
            <p style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.6, margin: "0 0 6px" }}>{locale === 'en' ? cur.descEn : cur.desc}</p>
            <p style={{ fontSize: 11.5, color: "#64748b", lineHeight: 1.6, margin: 0 }}>{locale === 'en' ? cur.helpEn : cur.help}</p>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 28px 22px", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && <button onClick={prev} style={{ padding: "9px 18px", borderRadius: 99, border: "1px solid #e2e8f0", background: "white", fontSize: 12, fontWeight: 500, color: "#64748b", cursor: "pointer" }}>{locale === 'en' ? '← Prev' : '← 이전'}</button>}
            <button onClick={next} style={{ padding: "9px 22px", borderRadius: 99, border: "none", background: "#6366f1", color: "white", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {step < STEPS.length - 1 ? (locale === 'en' ? 'Next →' : '다음 →') : (locale === 'en' ? 'Get Started ✓' : '시작하기 ✓')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (!mounted || !modal) return null;
  return createPortal(modal, document.body);
}
