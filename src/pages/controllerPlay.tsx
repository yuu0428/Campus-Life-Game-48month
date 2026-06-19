import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { generateResultCard } from "../utils/generateCard";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts";
import {
  type ClientMessage,
  type ServerMessage,
  type GameState,
  type GameEvent,
  type EventChoice,
  type ChoiceResult,
  type PlayerResult,
  type Player,
  type StatEffects,
  type ResourceKey,
  RESOURCE_KEYS,
  RESOURCE_LABELS,
  RESOURCE_RANGES,
  EXPERIENCE_KEYS,
  EXPERIENCE_LABELS,
  EXPERIENCE_RANGES,
  colorForPlayer,
  getRoundInfo,
  wsUrlFromInput,
  defaultGameState,
} from "../domain/gameShared";

// Loud romance/cheating moment for the player's own screen.
function romanceMoment(result: ChoiceResult): { icon: string; text: string; color: string } | null {
  if (result.randomOutcome === "cheat_exposed") return { icon: "🔥", text: "浮気がバレた！", color: "#ff7043" };
  if (result.randomOutcome === "cheat_hidden") return { icon: "🤫", text: "浮気を隠し通した…", color: "#c8b88a" };
  const fe = result.flagEffects ?? {};
  if (fe.has_partner === true) return { icon: "💕", text: "恋人ができた！", color: "#ff6fae" };
  if (fe.has_partner === false && fe.breakup === true) return { icon: "💔", text: "失恋…", color: "#8aa0e0" };
  if (fe.romance_committed === true) return { icon: "💞", text: "恋人との絆を深めた", color: "#ff8cb4" };
  return null;
}

// ─── Flag display helpers ────────────────────────────────────────
const FLAG_DISPLAY: Record<string, { emoji: string; label: string }> = {
  living_alone: { emoji: "\u{1F3E0}", label: "\u4E00\u4EBA\u66AE\u3089\u3057" },
  has_partner: { emoji: "\u{1F495}", label: "\u604B\u4EBA\u3042\u308A" },
  cheating: { emoji: "\u26A0\uFE0F", label: "\u6D6E\u6C17\u9032\u884C\u4E2D" },
  cheated_before: { emoji: "\u26A0\uFE0F", label: "\u6D6E\u6C17\u6B74\u3042\u308A" },
  breakup: { emoji: "\u{1F327}\uFE0F", label: "\u5225\u308C\u305F\u7D4C\u9A13" },
  romance_restarted: { emoji: "\u{1F331}", label: "\u604B\u611B\u518D\u30B9\u30BF\u30FC\u30C8" },
  has_license: { emoji: "\u{1F697}", label: "\u514D\u8A31\u3042\u308A" },
  studying_abroad: { emoji: "\u2708\uFE0F", label: "\u7559\u5B66\u4E2D" },
  on_leave: { emoji: "\u{1F4A4}", label: "\u4F11\u5B66\u4E2D" },
  in_seminar: { emoji: "\u{1F393}", label: "\u30BC\u30DF\u6240\u5C5E" },
  teaching_cert: { emoji: "\u{1F4DC}", label: "\u6559\u8077\u8AB2\u7A0B" },
};

const RESOURCE_EMOJI: Record<ResourceKey, string> = {
  time: "\u23F0",
  health: "\u2764\uFE0F",
  money: "\u{1F4B0}",
  credits: "\u{1F4DA}",
};

const STAT_COLORS: Record<string, string> = {
  time: "#5bb7d4",
  health: "#ef4444",
  money: "#f59e0b",
  credits: "#82C045",
  intellect: "#315F1F",
  connections: "#ec4899",
  work_tolerance: "#f97316",
  action_power: "#14b8a6",
  romance_exp: "#e11d48",
};

const SCORE_BREAKDOWN_LABELS = {
  experience: "経験",
  health: "体力",
  money: "お金",
  credits: "単位",
  total: "合計",
} as const;
const BRAND = {
  ink: "#172313",
  muted: "#596651",
  green: "#82C045",
  greenDeep: "#315F1F",
  greenSoft: "#EDF8E6",
  line: "rgba(49, 95, 31, 0.16)",
  shadow: "0 10px 0 rgba(49, 95, 31, 0.06), 0 18px 42px rgba(23, 51, 15, 0.14)",
};

