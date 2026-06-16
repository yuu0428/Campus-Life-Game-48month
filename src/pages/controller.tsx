import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  type ClientMessage,
  type Faculty,
  type GameState,
  type ServerMessage,
  colorForPlayer,
  getRoundInfo,
  wsUrlFromInput,
  defaultGameState,
} from "../domain/gameShared";

const FACULTY_LABELS: Record<Faculty, string> = {
  humanities: "文系",
  science: "理系",
  education: "教育",
  medical: "医療",
  arts_sports: "芸術・スポーツ",
};

const FACULTY_OPTIONS = Object.entries(FACULTY_LABELS) as [Faculty, string][];
const BRAND = {
  ink: "#172313",
  muted: "#596651",
  green: "#82C045",
  greenDeep: "#315F1F",
  greenSoft: "#EDF8E6",
  line: "rgba(49, 95, 31, 0.16)",
  shadow: "0 10px 0 rgba(49, 95, 31, 0.06), 0 18px 42px rgba(23, 51, 15, 0.14)",
};

function readStoredFaculty(): Faculty {
  const storedFaculty = sessionStorage.getItem("clg_faculty");
  return FACULTY_OPTIONS.find(([value]) => value === storedFaculty)?.[0] ?? "humanities";
}

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
  },
  header: {
    background: "linear-gradient(135deg, #9cda5b, #82C045)",
    color: "#10220d",
    padding: "40px 24px 32px",
    textAlign: "center" as const,
    borderBottom: "1px solid rgba(49, 95, 31, 0.2)",
    boxShadow: "0 8px 0 rgba(49, 95, 31, 0.12)",
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 800,
    marginBottom: 8,
  },
  headerSub: {
    fontSize: 15,
    color: BRAND.greenDeep,
    fontWeight: 700,
  },
  card: {
    background: "#fff",
    boxSizing: "border-box" as const,
    borderRadius: 18,
    padding: "24px 20px",
    margin: "16px",
    border: `1px solid ${BRAND.line}`,
    boxShadow: BRAND.shadow,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 16,
    color: BRAND.greenDeep,
  },
  input: {
    width: "100%",
    padding: "14px 16px",
    fontSize: 16,
    border: `1px solid ${BRAND.line}`,
    borderRadius: 14,
    outline: "none",
    boxSizing: "border-box" as const,
    marginBottom: 12,
    background: "#fbfff7",
  },
  select: {
    width: "100%",
    padding: "14px 16px",
    fontSize: 16,
    border: `1px solid ${BRAND.line}`,
    borderRadius: 14,
    outline: "none",
    boxSizing: "border-box" as const,
    marginBottom: 12,
    background: "#fbfff7",
    color: BRAND.ink,
  },
  joinBtn: (disabled: boolean) => ({
    width: "100%",
    padding: "16px 0",
    fontSize: 16,
    fontWeight: 700,
    border: "none",
    borderRadius: 14,
    background: disabled ? "#d7decf" : "linear-gradient(180deg, #8fce50, #72ad38)",
    color: disabled ? "#89927d" : "#10220d",
    cursor: disabled ? "default" : "pointer",
    touchAction: "manipulation" as const,
    boxShadow: disabled ? "none" : "0 6px 0 #4f8429, 0 14px 22px rgba(49, 95, 31, 0.22)",
    transition: "background 0.2s, transform 0.2s",
  }),
  statusBar: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    padding: "12px 16px",
    fontSize: 14,
  },
  statusDot: (connected: boolean) => ({
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: connected ? BRAND.green : "#ef4444",
  }),
  statusText: {
    color: BRAND.muted,
  },
  playerList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  playerItem: (color: string) => ({
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 16px",
    borderRadius: 14,
    background: BRAND.greenSoft,
    border: `2px solid ${color}33`,
  }),
  playerDot: (color: string, online: boolean) => ({
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: online ? color : "#d7decf",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontWeight: 700,
    fontSize: 14,
    flexShrink: 0,
  }),
  playerName: {
    fontSize: 15,
    fontWeight: 600,
    flex: 1,
  },
  playerStatus: (online: boolean) => ({
    fontSize: 12,
    color: online ? BRAND.greenDeep : "#89927d",
    fontWeight: 500,
  }),
  emptyState: {
    textAlign: "center" as const,
    color: BRAND.muted,
    fontSize: 14,
    padding: "20px 0",
  },
  roundBadge: {
    display: "inline-block",
    padding: "6px 14px",
    borderRadius: 20,
    background: BRAND.greenSoft,
    color: BRAND.greenDeep,
    fontSize: 13,
    fontWeight: 600,
    marginTop: 12,
  },
  infoRow: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "stretch",
    gap: 12,
    fontSize: 13,
    color: BRAND.muted,
    padding: "8px 0",
    minWidth: 0,
  },
  passkeyBox: {
    marginTop: 14,
    padding: "14px 16px",
    borderRadius: 14,
    background: BRAND.greenSoft,
    border: `1px solid ${BRAND.line}`,
    textAlign: "center" as const,
  },
  passkeyValue: {
    fontSize: 28,
    fontWeight: 800,
    letterSpacing: "0.18em",
    color: BRAND.greenDeep,
  },
} as const;

