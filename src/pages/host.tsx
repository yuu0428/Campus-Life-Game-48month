import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import "../App.css";
import {
  choosePrimaryHostUrl,
  colorForPlayer,
  getRoundInfo,
  type ClientMessage,
  type Faculty,
  type GameState,
  type HostManagedPlayer,
  type ServerMessage,
  type TurnMode,
  defaultGameState,
  wsUrlFromInput,
} from "../domain/gameShared";

const FACULTY_LABELS: Record<Faculty, string> = {
  humanities: "文系",
  science: "理系",
  education: "教育",
  medical: "医療",
  arts_sports: "芸術・スポーツ",
};

const HOST_JOURNEY_STAGES = [
  { year: 1, label: "入学", note: "履修・新歓" },
  { year: 2, label: "拡張", note: "生活と関係" },
  { year: 3, label: "挑戦", note: "専門・選択" },
  { year: 4, label: "卒業", note: "進路・締切" },
];

function formatTurnGroupLabel(players: { name: string }[]) {
  if (players.length === 0) return "待機中";
  if (players.length === 1) return `${players[0].name}さんのターン`;
  if (players.length >= 3) return `全員のターン（${players.map((player) => player.name).join(" / ")}）`;
  return `${players.map((player) => `${player.name}さん`).join(" と ")}のターン`;
}

function formatTurnMode(mode: TurnMode | undefined) {
  return mode === "all" ? "全員一斉" : "2人ずつ";
}