// ─── Styles ──────────────────────────────────────────────────────
const S = {
  root: {
    background:
      "linear-gradient(90deg, rgba(23, 51, 15, 0.04) 1px, transparent 1px), linear-gradient(180deg, rgba(23, 51, 15, 0.04) 1px, transparent 1px), #f4f8f0",
    backgroundSize: "34px 34px",
    minHeight: "100vh",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: 16,
    color: BRAND.ink,
    touchAction: "manipulation" as const,
    overscrollBehavior: "none" as const,
    overflowX: "hidden" as const,
    paddingBottom: 32,
  },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    background: "rgba(255, 255, 255, 0.94)",
    borderBottom: `1px solid ${BRAND.line}`,
    boxShadow: "0 4px 0 rgba(49, 95, 31, 0.08)",
    position: "sticky" as const,
    top: 0,
    zIndex: 10,
  },
  roundBadge: {
    fontSize: 13,
    fontWeight: 600,
    color: BRAND.greenDeep,
  },
  statusDot: (connected: boolean) => ({
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: connected ? BRAND.green : "#ef4444",
    marginRight: 6,
  }),
  statusText: {
    fontSize: 13,
    color: BRAND.muted,
  },
  section: {
    padding: "16px",
  },
  card: {
    background: "#fff",
    boxSizing: "border-box" as const,
    borderRadius: 18,
    padding: "20px",
    margin: "0 16px 16px",
    border: `1px solid ${BRAND.line}`,
    boxShadow: BRAND.shadow,
  },
  waitingMsg: (pulse: boolean) => ({
    textAlign: "center" as const,
    padding: "40px 20px",
    fontSize: 18,
    fontWeight: 500,
    color: BRAND.muted,
    animation: pulse ? "pulse 2s ease-in-out infinite" : "none",
  }),
  diceButton: (color: string) => ({
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 140,
    height: 140,
    borderRadius: 24,
    border: "none",
    background: `linear-gradient(135deg, ${color}, ${color}dd)`,
    color: "#10220d",
    fontSize: 24,
    fontWeight: 700,
    cursor: "pointer",
    margin: "20px auto",
    boxShadow: `0 8px 0 rgba(49, 95, 31, 0.22), 0 18px 28px ${color}33`,
    transition: "transform 0.15s, box-shadow 0.15s",
    touchAction: "manipulation" as const,
  }),
  diceResult: {
    textAlign: "center" as const,
    padding: "24px 0",
  },
  diceNumber: {
    fontSize: 64,
    fontWeight: 800,
    lineHeight: 1,
  },
  diceAdvanced: {
    fontSize: 16,
    color: BRAND.muted,
    marginTop: 8,
  },
  eventTitle: {
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 8,
  },
  eventDesc: {
    fontSize: 15,
    color: BRAND.muted,
    lineHeight: 1.6,
    marginBottom: 20,
  },
  choiceCard: (available: boolean, selected: boolean) => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
    padding: "16px",
    borderRadius: 16,
    border: selected
      ? "2px solid #82C045"
      : available
        ? `1px solid ${BRAND.line}`
        : `1px solid ${BRAND.line}`,
    background: available ? "#fff" : "#eef3e8",
    opacity: available ? 1 : 0.55,
    cursor: available ? "pointer" : "default",
    marginBottom: 12,
    boxShadow: available
      ? "0 5px 0 rgba(49, 95, 31, 0.08), 0 12px 20px rgba(23, 51, 15, 0.08)"
      : "none",
    transition: "border-color 0.15s, transform 0.1s",
    touchAction: "manipulation" as const,
  }),
  choiceLetter: (color: string) => ({
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: color,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 16,
  }),
  choiceLabel: {
    fontSize: 16,
    fontWeight: 600,
    marginBottom: 6,
  },
  effectBadge: (positive: boolean) => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    marginRight: 4,
    marginBottom: 4,
    background: positive ? BRAND.greenSoft : "#fef2f2",
    color: positive ? BRAND.greenDeep : "#991b1b",
  }),
  conditionText: {
    fontSize: 12,
    color: BRAND.muted,
    marginTop: 4,
  },
  confirmOverlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(9, 19, 7, 0.56)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    padding: 24,
  },
  confirmDialog: {
    background: "#fff",
    borderRadius: 20,
    padding: "28px 24px",
    maxWidth: 340,
    width: "100%",
    textAlign: "center" as const,
  },
  confirmTitle: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 20,
  },
  confirmBtns: {
    display: "flex",
    gap: 12,
  },
  confirmBtn: (primary: boolean) => ({
    flex: 1,
    padding: "14px 0",
    borderRadius: 12,
    border: primary ? "none" : `1px solid ${BRAND.line}`,
    background: primary ? "linear-gradient(180deg, #8fce50, #72ad38)" : "#fff",
    color: primary ? "#10220d" : BRAND.greenDeep,
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
    touchAction: "manipulation" as const,
  }),
  // Stats dashboard
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12,
    marginBottom: 16,
  },
  statItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  },
  statEmoji: {
    fontSize: 20,
  },
  statLabel: {
    fontSize: 12,
    color: BRAND.muted,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 700,
  },
  statBar: (pct: number, color: string) => ({
    height: 4,
    borderRadius: 2,
    background: "#dfe8d8",
    marginTop: 2,
    position: "relative" as const,
    overflow: "hidden" as const,
    width: "100%",
    backgroundImage: `linear-gradient(to right, ${color} ${pct}%, #dfe8d8 ${pct}%)`,
  }),
  expItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 0",
    fontSize: 14,
  },
  flagBadge: {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 16,
    background: BRAND.greenSoft,
    color: BRAND.greenDeep,
    fontSize: 13,
    fontWeight: 500,
    marginRight: 6,
    marginBottom: 6,
  },
  // Animation badges
  animBadge: (positive: boolean) => ({
    display: "inline-block",
    fontSize: 20,
    fontWeight: 700,
    color: positive ? BRAND.green : "#ef4444",
    animation: "floatUp 1.5s ease-out forwards",
    marginRight: 8,
  }),
  // Result
  resultEmoji: {
    fontSize: 64,
    textAlign: "center" as const,
    marginBottom: 8,
  },
  resultTitle: {
    fontSize: 28,
    fontWeight: 800,
    textAlign: "center" as const,
    marginBottom: 8,
  },
  resultDesc: {
    fontSize: 15,
    color: BRAND.muted,
    textAlign: "center" as const,
    lineHeight: 1.6,
    marginBottom: 20,
  },
  resultRank: {
    fontSize: 40,
    fontWeight: 800,
    textAlign: "center" as const,
    marginBottom: 16,
  },
  shareCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    marginTop: 18,
    padding: 14,
    borderRadius: 14,
    border: `1px solid rgba(130, 192, 69, 0.26)`,
    background: "#f2fde9",
  },
  shareCardTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: BRAND.greenDeep,
  },
  shareCardText: {
    marginTop: 3,
    color: BRAND.muted,
    fontSize: 12,
    lineHeight: 1.45,
  },
  shareCardStatus: {
    marginTop: 6,
    color: "#166534",
    fontSize: 12,
    fontWeight: 700,
  },
  shareButton: (disabled = false) => ({
    flexShrink: 0,
    border: "none",
    borderRadius: 12,
    padding: "11px 16px",
    background: disabled ? "#bcd9aa" : "linear-gradient(180deg, #8fce50, #72ad38)",
    color: disabled ? "#596651" : "#10220d",
    boxShadow: disabled ? "none" : "0 6px 0 #4f8429, 0 14px 22px rgba(49, 95, 31, 0.22)",
    fontSize: 14,
    fontWeight: 800,
    cursor: disabled ? "default" : "pointer",
  }),
  resultCardGenerateButton: (disabled = false) => ({
    width: "100%",
    marginTop: 12,
    justifyContent: "center",
    opacity: disabled ? 0.7 : 1,
  }),
  resultCardOverlay: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    background: "rgba(10, 15, 31, 0.88)",
  },
  resultCardPreview: {
    width: "min(100%, 420px)",
    maxHeight: "92vh",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: 12,
  },
  resultCardPreviewText: {
    margin: 0,
    color: "#fff",
    fontSize: 13,
    textAlign: "center" as const,
  },
  resultCardPreviewImage: {
    maxWidth: "100%",
    maxHeight: "76vh",
    borderRadius: 14,
    boxShadow: "0 18px 60px rgba(0, 0, 0, 0.35)",
  },
  // Tab bar
  tabBar: {
    display: "flex",
    borderBottom: `2px solid ${BRAND.line}`,
    marginBottom: 16,
  },
  tab: (active: boolean) => ({
    flex: 1,
    padding: "10px 0",
    textAlign: "center" as const,
    fontSize: 14,
    fontWeight: 600,
    color: active ? BRAND.greenDeep : "#89927d",
    borderBottom: active ? "2px solid #82C045" : "2px solid transparent",
    cursor: "pointer",
    background: "none",
    border: "none",
    borderBottomStyle: "solid" as const,
    borderBottomWidth: 2,
    borderBottomColor: active ? "#82C045" : "transparent",
    touchAction: "manipulation" as const,
  }),
} as const;