// ─── Controller Lobby Page ──────────────────────────────────────
export function ControllerLobbyPage() {
  const [name, setName] = useState(sessionStorage.getItem("clg_name") ?? "");
  const [faculty, setFaculty] = useState<Faculty>(readStoredFaculty);
  const [passkey, setPasskey] = useState(
    sessionStorage.getItem("clg_passkey") ?? ""
  );
  const [issuedPasskey, setIssuedPasskey] = useState(
    sessionStorage.getItem("clg_passkey") ?? ""
  );
  const [state, setState] = useState<GameState>(defaultGameState());
  const [status, setStatus] = useState(
    name ? "接続準備中" : "名前を入力してください"
  );
  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [clientId, setClientId] = useState<string | null>(
    sessionStorage.getItem("clg_controller_id")
  );
  const wsRef = useRef<WebSocket | null>(null);

  const hostUrl = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("host") || window.location.origin;
  }, []);

  const navigateToPlay = useCallback(() => {
    window.location.href = `/controller-play.html?host=${encodeURIComponent(hostUrl)}`;
  }, [hostUrl]);

  const connect = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (!name.trim()) {
      setStatus("名前を入力してください");
      return;
    }

    const targetUrl = wsUrlFromInput(hostUrl);
    if (!targetUrl) {
      setStatus("接続先URLが不正です");
      return;
    }

    setJoining(true);
    setStatus("接続中...");
    const socket = new WebSocket(targetUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      const trimmedPasskey = passkey.trim();
      const payload: ClientMessage = {
        type: "join",
        name: name.trim(),
        role: "controller",
        clientId: sessionStorage.getItem("clg_controller_id") ?? undefined,
        faculty,
        passkey: trimmedPasskey || undefined,
      };
      socket.send(JSON.stringify(payload));
      sessionStorage.setItem("clg_name", name.trim());
      sessionStorage.setItem("clg_faculty", faculty);
      if (trimmedPasskey) {
        sessionStorage.setItem("clg_passkey", trimmedPasskey);
      }
    };

    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMessage;

      switch (msg.type) {
        case "welcome":
          setClientId(msg.clientId);
          sessionStorage.setItem("clg_controller_id", msg.clientId);
          if (msg.passkey) {
            setPasskey(msg.passkey);
            setIssuedPasskey(msg.passkey);
            sessionStorage.setItem("clg_passkey", msg.passkey);
          }
          setConnected(true);
          setJoined(true);
          setJoining(false);
          setStatus("接続済み");
          break;

        case "auth_error":
          sessionStorage.removeItem("clg_controller_id");
          setClientId(null);
          setConnected(false);
          setJoined(false);
          setJoining(false);
          setStatus(msg.message);
          wsRef.current?.close();
          break;

        case "state":
          setState(msg.state);
          break;

        case "system":
          setStatus(msg.message);
          break;

        case "navigate":
          if (msg.targetRoles.includes("controller")) {
            navigateToPlay();
          }
          break;

        case "player_removed":
          sessionStorage.removeItem("clg_controller_id");
          sessionStorage.removeItem("clg_name");
          sessionStorage.removeItem("clg_passkey");
          setClientId(null);
          setIssuedPasskey("");
          setPasskey("");
          setJoined(false);
          setConnected(false);
          setStatus("ホストがこのプレイヤーを削除しました");
          wsRef.current?.close();
          break;
      }
    };

    socket.onerror = () => {
      setStatus("接続エラー");
      setConnected(false);
      setJoining(false);
    };

    socket.onclose = () => {
      setStatus("切断されました");
      setConnected(false);
      setJoining(false);
      wsRef.current = null;
    };
  }, [faculty, hostUrl, name, navigateToPlay, passkey]);

  // Auto-connect if name is saved
  useEffect(() => {
    if (
      name &&
      (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)
    ) {
      connect();
    }
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redirect if game is already in progress
  useEffect(() => {
    if (
      state.phase !== "lobby" &&
      state.phase !== "result" &&
      joined
    ) {
      navigateToPlay();
    }
  }, [state.phase, joined, navigateToPlay]);

  const handleJoin = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      connect();
    },
    [connect]
  );

  const roundInfo = useMemo(
    () => getRoundInfo(state.currentRound),
    [state.currentRound]
  );

  const isGameInProgress =
    state.phase !== "lobby" && state.phase !== "result";

  return (
    <div style={S.root}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerTitle}>Campus Life Game</div>
        <div style={S.headerSub}>
          スマホコントローラーで参加しよう
        </div>
        {isGameInProgress && (
          <div style={S.roundBadge}>
            {roundInfo.label} - Round {state.currentRound}
          </div>
        )}
      </div>

      {/* Status */}
      <div style={S.statusBar}>
        <span style={S.statusDot(connected)} />
        <span style={S.statusText}>{status}</span>
      </div>

      {/* Join form */}
      {!joined && (
        <form onSubmit={handleJoin} style={S.card}>
          <div style={S.cardTitle}>参加する</div>
          <input
            style={S.input}
            type="text"
            placeholder="名前を入力..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={12}
            autoComplete="off"
          />
          <select
            style={S.select}
            value={faculty}
            onChange={(e) => setFaculty(e.target.value as Faculty)}
          >
            {FACULTY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            style={S.input}
            type="text"
            inputMode="numeric"
            placeholder="再接続パスキー（任意）"
            value={passkey}
            onChange={(e) => setPasskey(e.target.value)}
            maxLength={12}
            autoComplete="off"
          />
          <button
            type="submit"
            style={S.joinBtn(!name.trim() || joining)}
            disabled={!name.trim() || joining}
          >
            {joining ? "接続中..." : "参加する"}
          </button>
        </form>
      )}

      {/* Joined confirmation */}
      {joined && state.phase === "lobby" && (
        <div style={S.card}>
          <div
            style={{
              textAlign: "center",
              padding: "12px 0",
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 8 }}>{"\u2705"}</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
              参加完了!
            </div>
            <div style={{ fontSize: 14, color: BRAND.muted }}>
              ホストがゲームを開始するまで待ってください
            </div>
            {issuedPasskey && (
              <div style={S.passkeyBox}>
                <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 4 }}>
                  再接続パスキー
                </div>
                <div style={S.passkeyValue}>{issuedPasskey}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Player list */}
      <div style={S.card}>
        <div style={S.cardTitle}>
          待機中メンバー ({state.players.length}人)
        </div>
        {state.players.length === 0 ? (
          <div style={S.emptyState}>
            まだ誰も参加していません
          </div>
        ) : (
          <div style={S.playerList}>
            {state.players.map((player, i) => {
              const color = colorForPlayer(i);
              const initial = player.name.charAt(0).toUpperCase();
              return (
                <div key={player.id} style={S.playerItem(color)}>
                  <div style={S.playerDot(color, player.online)}>
                    {initial}
                  </div>
                  <div style={S.playerName}>
                    {player.name}
                    {player.id === clientId && (
                      <span style={{ color: BRAND.muted, fontWeight: 400 }}>
                        {" "}
                        (あなた)
                      </span>
                    )}
                  </div>
                  <div style={S.playerStatus(player.online)}>
                    {player.online ? "接続中" : "オフライン"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Connection info */}
      <div style={S.card}>
        <div style={S.cardTitle}>接続情報</div>
        <div style={S.infoRow}>
          <span>ホスト</span>
          <span style={{ color: BRAND.greenDeep, minWidth: 0, textAlign: "right", wordBreak: "break-all" }}>{hostUrl}</span>
        </div>
        <div style={S.infoRow}>
          <span>ID</span>
          <span style={{ color: BRAND.greenDeep, minWidth: 0, textAlign: "right", wordBreak: "break-all" }}>{clientId ?? "-"}</span>
        </div>
        <div style={S.infoRow}>
          <span>学部</span>
          <span style={{ color: BRAND.greenDeep, minWidth: 0, textAlign: "right" }}>{FACULTY_LABELS[faculty]}</span>
        </div>
        <div style={S.infoRow}>
          <span>パスキー</span>
          <span style={{ color: BRAND.greenDeep, minWidth: 0, textAlign: "right", wordBreak: "break-all" }}>{issuedPasskey || passkey || "-"}</span>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ControllerLobbyPage />
  </StrictMode>
);