function HostJourneyStrip({
  currentRound,
  mode,
}: {
  currentRound: number;
  mode: GameState["mode"];
}) {
  const activeRound = Math.max(1, Math.min(48, currentRound));
  const activeYear = Math.ceil(activeRound / 12);
  const roundInfo = getRoundInfo(activeRound);

  return (
    <div className="host-journey-strip" aria-label="4年間の進行">
      <div className="host-journey-strip__header">
        <span>Campus Journey</span>
        <strong>
          {mode === "life_map" ? "人生マップ" : `Month ${activeRound}/48 - ${roundInfo.label}`}
        </strong>
      </div>
      <div className="host-journey-strip__stages">
        {HOST_JOURNEY_STAGES.map((stage) => (
          <div
            key={stage.year}
            className={[
              "host-journey-stage",
              mode !== "life_map" && stage.year === activeYear ? "host-journey-stage--active" : "",
              mode !== "life_map" && stage.year < activeYear ? "host-journey-stage--past" : "",
            ].filter(Boolean).join(" ")}
          >
            <span>{stage.year}年</span>
            <strong>{stage.label}</strong>
            <small>{stage.note}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function App() {
  const [name, setName] = useState("Host");
  const [hostUrlInput, setHostUrlInput] = useState("");
  const [status, setStatus] = useState("未接続");
  const [clientId, setClientId] = useState<string | null>(null);
  const [hostUrls, setHostUrls] = useState<string[]>([]);
  const [state, setState] = useState<GameState>(defaultGameState);
  const [managedPlayers, setManagedPlayers] = useState<HostManagedPlayer[]>([]);
  const [fallbackPlayerId, setFallbackPlayerId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [isConnecting, setIsConnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);

  const primaryHostUrl = useMemo(
    () => choosePrimaryHostUrl(hostUrls),
    [hostUrls],
  );

  // Cloudflare Tunnel mode detection (master feature)
  const tunnelUrl = useMemo(
    () => hostUrls.find((u) => u.startsWith("https://")),
    [hostUrls],
  );
  const isTunnelMode = Boolean(tunnelUrl);

  const controllerEntryUrl = useMemo(() => {
    if (!primaryHostUrl) return "";
    return `${primaryHostUrl}/controller.html?host=${encodeURIComponent(primaryHostUrl)}`;
  }, [primaryHostUrl]);

  const displayUrl = useMemo(() => {
    const hostBase = primaryHostUrl || window.location.origin;
    return `${hostBase}/display.html?host=${encodeURIComponent(hostBase)}`;
  }, [primaryHostUrl]);

  const roundInfo = useMemo(
    () => getRoundInfo(state.currentRound),
    [state.currentRound],
  );

  const currentPlayer = useMemo(() => {
    if (state.players.length === 0 || state.turnOrder.length === 0) return undefined;
    const currentId = state.turnOrder[state.turnIndex % state.turnOrder.length];
    return state.players.find((p) => p.id === currentId);
  }, [state.players, state.turnIndex, state.turnOrder]);

  const visibleChoices = useMemo(() => {
    if (!state.currentEvent) return [];
    const availableIds = new Set(state.availableChoiceIds);
    if (availableIds.size === 0) return state.currentEvent.choices;
    return state.currentEvent.choices.filter((choice) => availableIds.has(choice.id));
  }, [state.availableChoiceIds, state.currentEvent]);

  const activeTurnPlayerIds = useMemo(() => {
    if (state.mode === "life_map") return [];
    if (state.activeTurnPlayerIds && state.activeTurnPlayerIds.length > 0) {
      return state.activeTurnPlayerIds;
    }
    return currentPlayer ? [currentPlayer.id] : [];
  }, [currentPlayer, state.activeTurnPlayerIds, state.mode]);

  const activeTurnPlayers = useMemo(
    () => activeTurnPlayerIds
      .map((playerId) => state.players.find((player) => player.id === playerId))
      .filter((player): player is GameState["players"][number] => Boolean(player)),
    [activeTurnPlayerIds, state.players],
  );

  const activeTurnPlayerIdSet = useMemo(
    () => new Set(activeTurnPlayerIds),
    [activeTurnPlayerIds],
  );

  const pendingTurnChoices = state.pendingTurnChoices ?? {};
  const turnMode = state.turnMode ?? "pair";
  const onlinePlayerCount = state.players.filter((player) => player.online).length;
  const boardDisplayReady =
    state.mode !== "board" ||
    (state.startedAt !== null && state.displayStartedAt === state.startedAt);
  const activeWaitingPlayers = activeTurnPlayers.filter(
    (player) => !pendingTurnChoices[player.id],
  );
  const activeSubmittedPlayers = activeTurnPlayers.filter(
    (player) => Boolean(pendingTurnChoices[player.id]),
  );

  const fallbackTargetPlayerId = state.mode === "life_map"
    ? fallbackPlayerId || state.players[0]?.id || ""
    : fallbackPlayerId || activeTurnPlayers[0]?.id || currentPlayer?.id || "";

  const selectedFallbackPlayer = state.players.find(
    (player) => player.id === fallbackTargetPlayerId,
  );

  const currentElapsedSeconds = state.startedAt
    ? (now - state.startedAt) / 1000
    : 0;
  const currentTurnSeconds = state.turnStartedAt
    ? (now - state.turnStartedAt) / 1000
    : 0;
  const recordedRoundSeconds = (state.roundDurations ?? []).reduce(
    (total, entry) => total + entry.durationSeconds,
    0,
  );

  useEffect(() => {
    shouldReconnectRef.current = true;
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const fallbackCandidates = state.mode === "life_map" ? state.players : activeTurnPlayers;
    if (fallbackPlayerId && fallbackCandidates.some((player) => player.id === fallbackPlayerId)) return;
    setFallbackPlayerId(fallbackCandidates[0]?.id ?? "");
  }, [activeTurnPlayers, fallbackPlayerId, state.mode, state.players]);

  const connectHost = useCallback(() => {
    if (
      wsRef.current
      && (
        wsRef.current.readyState === WebSocket.OPEN
        || wsRef.current.readyState === WebSocket.CONNECTING
      )
    ) {
      return;
    }
    if (!name.trim()) {
      setStatus("名前を入力してください");
      return;
    }

    const targetUrl = hostUrlInput
      ? wsUrlFromInput(hostUrlInput)
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
    if (!targetUrl) {
      setStatus("接続先URLが正しくありません");
      return;
    }

    setStatus("接続中...");
    setIsConnecting(true);
    const socket = new WebSocket(targetUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const payload: ClientMessage = {
        type: "join",
        name: name.trim(),
        role: "host",
      };
      socket.send(JSON.stringify(payload));
      setStatus("接続済み");
      setIsConnecting(false);
      sessionStorage.setItem("clg_host", hostUrlInput.trim());
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === "welcome") {
        setClientId(message.clientId);
        setHostUrls(message.urls ?? []);
      }
      if (message.type === "host_player_management") {
        setManagedPlayers(message.players);
      }
      if (message.type === "state") {
        setState(message.state);
      }
      if (message.type === "system") {
        setStatus(message.message);
      }
    };

    socket.onclose = () => {
      wsRef.current = null;
      setStatus("再接続中...");
      setClientId(null);
      setIsConnecting(false);
      if (!shouldReconnectRef.current) return;
      reconnectTimerRef.current = window.setTimeout(connectHost, 1500);
    };

    socket.onerror = () => {
      setStatus("接続に失敗しました");
      setIsConnecting(false);
    };
  }, [hostUrlInput, name]);

  const sendMessage = (payload: ClientMessage) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify(payload));
  };

  const startGame = () => {
    if (!clientId) return;
    if (state.players.length < 1) {
      setStatus("参加者が必要です");
      return;
    }
    sendMessage({ type: "start_game" });
  };

  const startLifeMapGame = () => {
    if (!clientId) return;
    if (state.players.length < 1) {
      setStatus("参加者が必要です");
      return;
    }
    sendMessage({ type: "start_life_map_game" });
  };

  const resetGame = () => {
    if (!clientId) return;
    if (!window.confirm("ゲームをリセットしてロビーに戻します。よろしいですか？")) return;
    sendMessage({ type: "reset_game" });
  };

  const endGame = () => {
    if (!clientId) return;
    if (!window.confirm("現在の状態でゲームを終了して、結果画面に進みますか？")) return;
    sendMessage({ type: "end_game" });
  };

  const removePlayer = (playerId: string, playerName: string) => {
    if (!clientId) return;
    if (!window.confirm(`${playerName} をプレイヤー一覧から削除します。よろしいですか？`)) return;
    sendMessage({ type: "remove_player", playerId });
  };

  const setFallbackMode = (enabled: boolean) => {
    sendMessage({ type: "set_fallback_mode", enabled });
  };

  const setTurnMode = (mode: TurnMode) => {
    sendMessage({ type: "set_turn_mode", mode });
  };

  const rollForPlayer = (playerId: string) => {
    if (!playerId) return;
    sendMessage({ type: "host_player_roll", playerId });
  };

  const chooseForPlayer = (playerId: string, choiceId: string) => {
    if (!playerId) return;
    sendMessage({ type: "host_player_choice", playerId, choiceId });
  };

  const continueYearRecap = () => {
    sendMessage({ type: "continue_year_recap" });
  };

  // Simultaneous mode controls (master feature)
  const forceAdvanceChoices = () => {
    sendMessage({ type: "host_force_advance_choices" });
  };

  const advanceAfterReveal = () => {
    sendMessage({ type: "host_advance_after_reveal" });
  };

  const getEventForFallbackPlayer = (playerId: string) => {
    if (state.mode === "life_map") return state.currentEvent;
    return state.activeTurnEvents?.[playerId] ?? state.currentEvent;
  };

  const getVisibleChoicesForFallbackPlayer = (playerId: string) => {
    const event = getEventForFallbackPlayer(playerId);
    if (!event) return [];
    const playerChoiceIds = state.availableChoiceIdsByPlayer?.[playerId] ?? state.availableChoiceIds;
    const availableIds = new Set(playerChoiceIds);
    if (availableIds.size === 0) return event.choices;
    return event.choices.filter((choice) => availableIds.has(choice.id));
  };

  const openDisplay = () => {
    window.open(displayUrl, "_blank");
  };

  const controllerPlayUrl = useMemo(() => {
    const hostBase = primaryHostUrl || window.location.origin;
    return `${hostBase}/controller-play.html?host=${encodeURIComponent(hostBase)}`;
  }, [primaryHostUrl]);

  const openDebugAll = () => {
    const hostBase = primaryHostUrl || window.location.origin;
    // Open display
    window.open(displayUrl, "clg-display", "width=1280,height=720");
    // Open 2 controller tabs for testing
    for (let i = 0; i < 2; i++) {
      setTimeout(() => {
        window.open(
          `${hostBase}/controller.html?host=${encodeURIComponent(hostBase)}`,
          `clg-controller-${i}`,
          "width=400,height=750"
        );
      }, 300 * (i + 1));
    }
  };

  const openOneController = () => {
    const hostBase = primaryHostUrl || window.location.origin;
    window.open(
      `${hostBase}/controller.html?host=${encodeURIComponent(hostBase)}`,
      "_blank",
      "width=400,height=750"
    );
  };

  const isInGame = state.phase !== "lobby";
  const managementRows: HostManagedPlayer[] = managedPlayers.length > 0
    ? managedPlayers
    : state.players.map((player) => ({
        id: player.id,
        name: player.name,
        faculty: player.faculty,
        passkey: "",
        online: player.online,
      }));

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-top">
          <span className="badge">Campus Life Game</span>
          <span className="status">{status}</span>
        </div>
        <h1>キャンパスライフゲーム</h1>
        <p>
          48か月のキャンパスカレンダーを進みながら、大学4年間の選択を全員で見比べるモードです。
        </p>
        <HostJourneyStrip
          currentRound={state.currentRound}
          mode={state.mode}
        />
      </header>

      {/* ── Connection Panel ──────────────────────────────────────── */}
      {!clientId && (
        <section className="panel">
          <h2>ホスト接続</h2>
          <div className="grid">
            <label>
              ホスト名
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              接続先URL（通常は空欄）
              <input
                value={hostUrlInput}
                onChange={(e) => setHostUrlInput(e.target.value)}
                placeholder="例: http://192.168.0.5:4173"
              />
            </label>
          </div>
          <div className="actions">
            <button onClick={connectHost} disabled={isConnecting || !!clientId}>
              ホストとして開始
            </button>
          </div>
        </section>
      )}

      {/* ── Connection Guide (Cloudflare Tunnel mode / Local WiFi mode) ── */}
      {clientId && (
        <section className={`panel connection-guide ${isTunnelMode ? "connection-guide--tunnel" : "connection-guide--local"}`}>
          <div className="connection-guide-header">
            <span className="connection-guide-badge">
              {isTunnelMode ? "🌐 Cloudflare Tunnelモード" : "📡 ローカルWiFiモード"}
            </span>
            <span className="connection-guide-port">ポート {window.location.port || "80"}</span>
          </div>

          {isTunnelMode ? (
            <div className="connection-guide-body">
              <p className="connection-guide-desc">
                参加者はどのネットワーク・どの場所からでも接続できます。
                URLまたはQRコードを共有してください。
              </p>
              <div className="connection-guide-url">
                <span className="connection-guide-url-label">参加者向けURL</span>
                <code>{tunnelUrl}</code>
                <button
                  className="connection-guide-copy"
                  onClick={() => navigator.clipboard.writeText(controllerEntryUrl)}
                >
                  コピー
                </button>
              </div>
            </div>
          ) : (
            <div className="connection-guide-body">
              <p className="connection-guide-desc">
                参加者と<strong>同じWiFi</strong>に繋がっている必要があります。
                会場のAPアイソレーション設定にご注意ください。
              </p>
              <details className="connection-guide-tunnel-howto">
                <summary>別ネットワークからも参加させる方法（Cloudflare Tunnel）</summary>
                <ol>
                  <li>このターミナルを閉じて、代わりに以下を実行してください：</li>
                  <li><code>npm run game:tunnel</code></li>
                  <li>（2ゲーム目以降）<code>npm run game -- --port 4174 --tunnel --name "Bチーム"</code></li>
                  <li>表示されたURLを参加者に共有すれば完了です。cloudflaredのインストールは自動で行われます。</li>
                </ol>
                <p className="connection-guide-note">
                  複数ゲームを同時進行する場合は、ゲームごとに別のターミナルで上記コマンドを実行してください。
                  それぞれ独立したURLが発行されます。
                </p>
              </details>
            </div>
          )}
        </section>
      )}

      {/* ── QR Code Panel ─────────────────────────────────────────── */}
      {clientId && controllerEntryUrl && (
        <section className={`panel ${isInGame ? "host-ops-qr-panel--compact" : ""}`}>
          <h2>参加者向けQR（Controller）</h2>
          <div className="controller-qr">
            <QRCodeCanvas value={controllerEntryUrl} size={isInGame ? 132 : 220} />
            <div className="note-urls">{controllerEntryUrl}</div>
          </div>
        </section>
      )}

      {/* ── Game Info Panel (during game) ─────────────────────────── */}
      {isInGame && (
        <section className="panel">
          <h2>ゲーム進行</h2>
          <div className="host-round-info">
            <span>
              モード: <strong>{state.mode === "life_map" ? "人生マップ" : "48か月ボード"}</strong>
            </span>
            {state.mode !== "life_map" && (
              <span>
                回答方式: <strong>{formatTurnMode(turnMode)}</strong>
              </span>
            )}
            <span>
              <strong>{roundInfo.label}</strong>
            </span>
            <span>
              {state.mode === "life_map"
                ? `Season ${state.currentRound}/16`
                : `Month ${state.currentRound}/48`}
            </span>
            <span>
              フェーズ: <strong>{state.phase}</strong>
            </span>
            <span>
              経過: <strong>{formatDuration(currentElapsedSeconds)}</strong>
            </span>
            <span>
              現ターン: <strong>{formatDuration(currentTurnSeconds)}</strong>
            </span>
            <span>
              記録済み: <strong>{formatDuration(recordedRoundSeconds)}</strong>
            </span>
            {currentPlayer && (
              <span>
                現在のプレイヤー: <strong>{currentPlayer.name}</strong>
              </span>
            )}
            {state.mode !== "life_map" && activeTurnPlayers.length > 0 && (
              <span>
                現在のターン: <strong>{formatTurnGroupLabel(activeTurnPlayers)}</strong>
              </span>
            )}
            {state.mode !== "life_map" && activeTurnPlayers.length > 1 && (
              <span>
                選択待ち:{" "}
                <strong>
                  {activeWaitingPlayers.length > 0
                    ? activeWaitingPlayers.map((player) => player.name).join(" / ")
                    : "全員選択済み"}
                </strong>
              </span>
            )}
            {state.mode !== "life_map" && activeSubmittedPlayers.length > 0 && (
              <span>
                選択済み: <strong>{activeSubmittedPlayers.map((player) => player.name).join(" / ")}</strong>
              </span>
            )}
          </div>
        </section>
      )}

      {isInGame && state.mode !== "life_map" && state.lastTurnGroupResults && state.lastTurnGroupResults.length > 0 && (
        <section className="panel">
          <h2>直前の選択</h2>
          <div className="players">
            {state.lastTurnGroupResults.map((result, index) => (
              <div key={`${result.playerId}-${result.choiceId}`} className="player-card">
                <div className="player-card__header">
                  <div className="player-name">
                    <span
                      className="player-color-dot"
                      style={{ background: colorForPlayer(index) }}
                    />
                    {result.playerName}
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {result.submittedBy === "host"
                      ? "ホスト代理"
                      : result.submittedBy === "display"
                        ? "ディスプレイ代理"
                        : "本人選択"}
                  </span>
                </div>
                <p style={{ margin: "8px 0 0", color: "var(--text-primary)", fontWeight: 700 }}>
                  {result.choiceLabel}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {state.phase === "year_recap" && state.yearRecap && (
        <section className="panel" aria-live="polite">
          <div className="host-ops-section-header">
            <div>
              <h2>{state.yearRecap.title}</h2>
              <p style={{ margin: "6px 0 0", color: "var(--text-secondary)" }}>
                {state.yearRecap.year}年目終了時点の状態です。
              </p>
            </div>
            <button onClick={continueYearRecap}>
              次の学年へ進む
            </button>
          </div>
          <div className="players" style={{ marginTop: 16 }}>
            {state.yearRecap.players.map((player, index) => (
              <div key={player.playerId} className="player-card">
                <div className="player-card__header">
                  <div className="player-name">
                    <span
                      className="player-color-dot"
                      style={{ background: colorForPlayer(index) }}
                    />
                    {player.playerName}
                  </div>
                  <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 800 }}>
                    {player.creditStatus}
                  </span>
                </div>
                <div className="player-stats">
                  <span>📚 {player.credits}単位</span>
                  <span>💰 {player.resources.money}</span>
                  <span>❤️ {player.resources.health}</span>
                  <span>🧠 {player.experience.intellect}</span>
                  <span>🤝 {player.experience.connections}</span>
                </div>
                <p style={{ margin: "10px 0 0", color: "var(--text-primary)", fontWeight: 700 }}>
                  卒業見込み: {player.graduationOutlook}
                </p>
                {player.strengths.length > 0 && (
                  <p style={{ margin: "8px 0 0", color: "var(--text-secondary)" }}>
                    強み: {player.strengths.join(" / ")}
                  </p>
                )}
                {player.warningSigns.length > 0 && (
                  <p style={{ margin: "6px 0 0", color: "var(--year-4)" }}>
                    注意: {player.warningSigns.join(" / ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Host Player Management ───────────────────────────────── */}
      <section className="panel">
        <h2>ホスト用プレイヤー管理</h2>
        <div className="host-ops-management-table">
          <div className="host-ops-management-row host-ops-management-row--head">
            <span>名前</span>
            <span>学部</span>
            <span>パスキー</span>
            <span>状態</span>
            <span>操作</span>
          </div>
          {managementRows.length === 0 && (
            <div className="placeholder">まだ参加者はいません。</div>
          )}
          {managementRows.map((player) => (
            <div
              key={player.id}
              className={`host-ops-management-row ${player.online ? "" : "host-ops-management-row--offline"}`}
            >
              <span className="host-ops-management-name">{player.name}</span>
              <span>{FACULTY_LABELS[player.faculty]}</span>
              <span className="host-ops-passkey">{player.passkey || "-"}</span>
              <span>{player.online ? "online" : "offline"}</span>
              <span>
                {clientId && (
                  <button
                    className="player-remove-button"
                    onClick={() => removePlayer(player.id, player.name)}
                  >
                    削除
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Host Fallback Controls ───────────────────────────────── */}
      {clientId && isInGame && (
        <section className="panel">
          <div className="host-ops-section-header">
            <h2>ホスト代理操作</h2>
            <label className="host-ops-toggle">
              <input
                type="checkbox"
                checked={Boolean(state.fallbackMode)}
                onChange={(event) => setFallbackMode(event.target.checked)}
              />
              フォールバックモード
            </label>
          </div>

          {/* Simultaneous mode progress controls (master feature) */}
          {state.mode === "life_map" && state.currentChoiceMode === "simultaneous" && (
            <div className="host-ops-simultaneous">
              {state.phase === "choosing" && (
                <div className="host-ops-simultaneous-status">
                  <div className="host-ops-simultaneous-count">
                    {Object.keys(state.pendingLifeChoices ?? {}).length} /{" "}
                    {state.players.filter((p) => p.online).length} 人が選択済み
                  </div>
                  <button
                    className="host-ops-force-advance"
                    onClick={forceAdvanceChoices}
                  >
                    強制進行（未選択者をスキップ）
                  </button>
                </div>
              )}
              {state.phase === "revealed" && (
                <div className="host-ops-simultaneous-status">
                  <div className="host-ops-simultaneous-count">全員の選択が開示されました</div>
                  <button
                    className="host-ops-next-event"
                    onClick={advanceAfterReveal}
                  >
                    次のイベントへ進む
                  </button>
                </div>
              )}
            </div>
          )}

          {state.fallbackMode && (
            <div className="host-ops-fallback">
              {state.mode !== "life_map" && activeTurnPlayers.length > 0 && (
                <div className="host-ops-fallback-target">
                  対象: <strong>{formatTurnGroupLabel(activeTurnPlayers)}</strong>
                  <button
                    className="ghost"
                    onClick={() => rollForPlayer(fallbackTargetPlayerId)}
                    disabled={state.phase !== "rolling" || !fallbackTargetPlayerId || !boardDisplayReady}
                  >
                    {boardDisplayReady ? "代理で月イベントを開く" : "ディスプレイ開始待ち"}
                  </button>
                </div>
              )}

              {state.mode !== "life_map" && activeTurnPlayers.length > 1 && (
                <label className="host-ops-player-select">
                  代理送信するプレイヤー
                  <select
                    value={fallbackTargetPlayerId}
                    onChange={(event) => setFallbackPlayerId(event.target.value)}
                  >
                    {activeTurnPlayers.map((player) => {
                      const alreadySubmitted = Boolean(pendingTurnChoices[player.id]);
                      return (
                        <option
                          key={player.id}
                          value={player.id}
                          disabled={alreadySubmitted}
                        >
                          {player.name}{alreadySubmitted ? "（選択済み）" : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}

              {state.mode === "life_map" && (
                <label className="host-ops-player-select">
                  代理送信するプレイヤー
                  <select
                    value={fallbackTargetPlayerId}
                    onChange={(event) => setFallbackPlayerId(event.target.value)}
                  >
                    {state.players.map((player) => {
                      const alreadySubmitted = Boolean(state.pendingLifeChoices?.[player.id]);
                      return (
                        <option
                          key={player.id}
                          value={player.id}
                          disabled={alreadySubmitted}
                        >
                          {player.name}{alreadySubmitted ? "（選択済み）" : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}

              {state.mode !== "life_map" && activeTurnPlayers.length > 0 && (
                <div className="host-ops-choice-list">
                  <div className="host-ops-event-title">ボード選択の代理送信</div>
                  {activeTurnPlayers.map((player) => {
                    const event = getEventForFallbackPlayer(player.id);
                    const choices = getVisibleChoicesForFallbackPlayer(player.id);
                    const alreadySubmitted = Boolean(pendingTurnChoices[player.id]);
                    return (
                      <div
                        key={player.id}
                        className="player-card"
                        style={{ flex: "1 1 260px", maxWidth: "100%" }}
                      >
                        <div className="player-card__header">
                          <div className="player-name">{player.name}</div>
                          <span style={{ fontSize: 12, color: alreadySubmitted ? "var(--accent)" : "var(--text-secondary)" }}>
                            {alreadySubmitted ? "選択済み" : "未選択"}
                          </span>
                        </div>
                        <div className="host-ops-event-title">
                          {event?.title ?? "イベント待ち"}
                        </div>
                        <div className="host-ops-choice-list" style={{ marginTop: 10 }}>
                          {choices.length === 0 && (
                            <div className="placeholder">選択肢はまだありません。</div>
                          )}
                          {choices.map((choice) => (
                            <button
                              key={choice.id}
                              className="host-ops-choice-button"
                              onClick={() => chooseForPlayer(player.id, choice.id)}
                              disabled={state.phase !== "choosing" || alreadySubmitted}
                            >
                              {choice.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {state.mode === "life_map" && state.currentEvent ? (
                <div className="host-ops-choice-list">
                  <div className="host-ops-event-title">{state.currentEvent.title}</div>
                  {selectedFallbackPlayer && state.pendingLifeChoices?.[selectedFallbackPlayer.id] && (
                    <div className="host-ops-choice-note">
                      {selectedFallbackPlayer.name} はこのイベントを選択済みです。
                    </div>
                  )}
                  {visibleChoices.map((choice) => {
                    const lifeChoiceAlreadySubmitted = Boolean(
                      state.mode === "life_map" &&
                        selectedFallbackPlayer &&
                        state.pendingLifeChoices?.[selectedFallbackPlayer.id],
                    );
                    return (
                      <button
                        key={choice.id}
                        className="host-ops-choice-button"
                        onClick={() => chooseForPlayer(fallbackTargetPlayerId, choice.id)}
                        disabled={
                          state.phase !== "choosing" ||
                          !fallbackTargetPlayerId ||
                          lifeChoiceAlreadySubmitted
                        }
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                state.mode === "life_map" && (
                  <div className="placeholder">現在のイベントはありません。</div>
                )
              )}
            </div>
          )}
        </section>
      )}

      {clientId && state.mode !== "life_map" && (
        <section className="panel host-turn-mode-panel">
          <div className="host-ops-section-header">
            <h2>回答方式</h2>
            {isInGame && (
              <span className="host-turn-mode-panel__hint">
                次のターングループから反映
              </span>
            )}
          </div>
          <div className="host-turn-mode-options" role="group" aria-label="回答方式">
            <button
              type="button"
              className={turnMode === "pair" ? "host-turn-mode-option host-turn-mode-option--active" : "host-turn-mode-option"}
              onClick={() => setTurnMode("pair")}
            >
              <strong>2人ずつ</strong>
              <span>対比で見せる</span>
            </button>
            <button
              type="button"
              className={turnMode === "all" ? "host-turn-mode-option host-turn-mode-option--active" : "host-turn-mode-option"}
              onClick={() => setTurnMode("all")}
            >
              <strong>全員一斉</strong>
              <span>全員の選択を並べる</span>
            </button>
          </div>
        </section>
      )}

      {/* ── Player List ───────────────────────────────────────────── */}
      <section className="panel">
        <h2>プレイヤー一覧 ({state.players.length}人)</h2>
        <div className="players">
          {state.players.length === 0 && (
            <div className="placeholder">まだ参加者はいません。</div>
          )}
          {state.players.map((player, index) => {
            const isTurn = activeTurnPlayerIdSet.has(player.id) || currentPlayer?.id === player.id;
            return (
              <div
                key={player.id}
                className={`player-card ${isTurn ? "current-turn" : ""}`}
              >
                <div className="player-card__header">
                  <div className="player-name">
                    <span
                      className="player-color-dot"
                      style={{ background: colorForPlayer(index) }}
                    />
                    {player.name}
                    {isTurn && (
                      <span style={{ fontSize: 12, color: "var(--accent)" }}>
                        {" "}
                        {pendingTurnChoices[player.id] ? "(選択済み)" : "(今の番)"}
                      </span>
                    )}
                    {!player.online && (
                      <span style={{ fontSize: 12, color: "var(--year-4)" }}>
                        {" "}
                        offline
                      </span>
                    )}
                  </div>
                  {clientId && (
                    <button
                      className="player-remove-button"
                      onClick={() => removePlayer(player.id, player.name)}
                    >
                      削除
                    </button>
                  )}
                </div>
                <div className="player-stats">
                  <span>📍 {player.position}</span>
                  <span>⏱ {player.resources.time}</span>
                  <span>💰 {player.resources.money}</span>
                  <span>❤️ {player.resources.health}</span>
                  <span>📚 {player.resources.credits}</span>
                  <span>🧠 {player.experience.intellect}</span>
                  <span>🤝 {player.experience.connections}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Actions ───────────────────────────────────────────────── */}
      {clientId && !isInGame && (
        <section className="panel">
          <h2>アクション</h2>
          <p style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 12px" }}>
            48か月ボードを開始します。参加者が入ったらここからゲームを始めます。
          </p>
          <div className="actions">
            <button
              onClick={startGame}
              disabled={onlinePlayerCount < 1}
            >
              ゲームを開始
              {onlinePlayerCount < 1 && " (オンライン参加者が必要)"}
            </button>
            <button className="ghost" onClick={openDisplay}>
              ディスプレイを開く
            </button>
          </div>
        </section>
      )}

      {clientId && isInGame && (
        <section className="panel">
          <div className="actions">
            <button className="ghost" onClick={openDisplay}>
              ディスプレイを開く
            </button>
            <button className="ghost" onClick={openOneController}>
              コントローラーを追加
            </button>
            {state.phase !== "result" && (
              <button
                onClick={endGame}
                style={{ background: "var(--year-2)", color: "#132033" }}
              >
                ゲームを終了して結果を見る
              </button>
            )}
            <button
              onClick={resetGame}
              style={{ background: "#dc2626", color: "#fff" }}
            >
              ゲームをリセット
            </button>
          </div>
        </section>
      )}

      {/* ── Debug Panel ──────────────────────────────────────────── */}
      {clientId && (
        <details className="panel host-debug-panel">
          <summary>開発用テスト</summary>
          <p style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 12px" }}>
            全画面を別ウィンドウで開きます。コントローラーで名前を入れて参加してください。
          </p>
          <div className="actions">
            <button onClick={openDebugAll} style={{ background: "var(--year-2)" }}>
              全画面を一括オープン（Display + Controller ×2）
            </button>
            <button className="ghost" onClick={openOneController}>
              コントローラーを1つ追加
            </button>
            <button className="ghost" onClick={openDisplay}>
              ディスプレイだけ開く
            </button>
            {!isInGame && (
              <button
                className="ghost"
                onClick={startLifeMapGame}
                disabled={state.players.length < 1}
              >
                人生マップ検証を開始
                {state.players.length < 1 && " (参加者が必要)"}
              </button>
            )}
          </div>
          {isInGame && controllerPlayUrl && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 13, color: "var(--muted)" }}>
                ゲーム中のコントローラー直リンク:
              </p>
              <a
                href={controllerPlayUrl}
                target="_blank"
                rel="noopener"
                style={{ fontSize: 13, wordBreak: "break-all" }}
              >
                {controllerPlayUrl}
              </a>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

export default App;