// ─── Inject keyframe animations ─────────────────────────────────
const styleTag = document.createElement("style");
styleTag.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  @keyframes floatUp {
    0% { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-40px); }
  }
  @keyframes diceShake {
    0%, 100% { transform: rotate(0deg) scale(1); }
    25% { transform: rotate(-8deg) scale(1.05); }
    75% { transform: rotate(8deg) scale(1.05); }
  }
`;
document.head.appendChild(styleTag);

// ─── Helper: render stat effects as badges ──────────────────────
export function EffectBadges({ effects }: { effects?: StatEffects }) {
  if (!effects) return null;
  const allKeys = [...RESOURCE_KEYS, ...EXPERIENCE_KEYS] as string[];
  const labels: Record<string, string> = { ...RESOURCE_LABELS, ...EXPERIENCE_LABELS };
  const entries = allKeys
    .filter((k) => (effects as Record<string, number>)[k] !== undefined)
    .map((k) => ({
      key: k,
      value: (effects as Record<string, number>)[k],
      label: labels[k],
    }));
  if (entries.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap" }}>
      {entries.map((e) => (
        <span key={e.key} style={S.effectBadge(e.value > 0)}>
          {e.value > 0 ? "+" : ""}
          {e.value} {e.label}
        </span>
      ))}
    </div>
  );
}

export function ChoicePreview({ choice }: { choice: EventChoice }) {
  const riskLabel: Record<string, string> = {
    low: "低",
    medium: "中",
    high: "高",
    unknown: "不明",
  };
  const tags = choice.storyTags ?? [];

  if (!choice.preview && !choice.tone && tags.length === 0 && !choice.description) {
    return (
      <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
        結果は決定後に反映されます
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {choice.description && (
        <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>
          {choice.description}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {choice.tone && <span style={S.effectBadge(true)}>{choice.tone}</span>}
        {choice.preview?.gain.map((item) => (
          <span key={`gain-${item}`} style={S.effectBadge(true)}>
            得られそう: {item}
          </span>
        ))}
        {choice.preview?.cost.map((item) => (
          <span key={`cost-${item}`} style={S.effectBadge(false)}>
            気をつけたい: {item}
          </span>
        ))}
      </div>
      {(choice.preview || tags.length > 0) && (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          {choice.preview ? `リスク: ${riskLabel[choice.preview.risk]}` : ""}
          {choice.preview && tags.length > 0 ? " / " : ""}
          {tags.length > 0 ? tags.join("・") : ""}
        </div>
      )}
    </div>
  );
}

function formatPlayerNameList(players: Player[]): string {
  const names = players.map((player) => `${player.name || "名前未設定"}さん`);
  if (names.length === 0) return "...";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}と${names[1]}`;
  return `${names.slice(0, -1).join("、")}と${names[names.length - 1]}`;
}

// ─── Stats Dashboard Component ──────────────────────────────────
export function StatsDashboard({ player }: { player: Player }) {
  const [tab, setTab] = useState<"resources" | "experience" | "flags">(
    "resources"
  );

  const activeFlags = useMemo(() => {
    const result: { key: string; emoji: string; label: string }[] = [];
    for (const [key, info] of Object.entries(FLAG_DISPLAY)) {
      if ((player.flags as unknown as Record<string, unknown>)[key]) {
        result.push({ key, ...info });
      }
    }
    if (player.flags.club_type && player.flags.club_type !== "none") {
      result.push({
        key: "club",
        emoji: "\u{1F3AF}",
        label: player.flags.club_type,
      });
    }
    if (player.flags.job_type) {
      result.push({
        key: "job",
        emoji: "\u{1F4BC}",
        label: player.flags.job_type,
      });
    }
    const exCount = Number(player.flags.ex_partner_count ?? 0);
    if (exCount > 0) {
      result.push({
        key: "ex_partner",
        emoji: "\u{1F494}",
        label: `元恋人 ${exCount}人`,
      });
    }
    return result;
  }, [player.flags]);

  return (
    <div>
      <div style={S.tabBar}>
        <button
          style={S.tab(tab === "resources")}
          onClick={() => setTab("resources")}
        >
          リソース
        </button>
        <button
          style={S.tab(tab === "experience")}
          onClick={() => setTab("experience")}
        >
          経験値
        </button>
        <button
          style={S.tab(tab === "flags")}
          onClick={() => setTab("flags")}
        >
          状態
        </button>
      </div>

      {tab === "resources" && (
        <div style={S.statsGrid}>
          {RESOURCE_KEYS.map((key) => {
            const range = RESOURCE_RANGES[key];
            const val = player.resources[key];
            const pct = Math.max(
              0,
              Math.min(
                100,
                ((val - range.min) / (range.max - range.min)) * 100
              )
            );
            return (
              <div key={key}>
                <div style={S.statItem}>
                  <span style={S.statEmoji}>{RESOURCE_EMOJI[key]}</span>
                  <div style={{ flex: 1 }}>
                    <div style={S.statLabel}>{RESOURCE_LABELS[key]}</div>
                    <div style={S.statValue}>{val}</div>
                    <div style={S.statBar(pct, STAT_COLORS[key])} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "experience" && (
        <div>
          {EXPERIENCE_KEYS.map((key) => {
            const range = EXPERIENCE_RANGES[key];
            const val = player.experience[key];
            const pct = Math.max(
              0,
              Math.min(
                100,
                ((val - range.min) / (range.max - range.min)) * 100
              )
            );
            return (
              <div key={key} style={S.expItem}>
                <span>{EXPERIENCE_LABELS[key]}</span>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      ...S.statBar(pct, STAT_COLORS[key]),
                      width: 80,
                    }}
                  />
                  <span style={{ fontWeight: 700, minWidth: 20 }}>{val}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "flags" && (
        <div style={{ padding: "8px 0" }}>
          {activeFlags.length === 0 ? (
            <div style={{ color: "#9ca3af", fontSize: 14 }}>
              まだ特殊な状態はありません
            </div>
          ) : (
            activeFlags.map((f) => (
              <span key={f.key} style={S.flagBadge}>
                {f.emoji}
                {f.label}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Controller Play Page ──────────────────────────────────
export function ControllerPlayPage() {
  const [state, setState] = useState<GameState>(defaultGameState());
  const [clientId, setClientId] = useState<string | null>(
    sessionStorage.getItem("clg_controller_id")
  );
  const [name] = useState(sessionStorage.getItem("clg_name") ?? "");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("接続中...");

  // Event/choice state from server messages
  const [currentEvent, setCurrentEvent] = useState<GameEvent | null>(null);
  const [availableChoiceIds, setAvailableChoiceIds] = useState<string[]>([]);
  const [eventTargetPlayerId, setEventTargetPlayerId] = useState<string | null>(
    null
  );
  const [lastChoiceResult, setLastChoiceResult] =
    useState<ChoiceResult | null>(null);
  const [gameResults, setGameResults] = useState<PlayerResult[] | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [cardImageUrl, setCardImageUrl] = useState<string | null>(null);
  const [cardGenerating, setCardGenerating] = useState(false);

  // Simultaneous mode: results from all players, revealed together
  const [revealedResults, setRevealedResults] = useState<ChoiceResult[] | null>(null);

  // UI state
  const [confirmChoice, setConfirmChoice] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const [showStatChanges, setShowStatChanges] = useState(false);
  const [myDiceResult, setMyDiceResult] = useState<{ value: number; squares: number } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef<string | null>(clientId);
  clientIdRef.current = clientId;
  const stateRef = useRef<GameState>(state);
  const showStatChangesRef = useRef(showStatChanges);
  showStatChangesRef.current = showStatChanges;
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removedByHostRef = useRef(false);

  const hostUrl = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("host") || window.location.origin;
  }, []);

  const myPlayer = useMemo(() => {
    if (!clientId) return undefined;
    return state.players.find((p) => p.id === clientId);
  }, [clientId, state.players]);

  const myPlayerIndex = useMemo(() => {
    if (!clientId) return 0;
    const idx = state.players.findIndex((p) => p.id === clientId);
    return idx >= 0 ? idx : 0;
  }, [clientId, state.players]);

  const currentTurnPlayer = useMemo(() => {
    if (state.turnOrder.length === 0 || state.players.length === 0) return undefined;
    const currentId = state.turnOrder[state.turnIndex % state.turnOrder.length];
    return state.players.find((p) => p.id === currentId);
  }, [state.players, state.turnIndex, state.turnOrder]);

  const activeTurnPlayers = useMemo(() => {
    const activeIds = state.activeTurnPlayerIds?.length
      ? state.activeTurnPlayerIds
      : currentTurnPlayer
        ? [currentTurnPlayer.id]
        : [];
    return activeIds
      .map((id) => state.players.find((player) => player.id === id))
      .filter((player): player is Player => Boolean(player));
  }, [currentTurnPlayer, state.activeTurnPlayerIds, state.players]);

  const activeTurnLabel = useMemo(
    () => formatPlayerNameList(activeTurnPlayers),
    [activeTurnPlayers]
  );

  const isActiveTurnPlayer = useMemo(
    () => !!clientId && activeTurnPlayers.some((player) => player.id === clientId),
    [activeTurnPlayers, clientId]
  );

  const isBoardMode = state.mode !== "life_map";

  const myBoardChoiceSubmitted = useMemo(
    () => Boolean(clientId && state.pendingTurnChoices?.[clientId]),
    [clientId, state.pendingTurnChoices]
  );

  const myBoardEvent = useMemo(() => {
    if (!clientId || !isBoardMode) return null;
    const eventForPlayer = state.activeTurnEvents?.[clientId];
    if (eventForPlayer) return eventForPlayer;
    if (eventTargetPlayerId === clientId) return currentEvent;
    if (
      state.currentEvent &&
      activeTurnPlayers.length === 1 &&
      activeTurnPlayers[0]?.id === clientId
    ) {
      return state.currentEvent;
    }
    return null;
  }, [
    activeTurnPlayers,
    clientId,
    currentEvent,
    eventTargetPlayerId,
    isBoardMode,
    state.activeTurnEvents,
    state.currentEvent,
  ]);

  const myAvailableChoiceIds = useMemo(() => {
    if (!clientId) return [];
    if (!isBoardMode) return availableChoiceIds;
    const idsForPlayer = state.availableChoiceIdsByPlayer?.[clientId];
    if (idsForPlayer) return idsForPlayer;
    if (eventTargetPlayerId === clientId) return availableChoiceIds;
    if (
      state.currentEvent &&
      activeTurnPlayers.length === 1 &&
      activeTurnPlayers[0]?.id === clientId
    ) {
      return state.availableChoiceIds;
    }
    return [];
  }, [
    activeTurnPlayers,
    availableChoiceIds,
    clientId,
    eventTargetPlayerId,
    isBoardMode,
    state.availableChoiceIds,
    state.availableChoiceIdsByPlayer,
    state.currentEvent,
  ]);

  const boardChoiceResultForMe = useMemo(() => {
    if (!clientId || !isBoardMode) return null;
    return (
      state.lastTurnGroupResults?.find((result) => result.playerId === clientId) ??
      null
    );
  }, [clientId, isBoardMode, state.lastTurnGroupResults]);

  const activeChoiceResult = useMemo(
    () => boardChoiceResultForMe ?? lastChoiceResult,
    [boardChoiceResultForMe, lastChoiceResult]
  );
  const boardDisplayReady =
    !isBoardMode ||
    (state.startedAt !== null && state.displayStartedAt === state.startedAt);

  const myLifeChoiceSubmitted = useMemo(
    () => Boolean(clientId && state.pendingLifeChoices?.[clientId]),
    [clientId, state.pendingLifeChoices]
  );

  const roundInfo = useMemo(
    () => getRoundInfo(state.currentRound),
    [state.currentRound]
  );

  const accentColor = useMemo(
    () => colorForPlayer(myPlayerIndex),
    [myPlayerIndex]
  );

  // ─── WebSocket connection ───────────────────────────────────
  const connect = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const targetUrl = wsUrlFromInput(hostUrl);
    if (!targetUrl) {
      setStatus("接続先URLが不正です");
      return;
    }

    setStatus("接続中...");
    const socket = new WebSocket(targetUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      const payload: ClientMessage = {
        type: "join",
        name: name.trim(),
        role: "controller",
        clientId: sessionStorage.getItem("clg_controller_id") ?? undefined,
        passkey: sessionStorage.getItem("clg_passkey") ?? undefined,
      };
      socket.send(JSON.stringify(payload));
    };

    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMessage;

      switch (msg.type) {
        case "welcome":
          setClientId(msg.clientId);
          sessionStorage.setItem("clg_controller_id", msg.clientId);
          if (msg.passkey) {
            sessionStorage.setItem("clg_passkey", msg.passkey);
          }
          setConnected(true);
          setStatus("接続済み");
          break;

        case "auth_error":
          sessionStorage.removeItem("clg_controller_id");
          setClientId(null);
          setConnected(false);
          setStatus(msg.message);
          window.location.href = `/controller.html?host=${encodeURIComponent(hostUrl)}`;
          break;

        case "state": {
          const prev = stateRef.current;
          setState(msg.state);
          stateRef.current = msg.state;

          // Detect my dice roll result
          if (
            msg.state.lastRoll &&
            msg.state.lastRoll.playerId === clientIdRef.current &&
            (!prev.lastRoll || prev.lastRoll.playerId !== clientIdRef.current || prev.phase === "rolling")
          ) {
            setMyDiceResult({
              value: msg.state.lastRoll.value,
              squares: msg.state.lastRoll.squaresAdvanced,
            });
            setRolling(false);
          }

          // Clear event if phase changed away from choosing
          if (
            msg.state.phase !== "choosing" &&
            msg.state.phase !== "animating"
          ) {
            setCurrentEvent(null);
            setAvailableChoiceIds([]);
            setEventTargetPlayerId(null);
          }
          // When it's a new turn (rolling phase, no lastRoll), clear dice result
          if (msg.state.phase === "rolling" && !msg.state.lastRoll) {
            setMyDiceResult(null);
          }
          // Don't clear animation state if we're currently showing stat changes
          if (!showStatChangesRef.current) {
            setLastChoiceResult(null);
          }
          break;
        }

        case "show_event": {
          setRolling(false);
          // If this event is for me and I just rolled, delay showing
          // the event so the dice result is visible for 1.5 seconds
          const isForMe = msg.playerId === clientIdRef.current;
          if (!isForMe) break;
          const delay = isForMe ? 1500 : 0;
          setTimeout(() => {
            setMyDiceResult(null);
            setCurrentEvent(msg.event);
            setAvailableChoiceIds(msg.availableChoiceIds);
            setEventTargetPlayerId(msg.playerId);
          }, delay);
          break;
        }

        case "show_life_event": {
          setRolling(false);
          setMyDiceResult(null);
          setCurrentEvent(msg.event);
          setAvailableChoiceIds(msg.availableChoiceIds);
          setEventTargetPlayerId(clientIdRef.current);
          // Reset revealed results when a new event arrives (simultaneous mode)
          setRevealedResults(null);
          break;
        }

        case "choice_result": {
          const isMine = msg.result.playerId === clientIdRef.current;
          if (!isMine) break;

          setLastChoiceResult(msg.result);
          setCurrentEvent(null);
          setConfirmChoice(null);
          setShowStatChanges(true);
          setTimeout(
            () => setShowStatChanges(false),
            stateRef.current.mode === "life_map" ? 5000 : 2000
          );
          break;
        }

        case "all_choices_revealed": {
          // Simultaneous mode: all players' choices revealed at once
          setRevealedResults(msg.results);
          setCurrentEvent(null);
          setConfirmChoice(null);
          break;
        }

        case "game_result":
          setGameResults(msg.results);
          break;

        case "system":
          setStatus(msg.message);
          break;

        case "navigate":
          if (msg.targetRoles.includes("controller")) {
            window.location.href = msg.url;
          }
          break;

        case "player_removed":
          removedByHostRef.current = true;
          sessionStorage.removeItem("clg_controller_id");
          sessionStorage.removeItem("clg_name");
          if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
          wsRef.current?.close();
          window.location.href = `/controller.html?host=${encodeURIComponent(hostUrl)}`;
          break;
      }
    };

    socket.onerror = () => {
      setStatus("接続エラー");
      setConnected(false);
    };

    socket.onclose = () => {
      setStatus("切断されました");
      setConnected(false);
      wsRef.current = null;
      if (removedByHostRef.current) return;
      // Auto reconnect after 3s
      reconnectTimer.current = setTimeout(connect, 3000);
    };
  }, [hostUrl, name]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMessage = useCallback(
    (payload: ClientMessage) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify(payload));
    },
    []
  );

  // ─── Actions ────────────────────────────────────────────────
  const handleRoll = useCallback(() => {
    setRolling(true);
    sendMessage({ type: "player_roll" });
  }, [sendMessage]);

  const handleChoiceConfirm = useCallback(() => {
    if (!confirmChoice) return;
    sendMessage({ type: "player_choice", choiceId: confirmChoice });
    setConfirmChoice(null);
  }, [confirmChoice, sendMessage]);

  // ─── Determine visual state ─────────────────────────────────
  type ViewState =
    | "waiting"
    | "rolling"
    | "dice_result"
    | "choosing"
    | "animating"
    | "revealed"
    | "year_recap"
    | "result";

  const viewState = useMemo((): ViewState => {
    if (gameResults || state.phase === "result") return "result";
    if (state.phase === "year_recap") return "year_recap";
    // Simultaneous mode: show all-choices-revealed UI (master feature)
    if (revealedResults && state.phase === "revealed") return "revealed";
    if ((showStatChanges || state.phase === "animating") && activeChoiceResult) {
      return "animating";
    }
    if (isBoardMode && state.phase === "choosing" && myBoardChoiceSubmitted) {
      return "waiting";
    }
    if (isBoardMode && state.phase === "choosing" && myBoardEvent) {
      return "choosing";
    }
    if (
      !isBoardMode &&
      currentEvent &&
      eventTargetPlayerId === clientId &&
      !myLifeChoiceSubmitted
    ) {
      return "choosing";
    }
    if (myDiceResult && !currentEvent) return "dice_result";
    if (isActiveTurnPlayer && state.phase === "rolling") return "rolling";
    return "waiting";
  }, [
    state.phase,
    revealedResults,
    isActiveTurnPlayer,
    isBoardMode,
    currentEvent,
    eventTargetPlayerId,
    clientId,
    activeChoiceResult,
    showStatChanges,
    gameResults,
    myDiceResult,
    myBoardChoiceSubmitted,
    myBoardEvent,
    myLifeChoiceSubmitted,
  ]);

  // ─── Render helpers ─────────────────────────────────────────

  const renderTurnGroupSummary = () => {
    if (!isBoardMode || activeTurnPlayers.length === 0 || state.phase === "lobby") {
      return null;
    }

    const submittedPlayers = activeTurnPlayers.filter((player) =>
      Boolean(state.pendingTurnChoices?.[player.id])
    );

    return (
      <div
        style={{
          borderRadius: 14,
          background: "#f8fafc",
          border: "1px solid #e5e7eb",
          padding: "12px 14px",
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>
          今のターン
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>
          {activeTurnLabel}
        </div>
        {state.phase === "choosing" && activeTurnPlayers.length > 1 && (
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
            {submittedPlayers.length}/{activeTurnPlayers.length} 人が選択済み
          </div>
        )}
      </div>
    );
  };

  const renderWaiting = () => {
    const pendingPlayers = activeTurnPlayers.filter(
      (player) => !state.pendingTurnChoices?.[player.id]
    );
    const waitingForOthers = pendingPlayers.filter(
      (player) => player.id !== clientId
    );

    let message = "待機中...";
    if (state.phase === "lobby") {
      message = "ゲーム開始を待っています...";
    } else if (state.mode === "life_map" && state.phase === "choosing") {
      // Differentiate simultaneous (master) vs sequential mode
      const isSimultaneous = state.currentChoiceMode === "simultaneous";
      message = myLifeChoiceSubmitted
        ? isSimultaneous
          ? "送信済み。全員の選択を待っています..."
          : "選択済み。ほかの人の選択を待っています..."
        : isSimultaneous
          ? "みんなが同時に選択中..."
          : `${currentTurnPlayer?.name ?? "..."}のターン中...`;
    } else if (isBoardMode && state.phase === "choosing" && myBoardChoiceSubmitted) {
      message =
        waitingForOthers.length > 0
          ? `選択済み。${formatPlayerNameList(waitingForOthers)}の選択を待っています...`
          : "選択済み。結果を待っています...";
    } else if (isBoardMode && state.phase === "choosing") {
      message = `${activeTurnLabel}が選択中...`;
    } else if (isBoardMode && state.phase === "rolling") {
      message = `${activeTurnLabel}のターンです...`;
    } else if (isBoardMode && state.phase === "animating") {
      message = `${activeTurnLabel}の結果を確認中...`;
    } else if (currentTurnPlayer) {
      message = `${currentTurnPlayer.name}さんのターン中...`;
    }

    return (
      <div style={S.card}>
        {renderTurnGroupSummary()}
        <div style={S.waitingMsg(true)}>{message}</div>
      </div>
    );
  };

  // Simultaneous mode reveal screen (master feature): all players' choices shown together
  const renderRevealed = () => {
    if (!revealedResults) return null;
    const myResult = revealedResults.find((r) => r.playerId === clientId);
    return (
      <div style={S.card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, textAlign: "center" }}>
          全員の選択が明らかに！
        </div>
        {myResult && (
          <div style={{ marginBottom: 12, padding: "8px 12px", background: "rgba(255,255,255,0.05)", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>あなたの選択</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>「{myResult.choiceLabel}」</div>
          </div>
        )}
        <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6 }}>全員の選択</div>
        {revealedResults.map((r) => (
          <div
            key={r.playerId}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "4px 0",
              fontSize: 13,
              borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <span style={{ color: r.playerId === clientId ? "#60a5fa" : "#e5e7eb" }}>
              {r.playerName}
            </span>
            <span style={{ color: "#d1d5db" }}>→ {r.choiceLabel}</span>
          </div>
        ))}
        <div style={{ marginTop: 12, fontSize: 12, color: "#6b7280", textAlign: "center" }}>
          ホストが次のイベントに進めます
        </div>
      </div>
    );
  };

  const renderRolling = () => (
    <div style={S.card}>
      {renderTurnGroupSummary()}
      <div style={{ textAlign: "center", padding: "16px 0" }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
          {activeTurnPlayers.length > 1 ? "あなたたちのターンです!" : "あなたの月です!"}
        </div>
        {activeTurnPlayers.length > 1 && (
          <div style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.6 }}>
            同じタイミングでイベントを開き、それぞれの選択を比べられます。
          </div>
        )}
        <button
          style={{
            ...S.diceButton(accentColor),
            ...(rolling
              ? { animation: "diceShake 0.3s ease-in-out infinite" }
              : {}),
          }}
          onClick={handleRoll}
          disabled={rolling || !boardDisplayReady}
        >
          {rolling ? "..." : boardDisplayReady ? "今月のイベントを開く" : "ディスプレイ開始待ち"}
        </button>
        <div style={{ fontSize: 14, color: BRAND.muted, marginTop: 8 }}>
          {boardDisplayReady
            ? "タップして今月のイベントを開こう"
            : "共有ディスプレイのゲームスタートを待っています"}
        </div>
      </div>
    </div>
  );

  const renderDiceResult = () => {
    if (!myDiceResult) return null;
    return (
      <div style={S.card}>
        <div style={S.diceResult}>
          <div style={{ ...S.diceNumber, color: accentColor, fontSize: 36 }}>
            OPEN
          </div>
          <div style={S.diceAdvanced}>
            今月のイベントへ
          </div>
        </div>
      </div>
    );
  };

  const renderChoosing = () => {
    const eventToRender = isBoardMode ? myBoardEvent : currentEvent;
    if (!eventToRender) return null;
    const CHOICE_COLORS = [
      "#82C045",
      "#f59e0b",
      "#ef4444",
      "#22c55e",
      "#5bb7d4",
    ];
    return (
      <div style={S.card}>
        {renderTurnGroupSummary()}
        <div style={S.eventTitle}>{eventToRender.title}</div>
        <div style={S.eventDesc}>{eventToRender.description}</div>

        {eventToRender.choices.map((choice, i) => {
          const isAvailable = myAvailableChoiceIds.includes(choice.id);
          const letter = String.fromCharCode(65 + i);
          return (
            <div
              key={choice.id}
              style={S.choiceCard(isAvailable, confirmChoice === choice.id)}
              onClick={() => {
                if (isAvailable) setConfirmChoice(choice.id);
              }}
            >
              <div
                style={S.choiceLetter(
                  isAvailable ? CHOICE_COLORS[i % CHOICE_COLORS.length] : "#9ca3af"
                )}
              >
                {letter}
              </div>
              <div style={{ flex: 1 }}>
                <div style={S.choiceLabel}>{choice.label}</div>
                <ChoicePreview choice={choice} />
                {!isAvailable && choice.condition && (
                  <div style={S.conditionText}>
                    条件:{" "}
                    {choice.condition.requiredFlags
                      ? Object.entries(choice.condition.requiredFlags)
                          .filter(([, v]) => v)
                          .map(
                            ([k]) =>
                              FLAG_DISPLAY[k]?.label ?? k
                          )
                          .join(", ")
                      : ""}
                    {choice.condition.minStats
                      ? Object.entries(choice.condition.minStats)
                          .map(([k, v]) => {
                            const label =
                              (RESOURCE_LABELS as Record<string, string>)[k] ??
                              (EXPERIENCE_LABELS as Record<string, string>)[k] ??
                              k;
                            return `${label} ${v}以上`;
                          })
                          .join(", ")
                      : ""}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderAnimating = () => {
    if (!activeChoiceResult) return null;
    const allKeys = [...RESOURCE_KEYS, ...EXPERIENCE_KEYS] as string[];
    const labels: Record<string, string> = {
      ...RESOURCE_LABELS,
      ...EXPERIENCE_LABELS,
    };
    const changes = allKeys
      .filter(
        (k) =>
          (activeChoiceResult.effects as Record<string, number>)[k] !== undefined
      )
      .map((k) => ({
        key: k,
        value: (activeChoiceResult.effects as Record<string, number>)[k],
        label: labels[k],
      }));

    return (
      <div style={S.card}>
        {renderTurnGroupSummary()}
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          {(() => {
            const moment = romanceMoment(activeChoiceResult);
            return moment ? (
              <div style={{ fontSize: 22, fontWeight: 900, color: moment.color, marginBottom: 14 }}>
                {moment.icon} {moment.text}
              </div>
            ) : null;
          })()}
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
            「{activeChoiceResult.choiceLabel}」を選択
          </div>
          <div>
            {changes.map((c) => (
              <span key={c.key} style={S.animBadge(c.value > 0)}>
                {c.value > 0 ? "+" : ""}
                {c.value} {c.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderYearRecap = () => {
    const recap = state.yearRecap;
    if (!recap) {
      return (
        <div style={S.card}>
          <div style={S.waitingMsg(false)}>年末の振り返りを準備しています...</div>
        </div>
      );
    }

    return (
      <div style={S.card}>
        <div style={S.eventTitle}>{recap.title}</div>
        <div style={S.eventDesc}>
          ホストが次の年へ進めるまで、全員の今の状態を確認できます。
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {recap.players.map((player) => {
            const isMe = player.playerId === clientId;
            return (
              <div
                key={player.playerId}
                style={{
                  border: isMe ? `2px solid ${accentColor}` : "1px solid #e5e7eb",
                  borderRadius: 16,
                  padding: 14,
                  background: isMe ? "#f8fbff" : "#fff",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontSize: 17, fontWeight: 800 }}>
                    {player.playerName}
                  </div>
                  {isMe && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: accentColor,
                        background: BRAND.greenSoft,
                        borderRadius: 999,
                        padding: "4px 8px",
                      }}
                    >
                      あなた
                    </span>
                  )}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  <div style={{ fontSize: 13, color: "#64748b" }}>
                    単位
                    <div style={{ fontSize: 20, color: "#111827", fontWeight: 800 }}>
                      {player.credits}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>
                    卒業見込み
                    <div style={{ fontSize: 14, color: "#111827", fontWeight: 700 }}>
                      {player.graduationOutlook}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                  {player.creditStatus}
                </div>
                {player.strengths.length > 0 && (
                  <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
                    強み: {player.strengths.join("、")}
                  </div>
                )}
                {player.warningSigns.length > 0 && (
                  <div style={{ fontSize: 13, color: "#92400e", lineHeight: 1.5 }}>
                    注意: {player.warningSigns.join("、")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const buildShareText = useCallback((result: PlayerResult) => {
    const lines = [
      "Campus Life Game",
      `${result.playerName} の結果`,
      result.academicStatus
        ? `称号: ${result.storyAward?.title ?? result.lifeArchetype?.title ?? result.academicStatus.title}`
        : `エンディング: ${result.ending?.title ?? "キャンパスライフ完走"}`,
    ];

    if (result.rank !== undefined) {
      lines.push(`順位: ${result.rank}位`);
    }
    const score = result.score ?? result.scoreBreakdown?.total;
    if (score !== undefined) {
      lines.push(`スコア: ${score}`);
    }
    if (result.ending?.flavorText) {
      lines.push(result.ending.flavorText);
    }

    return lines.join("\n");
  }, []);

  const handleShareResult = useCallback(
    async (result: PlayerResult) => {
      const text = buildShareText(result);
      try {
        if (navigator.share) {
          await navigator.share({
            title: "Campus Life Game",
            text,
          });
          setShareStatus("共有しました");
          return;
        }
        await navigator.clipboard.writeText(text);
        setShareStatus("結果をコピーしました");
      } catch {
        try {
          await navigator.clipboard.writeText(text);
          setShareStatus("結果をコピーしました");
        } catch {
          setShareStatus("共有できませんでした");
        }
      }
    },
    [buildShareText],
  );

  const handleGenerateResultCard = useCallback(
    async (result: PlayerResult) => {
      const archetype = result.lifeArchetype ?? result.ending;
      if (!archetype) return;

      setCardGenerating(true);
      setShareStatus(null);
      try {
        const imageUrl = await generateResultCard({
          playerName: result.playerName,
          archetypeId: archetype.id,
          archetypeTitle: archetype.title,
          archetypeDescription: result.summary ?? archetype.description,
          storyTags: result.storyTags ?? [],
        });
        setCardImageUrl(imageUrl);
      } catch {
        setShareStatus("結果カードを作れませんでした");
      } finally {
        setCardGenerating(false);
      }
    },
    [],
  );

  const renderResult = () => {
    const results = gameResults;
    if (!results) return null;
    const myResult = results.find((r) => r.playerId === clientId);
    if (!myResult) return null;

    const radarData = EXPERIENCE_KEYS.map((key) => ({
      stat: EXPERIENCE_LABELS[key],
      value: myResult.experience[key],
      max: EXPERIENCE_RANGES[key].max,
    }));

    return (
      <div style={S.card} className="controller-result-card">
        <div style={S.resultEmoji}>
          {myResult.academicStatus ? "\u{1F393}" : myResult.ending?.emoji ?? "\u{1F3C1}"}
        </div>
        <div style={S.resultTitle}>
          {myResult.academicStatus
            ? myResult.storyAward?.title ?? myResult.lifeArchetype?.title ?? myResult.academicStatus.title
            : myResult.ending?.title ?? "キャンパスライフ完走"}
        </div>
        <div style={S.resultDesc}>
          {myResult.summary ?? myResult.ending?.description ?? "4年間の選択結果です。"}
        </div>
        {myResult.ending?.flavorText && (
          <div className="controller-result-flavor">
            {myResult.ending.flavorText}
          </div>
        )}
        {myResult.rank !== undefined && (
          <div style={S.resultRank}>
            {myResult.rank}位
          </div>
        )}

        <div
          style={{
            fontSize: 14,
            color: "#6b7280",
            textAlign: "center",
            marginBottom: 12,
          }}
        >
          {myResult.academicStatus
            ? `${myResult.lifeArchetype?.title} / 学業: ${myResult.academicStatus.title}`
            : `スコア: ${myResult.score ?? myResult.scoreBreakdown?.total ?? "-"}`}
        </div>

        {/* Radar chart */}
        <div style={{ width: "100%", height: 240, marginBottom: 16 }}>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
              <PolarGrid />
              <PolarAngleAxis dataKey="stat" tick={{ fontSize: 12 }} />
              <PolarRadiusAxis domain={[0, 10]} tick={false} axisLine={false} />
              <Radar
                dataKey="value"
                stroke={accentColor}
                fill={accentColor}
                fillOpacity={0.3}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Final resources */}
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          最終ステータス
        </div>
        <div style={S.statsGrid}>
          {RESOURCE_KEYS.map((key) => (
            <div key={key} style={S.statItem}>
              <span style={S.statEmoji}>{RESOURCE_EMOJI[key]}</span>
              <span style={{ fontSize: 14 }}>
                {RESOURCE_LABELS[key]}: {myResult.resources[key]}
              </span>
            </div>
          ))}
        </div>
        {myResult.scoreBreakdown && (
          <div className="controller-score-breakdown">
            {Object.entries(myResult.scoreBreakdown).map(([key, value]) => (
              <span key={key}>
                {SCORE_BREAKDOWN_LABELS[key as keyof typeof SCORE_BREAKDOWN_LABELS]}: {value}
              </span>
            ))}
          </div>
        )}
        <div style={S.shareCard}>
          <div>
            <div style={S.shareCardTitle}>結果をシェア</div>
            <div style={S.shareCardText}>
              名前、エンディング、順位、スコアを共有できます。
            </div>
            {shareStatus && (
              <div style={S.shareCardStatus}>{shareStatus}</div>
            )}
          </div>
          <button
            style={S.shareButton()}
            type="button"
            onClick={() => void handleShareResult(myResult)}
          >
            共有
          </button>
        </div>
        <button
          style={{ ...S.shareButton(cardGenerating), ...S.resultCardGenerateButton(cardGenerating) }}
          type="button"
          disabled={cardGenerating}
          onClick={() => void handleGenerateResultCard(myResult)}
        >
          {cardGenerating ? "カード生成中..." : "結果カードを作る"}
        </button>

        {cardImageUrl && (
          <div
            style={S.resultCardOverlay}
            onClick={() => setCardImageUrl(null)}
          >
            <div style={S.resultCardPreview}>
              <p style={S.resultCardPreviewText}>長押しまたはスクリーンショットで保存できます。</p>
              <img
                src={cardImageUrl}
                alt="結果カード"
                style={S.resultCardPreviewImage}
                onClick={(event) => event.stopPropagation()}
              />
              <button
                type="button"
                style={S.shareButton()}
                onClick={() => setCardImageUrl(null)}
              >
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ─── Confirmation Dialog ────────────────────────────────────
  const renderConfirmDialog = () => {
    const eventToConfirm = isBoardMode ? myBoardEvent : currentEvent;
    if (!confirmChoice || !eventToConfirm) return null;
    const choice = eventToConfirm.choices.find((c) => c.id === confirmChoice);
    if (!choice) return null;

    return (
      <div style={S.confirmOverlay} onClick={() => setConfirmChoice(null)}>
        <div style={S.confirmDialog} onClick={(e) => e.stopPropagation()}>
          <div style={S.confirmTitle}>この選択でいい?</div>
          <div style={{ fontSize: 15, marginBottom: 16 }}>{choice.label}</div>
          <ChoicePreview choice={choice} />
          <div style={{ ...S.confirmBtns, marginTop: 20 }}>
            <button
              style={S.confirmBtn(false)}
              onClick={() => setConfirmChoice(null)}
            >
              キャンセル
            </button>
            <button style={S.confirmBtn(true)} onClick={handleChoiceConfirm}>
              決定
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={S.root}>
      {/* Top bar */}
      <div style={S.topBar}>
        <div style={S.roundBadge}>
          {roundInfo.label} - Round {state.currentRound}
        </div>
        <div style={S.statusText}>
          <span style={S.statusDot(connected)} />
          {status}
        </div>
      </div>

      {/* Main content area */}
      <div style={S.section}>
        {viewState === "waiting" && renderWaiting()}
        {viewState === "rolling" && renderRolling()}
        {viewState === "dice_result" && renderDiceResult()}
        {viewState === "choosing" && renderChoosing()}
        {viewState === "animating" && renderAnimating()}
        {viewState === "revealed" && renderRevealed()}
        {viewState === "year_recap" && renderYearRecap()}
        {viewState === "result" && renderResult()}
      </div>

      {/* Stats dashboard (always shown unless result) */}
      {myPlayer && viewState !== "result" && viewState !== "year_recap" && (
        <div style={S.card}>
          <StatsDashboard player={myPlayer} />
        </div>
      )}

      {/* Confirm dialog overlay */}
      {renderConfirmDialog()}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ControllerPlayPage />
  </StrictMode>
);
