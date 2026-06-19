import express from "express";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";

import { EVENTS, RANDOM_POOL, REFLECTION_GUIDE, THRESHOLD_EVENTS, VACATION_POOL } from "./events.js";
import { BOARD, getNextSquareId, meetsCondition } from "./board.js";
import { generateResults } from "./endings.js";
import { TIMELINE_EVENTS, getPublicTimelineEvent } from "./timelineEvents.js";
import {
  buildLifeMap,
  getPublicLifeMapSquares,
  getRouteSquareId,
  getSeasonHubSquareId,
} from "./lifeMap.js";
import {
  applyTimelineChoice,
  createTimelinePlayer,
  generateTimelineResults,
  getVisibleStatEffects,
  normalizeChoiceEffects,
} from "./timelineGame.js";
import {
  getEffectBudgetTarget,
  mergeStatEffects,
  normalizeChoiceEffectOutcome,
} from "./effectBudget.js";
import { accumulateFraction } from "./statProgress.js";
import {
  INTENT_TAGS,
  deriveIntentTagsForChoice,
  deriveIntentTagsForEvent,
  deriveOutcomeTagsForChoice,
  deriveRouteTagsForChoice,
  deriveBudgetModeForChoice,
} from "./intentTags.js";
import { writeSessionLog } from "./sessionLogger.js";

// ═══════════════════════════════════════════════════════════════════
//  Constants & Helpers (mirrored from gameShared.ts)
// ═══════════════════════════════════════════════════════════════════

const PORT = Number(process.env.PORT ?? 4173);
const STATIC_DIR = process.env.STATIC_DIR ?? "dist";

// Cloudflare Tunnel などで注入される公開URL（start-game.mjs が POST /admin/tunnel-url で設定）
let publicTunnelUrl = process.env.PUBLIC_URL ?? null;

const RESOURCE_KEYS = ["time", "money", "credits", "health"];
const EXPERIENCE_KEYS = ["intellect", "connections", "work_tolerance", "action_power", "romance_exp"];
const STAT_LABELS = {
  time: "時間",
  money: "お金",
  credits: "単位",
  health: "体力",
  intellect: "知性",
  connections: "人間関係",
  work_tolerance: "働く力",
  action_power: "行動力",
  romance_exp: "恋愛経験",
};
const RECOVERY_COST_PRIORITY = {
  money: ["time", "health", "connections", "work_tolerance", "action_power", "intellect", "romance_exp", "credits"],
  time: ["money", "health", "connections", "work_tolerance", "action_power", "intellect", "romance_exp", "credits"],
  health: ["time", "money", "connections", "work_tolerance", "action_power", "intellect", "romance_exp", "credits"],
  credits: ["time", "health", "money", "connections", "work_tolerance", "action_power", "intellect", "romance_exp"],
  default: ["time", "health", "money", "connections", "work_tolerance", "action_power", "intellect", "romance_exp", "credits"],
};

const RESOURCE_RANGES = {
  time:    { min: 0,  max: 12 },
  money:   { min: -5, max: 99 },
  credits: { min: 0,  max: 130 },
  health:  { min: 0,  max: 12 },
};

const EXPERIENCE_RANGES = {
  intellect:       { min: 0, max: 10 },
  connections:     { min: 0, max: 10 },
  work_tolerance:  { min: 0, max: 10 },
  action_power:    { min: 0, max: 10 },
  romance_exp:     { min: 0, max: 10 },
};

const BOARD_FINAL_ROUND = 48;
const TURN_GROUP_SIZE = 2;
const TURN_MODES = new Set(["pair", "all"]);
const TURN_GROUP_RESULT_MS = Number(process.env.TURN_GROUP_RESULT_MS ?? 3000);
const SEMESTER_CREDIT_BONUS = 10;
// Year 4 only: pay the final-semester credit bonus before the graduation
// judgment (event 47, round 47) instead of at the very end (round 48).
const FINAL_SEMESTER_BONUS_ROUND = 46;
const CREDIT_AUDIT_ROUNDS = new Set([6, 12, 18, 24, 30, 36, 42, 48]);
const CREDIT_AUDIT_GRACE_GAP = 3;
const CREDIT_AUDIT_MAX_BONUS = 6;
const YEAR_END_CREDIT_AUDIT_MAX_BONUS = 8;
const FINAL_CREDIT_AUDIT_CHANCE_FLOOR = 119;
const FINAL_CREDIT_AUDIT_FLOOR = 120;
const FINAL_CREDIT_AUDIT_CHANCE = 0.35;
const CREDIT_RECOVERY_EVENT_MIN_ROUND = 14;
const CREDIT_RECOVERY_EVENT_GAP = 18;
// Natural (non-cheating) breakup triggers.
const BREAKUP_MONEY_STREAK = 5;   // money < 0 for this many consecutive rounds
const BREAKUP_CREDIT_GAP = 42;    // credits this far behind the expected pace
const YEAR_RECAP_ROUNDS = new Set([12, 24, 36]);
const RECOVERY_COOLDOWN_ROUNDS = 3;
const RECOVERY_MAX_PER_STAT_PER_YEAR = 1;
const CREDIT_CHECKPOINTS = {
  12: 30,  // End of Year 1
  24: 62,  // End of Year 2
  36: 96,  // End of Year 3
  48: 124, // Graduation
};
const NEGATIVE_RECOVERY_TRIGGER = {
  money: -1,
  default: -1,
};
const BIKE_LIGHT_STOP_CHANCE = 0.04;

const SEASON_LABELS = { spring: "春", summer: "夏", autumn: "秋", winter: "冬" };
const ACADEMIC_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const FACULTIES = new Set(["humanities", "science", "education", "medical", "arts_sports"]);
const VACATION_MONTHS = new Map([
  [5, "summer"],
  [11, "spring"],
  [12, "spring"],
  [17, "summer"],
  [23, "spring"],
  [24, "spring"],
  [29, "summer"],
  [35, "spring"],
]);
const RANDOM_EVENT_MONTHS = new Set([15, 18, 26, 40]);
const LIFE_MAP = buildLifeMap(TIMELINE_EVENTS);
const PUBLIC_LIFE_MAP_SQUARES = getPublicLifeMapSquares(LIFE_MAP);

function clampResource(key, value) {
  const r = RESOURCE_RANGES[key];
  return Math.max(r.min, Math.min(r.max, Math.round(value)));
}

function clampExperience(key, value) {
  const r = EXPERIENCE_RANGES[key];
  return Math.max(r.min, Math.min(r.max, Math.round(value)));
}

// Slow-growth bonuses (living alone, faculty perks) add fractional amounts.
// Accumulate them in a hidden ledger and only ever apply whole points, so the
// visible stat stays an integer (issue #2: 行動力 must never become 6.3).
function gainExperienceFraction(player, key, amount) {
  if (!player.experienceProgress) player.experienceProgress = {};
  const { whole, remainder } = accumulateFraction(player.experienceProgress[key] ?? 0, amount);
  player.experienceProgress[key] = remainder;
  if (whole !== 0) {
    player.experience[key] = clampExperience(key, player.experience[key] + whole);
  }
}

function stableUnitInterval(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

function canApplyFinalCreditAudit(player) {
  const credits = player.resources.credits;
  if (credits >= FINAL_CREDIT_AUDIT_FLOOR) return true;
  if (credits !== FINAL_CREDIT_AUDIT_CHANCE_FLOOR) return false;
  const auditKey = `${sessionId ?? "local"}:${player.id}:${player.name}:final-credit-audit`;
  return stableUnitInterval(auditKey) < FINAL_CREDIT_AUDIT_CHANCE;
}

function getPlayerStatValue(player, key) {
  if (RESOURCE_KEYS.includes(key)) return player.resources[key];
  if (EXPERIENCE_KEYS.includes(key)) return player.experience[key];
  return undefined;
}

function findNegativeStat(player) {
  for (const key of [...RESOURCE_KEYS, ...EXPERIENCE_KEYS]) {
    const value = getPlayerStatValue(player, key);
    if (typeof value === "number" && value < 0) {
      return { key, value };
    }
  }
  return null;
}

function chooseRecoveryCostStat(player, negativeKey) {
  const priorities = RECOVERY_COST_PRIORITY[negativeKey] ?? RECOVERY_COST_PRIORITY.default;
  return priorities.find((key) => key !== negativeKey && (getPlayerStatValue(player, key) ?? 0) > 0)
    ?? priorities.find((key) => key !== negativeKey)
    ?? "time";
}

function diceToSquares(roll) {
  return roll;
}

function monthToSeason(month) {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

function getRoundInfo(round) {
  const clamped = Math.max(1, Math.min(BOARD_FINAL_ROUND, round));
  const year = Math.ceil(clamped / 12);
  const month = ACADEMIC_MONTHS[(clamped - 1) % 12];
  const season = monthToSeason(month);
  return {
    round: clamped,
    year,
    season,
    label: `${year}年 ${month}月（${SEASON_LABELS[season]}）`,
  };
}

function expectedCreditsForRound(round) {
  return CREDIT_CHECKPOINTS[round]
    ?? Math.round((Math.max(1, Math.min(BOARD_FINAL_ROUND, round)) / BOARD_FINAL_ROUND) * CREDIT_CHECKPOINTS[48]);
}

function defaultResources() {
  return { time: 10, money: 3, credits: 0, health: 10 };
}

function defaultExperience() {
  return { intellect: 1, connections: 1, work_tolerance: 0, action_power: 1, romance_exp: 0 };
}

function defaultPathScores() {
  return Object.fromEntries(INTENT_TAGS.map((tag) => [tag, 0]));
}

function defaultFlags() {
  return {
    housing: "family",
    living_alone: false,
    has_partner: false,
    ex_partner_count: 0,
    has_license: false,
    studying_abroad: false,
    on_leave: false,
    in_seminar: false,
    teaching_cert: false,
    cheating: false,
    cheated_before: false,
    career_path: null,
    career_failed: false,
    career_unsettled: false,
    job_offer: false,
    grad_admitted: false,
    startup_traction: false,
    job_hunt_failed: false,
    grad_exam_failed: false,
    startup_failed: false,
    startup_closed: false,
    romance_committed: false,
    breakup: false,
    romance_restarted: false,
    club_type: null,
    job_type: null,
  };
}

function defaultGameState() {
  return {
    mode: "board",
    phase: "lobby",
    currentRound: 1,
    players: [],
    turnIndex: 0,
    turnOrder: [],
    completedTurns: [],
    lastRoll: null,
    currentEvent: null,
    availableChoiceIds: [],
    lastChoiceResult: null,
    activeTurnPlayerIds: [],
    activeTurnEvents: {},
    availableChoiceIdsByPlayer: {},
    pendingTurnChoices: {},
    pendingRecoveryOriginalEvents: {},
    lastTurnGroupResults: [],
    yearRecap: null,
    fallbackMode: false,
    turnMode: "pair",
    startedAt: null,
    displayStartedAt: null,
    turnStartedAt: null,
    roundDurations: [],
    /** Track which players already had a threshold event this round */
    thresholdFiredThisRound: new Set(),
    currentSeasonIndex: 0,
    lifePlayers: [],
    lifeMapSquares: [],
    lifePlayerPositions: {},
    lifePlayerRoutes: {},
    pendingLifeChoices: {},
    pendingLifeResults: {},
    currentChoiceMode: "sequential",
    choicePhilosophy: "equal",
    finalResults: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Server Setup
// ═══════════════════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** @type {string | null} */
let hostId = null;
let state = defaultGameState();
let sessionId = null;
let sessionStartedAtIso = null;

/** @type {Map<import('ws').WebSocket, {id: string|null, role: string|null, name: string|null}>} */
const sockets = new Map();
/** @type {Map<string, {name: string, passkey: string}>} */
const playerAuth = new Map();

// ═══════════════════════════════════════════════════════════════════
//  Network Helpers
// ═══════════════════════════════════════════════════════════════════

function getHostUrls() {
  const urls = new Set();
  if (publicTunnelUrl) {
    urls.add(publicTunnelUrl);
  }
  urls.add(`http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  Object.values(nets).forEach((entries) => {
    entries?.forEach((entry) => {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${PORT}`);
      }
    });
  });
  // トンネルURLが設定されている場合は先頭に追加（ホストUIで優先表示される）
  if (publicTunnelUrl) urls.add(publicTunnelUrl);
  return Array.from(urls);
}

function broadcastHostUrls() {
  const urls = getHostUrls();
  for (const [socket, client] of sockets.entries()) {
    if (socket.readyState !== socket.OPEN || client.role !== "host" || !client.id) continue;
    sendTo(socket, { type: "welcome", clientId: client.id, hostId, urls });
  }
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const socket of sockets.keys()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  }
}

function broadcastState() {
  broadcast({ type: "state", state });
}

function sendToController(playerId, payload) {
  for (const [socket, client] of sockets.entries()) {
    if (socket.readyState !== socket.OPEN) continue;
    if (client.role !== "controller" || client.id !== playerId) continue;
    sendTo(socket, payload);
  }
}

function broadcastNavigate(url, targetRoles) {
  const message = JSON.stringify({ type: "navigate", url, targetRoles });
  for (const [socket, client] of sockets.entries()) {
    if (socket.readyState !== socket.OPEN) continue;
    if (!targetRoles.includes(client.role)) continue;
    socket.send(message);
  }
}

function sendTo(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendHostPlayerManagement() {
  const players = state.players.map((player) => ({
    id: player.id,
    name: player.name,
    faculty: player.faculty,
    passkey: playerAuth.get(player.id)?.passkey ?? "",
    online: player.online,
  }));

  for (const [socket, client] of sockets.entries()) {
    if (socket.readyState !== socket.OPEN || client.role !== "host") continue;
    sendTo(socket, { type: "host_player_management", players });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Player Management
// ═══════════════════════════════════════════════════════════════════

function generatePasskey() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function normalizeFaculty(value) {
  return FACULTIES.has(value) ? value : "humanities";
}

function createPlayer(clientId, name, faculty) {
  const player = {
    id: clientId,
    name,
    faculty,
    resources: defaultResources(),
    experience: defaultExperience(),
    experienceProgress: {},
    negativeMoneyStreak: 0,
    flags: defaultFlags(),
    position: "1",
    lastRoll: undefined,
    online: true,
    badLuckPoints: 0,
    flagHistory: [],
    choiceHistory: [],
    pathScores: defaultPathScores(),
    yearAnchors: [],
    milestones: [],
    recoveryCooldowns: {},
    recoveryUsesByYear: {},
  };
  state.players.push(player);
  return player;
}

function addOrRestorePlayer(clientId, name, faculty = "humanities") {
  const existingIndex = state.players.findIndex((p) => p.id === clientId);
  if (existingIndex !== -1) {
    state.players[existingIndex] = {
      ...state.players[existingIndex],
      name,
      faculty,
      online: true,
    };
    return clientId;
  }

  createPlayer(clientId, name, faculty);
  return clientId;
}

function registerOrRestorePlayer({ requestedId, name, passkey, faculty }) {
  const normalizedFaculty = normalizeFaculty(faculty);
  if (requestedId) {
    const existing = state.players.find((p) => p.id === requestedId);
    if (existing) {
      const auth = playerAuth.get(requestedId);
      if (auth?.passkey && auth.passkey !== passkey) {
        return { error: "パスキーが一致しません。" };
      }
      addOrRestorePlayer(requestedId, name, existing.faculty ?? normalizedFaculty);
      if (!auth) {
        playerAuth.set(requestedId, { name, passkey: generatePasskey() });
      } else {
        playerAuth.set(requestedId, { ...auth, name });
      }
      return { clientId: requestedId, passkey: playerAuth.get(requestedId).passkey };
    }
  }

  if (passkey) {
    const matched = state.players.find((player) => {
      const auth = playerAuth.get(player.id);
      return player.name === name && auth?.passkey === passkey;
    });
    if (matched) {
      addOrRestorePlayer(matched.id, name, matched.faculty);
      return { clientId: matched.id, passkey };
    }

    if (state.players.some((player) => player.name === name)) {
      return { error: "名前またはパスキーが一致しません。" };
    }
  }

  const clientId = randomUUID();
  const issuedPasskey = generatePasskey();
  createPlayer(clientId, name, normalizedFaculty);
  playerAuth.set(clientId, { name, passkey: issuedPasskey });
  return { clientId, passkey: issuedPasskey };
}

function addPlayerToActiveGame(clientId) {
  const player = state.players.find((p) => p.id === clientId);
  if (!player || state.phase === "lobby" || state.phase === "result") return;

  if (!state.turnOrder.includes(clientId)) {
    state.turnOrder.push(clientId);
  }

  if (state.mode !== "life_map") {
    if (
      state.phase === "rolling"
      && state.activeTurnPlayerIds.length === 0
      && !state.completedTurns.includes(clientId)
    ) {
      prepareNextBoardTurnGroup();
    }
    return;
  }

  if (!state.lifePlayers.some((lifePlayer) => lifePlayer.id === clientId)) {
    state.lifePlayers.push(createTimelinePlayer(player.id, player.name));
  }
  if (state.lifeMapSquares.length === 0) {
    state.lifeMapSquares = PUBLIC_LIFE_MAP_SQUARES;
  }

  const currentTimelineEvent = getCurrentTimelineEvent();
  const joinSquareId = currentTimelineEvent
    ? getSeasonHubSquareId(currentTimelineEvent)
    : LIFE_MAP.startSquareId;

  const existingPosition = state.lifePlayerPositions[clientId];
  state.lifePlayerPositions = {
    ...state.lifePlayerPositions,
    [clientId]: existingPosition ?? joinSquareId,
  };
  state.lifePlayerRoutes = {
    ...state.lifePlayerRoutes,
    [clientId]: state.lifePlayerRoutes[clientId] ?? [],
  };
}

function markOffline(clientId) {
  const index = state.players.findIndex((p) => p.id === clientId);
  if (index === -1) return;
  state.players[index] = { ...state.players[index], online: false };
}

function removePlayer(playerId) {
  const removedPlayer = state.players.find((p) => p.id === playerId);
  if (!removedPlayer) return null;

  for (const [socket, client] of sockets.entries()) {
    if (client.role !== "controller" || client.id !== playerId) continue;
    sendTo(socket, {
      type: "player_removed",
      playerId,
      playerName: removedPlayer.name,
    });
  }

  state.players = state.players.filter((p) => p.id !== playerId);
  playerAuth.delete(playerId);
  state.turnOrder = state.turnOrder.filter((id) => id !== playerId);
  state.completedTurns = state.completedTurns.filter((id) => id !== playerId);
  state.activeTurnPlayerIds = state.activeTurnPlayerIds.filter((id) => id !== playerId);
  state.thresholdFiredThisRound.delete(playerId);
  state.lifePlayers = state.lifePlayers.filter((p) => p.id !== playerId);

  const pendingLifeChoices = { ...state.pendingLifeChoices };
  const pendingTurnChoices = { ...state.pendingTurnChoices };
  const activeTurnEvents = { ...state.activeTurnEvents };
  const availableChoiceIdsByPlayer = { ...state.availableChoiceIdsByPlayer };
  const pendingRecoveryOriginalEvents = { ...state.pendingRecoveryOriginalEvents };
  const lifePlayerPositions = { ...state.lifePlayerPositions };
  const lifePlayerRoutes = { ...state.lifePlayerRoutes };
  delete pendingLifeChoices[playerId];
  delete pendingTurnChoices[playerId];
  delete activeTurnEvents[playerId];
  delete availableChoiceIdsByPlayer[playerId];
  delete pendingRecoveryOriginalEvents[playerId];
  delete lifePlayerPositions[playerId];
  delete lifePlayerRoutes[playerId];
  state.pendingLifeChoices = pendingLifeChoices;
  state.pendingTurnChoices = pendingTurnChoices;
  state.activeTurnEvents = activeTurnEvents;
  state.availableChoiceIdsByPlayer = availableChoiceIdsByPlayer;
  state.pendingRecoveryOriginalEvents = pendingRecoveryOriginalEvents;
  state.lifePlayerPositions = lifePlayerPositions;
  state.lifePlayerRoutes = lifePlayerRoutes;

  if (state.players.length === 0) {
    state = defaultGameState();
    return removedPlayer;
  }

  if (state.turnOrder.length === 0) {
    state.phase = "lobby";
    state.turnIndex = 0;
    state.currentEvent = null;
    state.availableChoiceIds = [];
    state.activeTurnPlayerIds = [];
    state.activeTurnEvents = {};
    state.availableChoiceIdsByPlayer = {};
    state.pendingTurnChoices = {};
    state.pendingRecoveryOriginalEvents = {};
    state.lastTurnGroupResults = [];
    state.lastChoiceResult = null;
    return removedPlayer;
  }

  if (state.turnIndex >= state.turnOrder.length) {
    state.turnIndex = 0;
  }

  if (state.mode !== "life_map") {
    if (state.phase === "choosing" || state.phase === "rolling") {
      if (state.activeTurnPlayerIds.length === 0) {
        prepareNextBoardTurnGroup();
      } else if (state.phase === "choosing") {
        tryCompleteBoardTurnGroup();
      } else {
        broadcastState();
      }
    }
  } else {
    tryAdvanceTimelineEvent();
  }

  return removedPlayer;
}

// ═══════════════════════════════════════════════════════════════════
//  Game Logic Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the event ID from the board square at a given position.
 * Events in EVENTS are keyed by position ID (e.g. "1", "9A-1").
 */
function getEventForPosition(positionId, player = getCurrentPlayer()) {
  const month = Number(positionId);
  if (VACATION_MONTHS.has(month)) {
    return buildVacationEvent(month, player) ?? EVENTS[positionId] ?? null;
  }
  if (RANDOM_EVENT_MONTHS.has(month)) {
    if (player) {
      return pickRandomPoolEvent(player) ?? EVENTS[positionId] ?? null;
    }
  }
  // Events are keyed by the square ID directly
  return EVENTS[positionId] ?? null;
}

function eventListFromPool(pool) {
  return Array.isArray(pool) ? pool : Object.values(pool ?? {});
}

function choiceFromPoolItem(item, index) {
  if (item.choices?.length) {
    return item.choices.map((choice, choiceIndex) => ({
      ...choice,
      id: `${item.id ?? `pool_${index}`}:${choice.id ?? choiceIndex}`,
      label: item.title ?? choice.label,
      description: choice.description ?? item.description,
      storyTags: choice.storyTags ?? item.storyTags,
      polarity: choice.polarity ?? item.polarity,
      badLuckDelta: choice.badLuckDelta ?? item.badLuckDelta,
    }));
  }
  return [{
    id: item.id ?? `pool_${index}`,
    label: item.title ?? `Route ${index + 1}`,
    description: item.description,
    effects: item.effects ?? {},
    flagEffects: item.flagEffects ?? item.setFlags,
    condition: item.condition,
    tone: item.tone,
    preview: item.preview,
    storyTags: item.storyTags,
    polarity: item.polarity,
    badLuckDelta: item.badLuckDelta,
  }];
}

function buildVacationEvent(month, player = getCurrentPlayer()) {
  const vacationType = VACATION_MONTHS.get(month);
  if (!player || !vacationType) return null;

  const routeChoices = eventListFromPool(VACATION_POOL)
    .filter((item) => {
      const contextualPlayer = { ...player, currentRound: state.currentRound };
      const itemType = item.vacationType ?? item.type ?? item.season;
      if (itemType && itemType !== vacationType && itemType !== "both") return false;
      if (item.condition && !meetsCondition(contextualPlayer, item.condition)) return false;
      return true;
    })
    .flatMap(choiceFromPoolItem)
    .filter((choice) => !choice.condition || meetsCondition({ ...player, currentRound: state.currentRound }, choice.condition));

  if (routeChoices.length === 0) return null;

  return {
    id: String(month),
    title: vacationType === "summer" ? "夏休みの過ごし方" : "春休みの過ごし方",
    description: "春休みや夏休みの過ごし方で、次の学期の準備が変わる。",
    year: Math.ceil(month / 12),
    category: "vacation",
    pool: "vacation",
    vacationType,
    choices: routeChoices,
  };
}

function pickWeighted(items, getWeight) {
  const total = items.reduce((sum, item) => sum + Math.max(0, getWeight(item)), 0);
  if (total <= 0) return items[0] ?? null;
  let cursor = Math.random() * total;
  for (const item of items) {
    cursor -= Math.max(0, getWeight(item));
    if (cursor <= 0) return item;
  }
  return items[items.length - 1] ?? null;
}

function pickRandomPoolEvent(player) {
  const contextualPlayer = { ...player, currentRound: state.currentRound };
  const available = eventListFromPool(RANDOM_POOL).filter((event) => {
    if (event.condition && !meetsCondition(contextualPlayer, event.condition)) return false;
    return true;
  });
  const selected = pickWeighted(available, (event) => {
    const baseWeight = Number(event.weight ?? 1);
    const eventTags = deriveIntentTagsForEvent(event);
    const pathScores = { ...defaultPathScores(), ...(player.pathScores ?? {}) };
    const affinity = eventTags.reduce((sum, tag) => sum + (pathScores[tag] ?? 0), 0);
    const lowExposureBonus = eventTags.some((tag) => (pathScores[tag] ?? 0) <= 1) ? 1.25 : 1;
    const pathBonus = 1 + Math.min(0.8, affinity * 0.04);
    if (event.polarity === "positive") {
      return baseWeight * pathBonus * lowExposureBonus * (1 + 0.3 * Math.max(0, player.badLuckPoints ?? 0));
    }
    return baseWeight * pathBonus * lowExposureBonus;
  });
  return selected ? { ...selected, pool: "random" } : null;
}

/**
 * Check threshold events in priority order.
 * Returns an overriding event or null.
 */
function checkThresholdEvents(player) {
  // One threshold event per player per round max
  if (state.thresholdFiredThisRound.has(player.id)) {
    return null;
  }

  const res = player.resources;

  let result = null;
  const expectedCredits = expectedCreditsForRound(state.currentRound);

  // 0.5. A rare leave-of-absence branch when health has stayed low.
  if (!player.flags.on_leave && state.currentRound >= 13 && res.health <= 4 && Math.random() < 0.04) {
    result = THRESHOLD_EVENTS["休学相談"];
  }
  // 1. time < 4 AND random < 0.5 -> emergency hospitalization
  else if (res.time < 4 && Math.random() < 0.5) {
    result = THRESHOLD_EVENTS["緊急入院"];
  }
  // 1.5 credits are critically behind the graduation pace -> formal academic advising
  else if (
    state.currentRound >= CREDIT_RECOVERY_EVENT_MIN_ROUND
    && res.credits < expectedCredits - CREDIT_RECOVERY_EVENT_GAP
  ) {
    result = THRESHOLD_EVENTS["単位回収"];
  }
  // 2. time < 6 AND random < 0.2 -> ryuunen crisis
  else if (res.time < 6 && Math.random() < 0.2) {
    result = THRESHOLD_EVENTS["留年危機"];
  }
  // 3. money <= -3 -> broke (guaranteed)
  else if (res.money <= -3) {
    result = THRESHOLD_EVENTS["金欠"];
  }
  // 4. no license (bicycle rider) AND random < 4% -> bike light stop
  else if (!player.flags.has_license && Math.random() < BIKE_LIGHT_STOP_CHANCE) {
    result = THRESHOLD_EVENTS["無灯火運転"];
  }

  if (result) {
    state.thresholdFiredThisRound.add(player.id);
    return { ...result, effectBudgetTarget: result.effectBudgetTarget ?? 5 };
  }
  return null;
}

/**
 * Resolve the event choices considering conditional variants.
 * Returns the appropriate choices array for the player.
 */
function resolveEventChoices(event, player) {
  const contextualPlayer = { ...player, currentRound: state.currentRound };
  if (event.conditionalVariants) {
    for (const variant of event.conditionalVariants) {
      if (meetsCondition(contextualPlayer, variant.condition)) {
        const choices = variant.choices ?? event.choices;
        return {
          ...event,
          title: variant.title ?? event.title,
          description: variant.description ?? event.description,
          choices: choices.map((choice) => ({
            ...choice,
            effectBudgetTarget: choice.effectBudgetTarget ?? 5,
          })),
          effectBudgetTarget: 5,
        };
      }
    }
  }
  return event;
}

/**
 * Filter choices by their conditions against the player.
 */
function filterAvailableChoices(choices, player) {
  const contextualPlayer = { ...player, currentRound: state.currentRound };
  return choices.filter((choice) => {
    if (!choice.condition) return true;
    return meetsCondition(contextualPlayer, choice.condition);
  });
}

function buildNegativeRecoveryEvent(player) {
  const negativeStat = findNegativeStat(player);
  if (!negativeStat) return null;
  const triggerValue = NEGATIVE_RECOVERY_TRIGGER[negativeStat.key] ?? NEGATIVE_RECOVERY_TRIGGER.default;
  if (negativeStat.value > triggerValue) return null;
  if (!canShowRecoveryForStat(player, negativeStat.key)) return null;

  const costKey = chooseRecoveryCostStat(player, negativeStat.key);
  const recoveryAmount = Math.abs(negativeStat.value);
  const recoveryLabel = STAT_LABELS[negativeStat.key] ?? negativeStat.key;
  const costLabel = STAT_LABELS[costKey] ?? costKey;

  return {
    id: `negative_recovery:${negativeStat.key}`,
    title: `${recoveryLabel}の立て直し`,
    description: `${recoveryLabel}がマイナスになっている。${costLabel}を使って、いったん0まで戻せる。`,
    year: Math.ceil(state.currentRound / 12),
    category: "救済",
    choices: [
      {
        id: `negative_recovery:${negativeStat.key}:accept`,
        label: `${costLabel}を使って${recoveryLabel}を0に戻す`,
        effects: {
          [negativeStat.key]: recoveryAmount,
          [costKey]: -recoveryAmount,
        },
        preserveEffects: true,
        polarity: "mixed",
        intentTags: ["rest"],
      },
      {
        id: "negative_recovery:skip",
        label: "救済を受けず、本来のイベントへ進む",
        effects: {},
        preserveEffects: true,
        skipRecovery: true,
        polarity: "mixed",
        intentTags: ["risk"],
      },
    ],
  };
}

function effectBudgetTargetFor(event, choice) {
  return getEffectBudgetTarget({
    choice,
    event,
    isThresholdEvent: event.effectBudgetTarget === 5,
    targetTotal: choice.effectBudgetTarget ?? event.effectBudgetTarget,
  });
}

/**
 * Apply stat effects to a player. Mutates the player object.
 * Returns the actual effects applied (after clamping).
 */
function applyEffects(player, effects) {
  if (!effects) return;
  for (const key of RESOURCE_KEYS) {
    if (effects[key] !== undefined) {
      player.resources[key] = clampResource(key, player.resources[key] + effects[key]);
    }
  }
  for (const key of EXPERIENCE_KEYS) {
    if (effects[key] !== undefined) {
      player.experience[key] = clampExperience(key, player.experience[key] + effects[key]);
    }
  }
}

/**
 * Apply flag effects to a player. Mutates the player object.
 * Tracks new true flags in flagHistory.
 */
function applyFlagEffects(player, flagEffects) {
  if (!flagEffects) return undefined;
  const normalizedFlagEffects = { ...flagEffects };
  if (normalizedFlagEffects.housing) {
    normalizedFlagEffects.living_alone = normalizedFlagEffects.housing === "alone";
  } else if (normalizedFlagEffects.living_alone === true) {
    normalizedFlagEffects.housing = "alone";
  } else if (normalizedFlagEffects.living_alone === false && !player.flags.housing) {
    normalizedFlagEffects.housing = "family";
  }
  if (normalizedFlagEffects.has_partner === true) {
    if (!player.flags.has_partner && player.flags.breakup) {
      normalizedFlagEffects.romance_restarted = true;
    }
    normalizedFlagEffects.cheating = false;
  }
  if (normalizedFlagEffects.has_partner === false) {
    if (player.flags.has_partner) {
      const currentExCount = Number(player.flags.ex_partner_count ?? 0);
      normalizedFlagEffects.ex_partner_count = Math.max(
        currentExCount + 1,
        Number(normalizedFlagEffects.ex_partner_count ?? currentExCount + 1),
      );
    }
    normalizedFlagEffects.cheating = false;
  }

  for (const [key, value] of Object.entries(normalizedFlagEffects)) {
    player.flags[key] = value;
    // Track truthy flags in history
    if (value && value !== "none" && !player.flagHistory.includes(key)) {
      player.flagHistory.push(key);
    }
  }
  return Object.keys(normalizedFlagEffects).length > 0 ? normalizedFlagEffects : undefined;
}

/**
 * Apply per-round flag effects at the start of each round.
 */
function applyPerRoundFlagEffects(player) {
  if (state.currentRound % 3 !== 0) return;

  if (player.flags.living_alone) {
    player.resources.money = clampResource("money", player.resources.money - 1);
    gainExperienceFraction(player, "action_power", 0.3);
  }
  if (player.flags.has_partner) {
    player.resources.time = clampResource("time", player.resources.time - 1);
    player.resources.health = clampResource("health", player.resources.health + 1);
  }
  if (player.flags.teaching_cert) {
    player.resources.time = clampResource("time", player.resources.time - 1);
  }
  if (player.faculty === "medical") {
    player.resources.health = clampResource("health", player.resources.health - 1);
    gainExperienceFraction(player, "intellect", 0.5);
  }
  if (player.faculty === "science") {
    gainExperienceFraction(player, "intellect", 0.3);
  }
}

// Non-cheating breakup: the partner leaves due to life falling apart.
// Mirrors the flag bookkeeping in applyFlagEffects (ex_partner_count++, breakup).
function triggerNaturalBreakup(player, reason) {
  if (!player.flags.has_partner) return false;
  player.flags.ex_partner_count = Number(player.flags.ex_partner_count ?? 0) + 1;
  player.flags.has_partner = false;
  player.flags.cheating = false;
  player.flags.breakup = true;
  if (!player.flagHistory.includes("breakup")) player.flagHistory.push("breakup");
  broadcast({ type: "system", message: `💔 ${player.name} は${reason}、恋人と別れてしまいました…` });
  broadcast({
    type: "relationship_news",
    playerName: player.name,
    icon: "💔",
    text: `${reason}、恋人と別れてしまった…`,
    tone: "sad",
  });
  return true;
}

// Per-round natural-breakup checks (money trouble streak / severe credit shortfall).
function applyRelationshipStrain(player, round) {
  if (player.resources.money < 0) {
    player.negativeMoneyStreak = (player.negativeMoneyStreak ?? 0) + 1;
  } else {
    player.negativeMoneyStreak = 0;
  }
  if (!player.flags.has_partner) return;
  if ((player.negativeMoneyStreak ?? 0) >= BREAKUP_MONEY_STREAK) {
    if (triggerNaturalBreakup(player, "金欠続きで余裕がなくなり")) {
      player.negativeMoneyStreak = 0;
    }
    return;
  }
  if (
    round >= CREDIT_RECOVERY_EVENT_MIN_ROUND
    && player.resources.credits < expectedCreditsForRound(round) - BREAKUP_CREDIT_GAP
  ) {
    triggerNaturalBreakup(player, "単位が大幅に足りず将来が見えなくなり");
  }
}

function calcRomanceChance(player) {
  const base = 0.3;
  const bonus = (player.experience.romance_exp * 0.05)
    + (player.experience.connections * 0.03);
  return Math.min(base + bonus, 0.85);
}

function mergeEffects(target, effects) {
  if (!effects) return;
  for (const [key, value] of Object.entries(effects)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function mergeFlagEffects(...effectsList) {
  const merged = {};
  for (const effects of effectsList) {
    if (!effects) continue;
    Object.assign(merged, effects);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function effectsPolarity(effects) {
  const values = Object.entries(effects ?? {})
    .filter(([key]) => key !== "credits")
    .map(([, value]) => Number(value));
  const sum = values.reduce((total, value) => total + value, 0);
  if (sum > 0) return "positive";
  if (sum < 0) return "negative";
  return "mixed";
}

function updateBadLuck(player, event, choice, appliedEffects) {
  if (typeof choice.badLuckDelta === "number") {
    player.badLuckPoints = Math.max(0, (player.badLuckPoints ?? 0) + choice.badLuckDelta);
    return;
  }

  const polarity = choice.polarity ?? event.polarity ?? effectsPolarity(appliedEffects);
  if (polarity === "negative") {
    player.badLuckPoints = (player.badLuckPoints ?? 0) + 1;
    return;
  }
  if (polarity === "positive") {
    player.badLuckPoints = Math.max(0, (player.badLuckPoints ?? 0) - 1);
  }
}

function resolveReflectionForResult(result) {
  const endingId = result.storyAward?.id
    ?? result.lifeArchetype?.id
    ?? result.academicStatus?.id
    ?? result.ending?.id;
  return REFLECTION_GUIDE[endingId] ?? REFLECTION_GUIDE.default;
}

function enrichResults(results) {
  return results.map((result) => ({
    ...result,
    reflection: resolveReflectionForResult(result),
  }));
}

function startSession(mode) {
  sessionId = randomUUID();
  sessionStartedAtIso = new Date().toISOString();
  state.startedAt = Date.now();
  state.displayStartedAt = null;
  state.turnStartedAt = null;
  state.roundDurations = [];
  state.mode = mode;
}

function isDisplayReadyForBoard() {
  return state.mode !== "board" || state.displayStartedAt === state.startedAt;
}

function writeSessionLogIfPossible(results) {
  if (!sessionId) return;
  try {
    writeSessionLog({
      sessionId,
      startedAt: sessionStartedAtIso,
      endedAt: new Date().toISOString(),
      mode: state.mode,
      players: state.players,
      results,
    });
  } catch (error) {
    console.error("Failed to write session log", error);
  }
  sessionId = null;
  sessionStartedAtIso = null;
}

function recordTurnDuration(player) {
  if (!state.turnStartedAt) return;
  const durationSeconds = Math.max(0, Math.round((Date.now() - state.turnStartedAt) / 1000));
  state.roundDurations = [
    ...(state.roundDurations ?? []),
    {
      round: state.currentRound,
      playerId: player.id,
      playerName: player.name,
      durationSeconds,
    },
  ].slice(-20);
}

function ensurePlayerPathState(player) {
  player.pathScores = {
    ...defaultPathScores(),
    ...(player.pathScores ?? {}),
  };
  player.yearAnchors = player.yearAnchors ?? [];
  player.milestones = player.milestones ?? [];
  player.recoveryCooldowns = player.recoveryCooldowns ?? {};
  player.recoveryUsesByYear = player.recoveryUsesByYear ?? {};
}

function applyIntentScore(player, intentTags, weight = 1) {
  ensurePlayerPathState(player);
  for (const tag of intentTags ?? []) {
    if (!INTENT_TAGS.includes(tag)) continue;
    player.pathScores[tag] = (player.pathScores[tag] ?? 0) + weight;
  }
}

function shouldRecordMilestone(event, choice, intentTags) {
  if (choice.resultWeight && choice.resultWeight >= 2) return true;
  if (choice.flagEffects || choice.setFlags || choice.dynamicRandomChance || choice.cheatAction) return true;
  if (intentTags.some((tag) => ["research", "romance", "career", "creative"].includes(tag))) return true;
  return state.currentRound % 12 === 0;
}

function recordMilestone(player, event, choice, intentTags, storyTags) {
  if (!shouldRecordMilestone(event, choice, intentTags)) return;
  const milestone = {
    round: state.currentRound,
    eventId: event.id,
    eventTitle: event.title,
    choiceId: choice.id,
    choiceLabel: choice.label,
    intentTags,
    storyTags,
  };
  player.milestones = [...(player.milestones ?? []), milestone].slice(-10);
}

function recordChoiceHistory(player, event, choice, appliedEffects, flagEffects, submittedBy) {
  const intentTags = deriveIntentTagsForChoice(choice, event);
  const routeTags = deriveRouteTagsForChoice(choice, event);
  const outcomeTags = deriveOutcomeTagsForChoice(choice, flagEffects);
  const budgetMode = deriveBudgetModeForChoice(choice, event);
  const storyTags = choice.storyTags ?? event.storyTags ?? [];
  applyIntentScore(player, intentTags, Number(choice.resultWeight ?? 1));
  recordMilestone(player, event, choice, intentTags, storyTags);

  const entry = {
    round: state.currentRound,
    eventId: event.id,
    eventTitle: event.title,
    choiceId: choice.id,
    choiceLabel: choice.label,
    effects: appliedEffects,
    flagEffects,
    intentTags,
    routeTags,
    outcomeTags,
    budgetMode,
    storyTags,
    submittedBy,
  };
  player.choiceHistory = [...(player.choiceHistory ?? []), entry];
}

function getRecoveryYearKey(statKey) {
  return `${Math.ceil(state.currentRound / 12)}:${statKey}`;
}

function canShowRecoveryForStat(player, statKey) {
  ensurePlayerPathState(player);
  if ((player.recoveryCooldowns[statKey] ?? 0) > 0) return false;
  const yearKey = getRecoveryYearKey(statKey);
  return (player.recoveryUsesByYear[yearKey] ?? 0) < RECOVERY_MAX_PER_STAT_PER_YEAR;
}

function noteRecoveryUsed(player, statKey) {
  ensurePlayerPathState(player);
  player.recoveryCooldowns[statKey] = RECOVERY_COOLDOWN_ROUNDS;
  const yearKey = getRecoveryYearKey(statKey);
  player.recoveryUsesByYear[yearKey] = (player.recoveryUsesByYear[yearKey] ?? 0) + 1;
}

function tickRecoveryCooldowns(player) {
  ensurePlayerPathState(player);
  const nextCooldowns = {};
  for (const [key, value] of Object.entries(player.recoveryCooldowns)) {
    const nextValue = Math.max(0, Number(value) - 1);
    if (nextValue > 0) {
      nextCooldowns[key] = nextValue;
    }
  }
  player.recoveryCooldowns = nextCooldowns;
}

function getCurrentTimelineEvent() {
  return TIMELINE_EVENTS[state.currentSeasonIndex] ?? null;
}

function setLifePlayersAtSquare(squareId) {
  if (!squareId) return;
  const nextPositions = { ...state.lifePlayerPositions };
  for (const lifePlayer of state.lifePlayers) {
    nextPositions[lifePlayer.id] = squareId;
  }
  state.lifePlayerPositions = nextPositions;
}

function moveLifePlayerToRoute(playerId, event, choice) {
  const routeSquareId = getRouteSquareId(event, choice);
  state.lifePlayerPositions = {
    ...state.lifePlayerPositions,
    [playerId]: routeSquareId,
  };
  const previousRoutes = state.lifePlayerRoutes[playerId] ?? [];
  if (previousRoutes[previousRoutes.length - 1] === routeSquareId) return;
  state.lifePlayerRoutes = {
    ...state.lifePlayerRoutes,
    [playerId]: [...previousRoutes, routeSquareId],
  };
}

function presentTimelineEvent() {
  const event = getCurrentTimelineEvent();
  if (!event) {
    endTimelineGame();
    return;
  }

  const publicEvent = getPublicTimelineEvent(event);
  state.mode = "life_map";
  state.phase = "choosing";
  state.currentRound = state.currentSeasonIndex + 1;
  state.currentEvent = publicEvent;
  state.availableChoiceIds = publicEvent.choices.map((choice) => choice.id);
  state.pendingLifeChoices = {};
  state.pendingLifeResults = {};
  // Master feature: per-event choice mode (simultaneous reveals together vs sequential broadcasts each)
  state.currentChoiceMode = event.choiceMode === "simultaneous" ? "simultaneous" : "sequential";
  state.lastChoiceResult = null;
  state.turnStartedAt = Date.now();
  setLifePlayersAtSquare(getSeasonHubSquareId(event));

  broadcast({
    type: "show_life_event",
    event: publicEvent,
    availableChoiceIds: state.availableChoiceIds,
  });
  broadcastState();
}

function processTimelineChoice(player, choiceId, submittedBy = "controller") {
  const event = getCurrentTimelineEvent();
  if (!event) return;
  if (state.pendingLifeChoices[player.id]) return;
  const choice = event.choices.find((c) => c.id === choiceId);
  if (!choice) return;

  const lifeEffects = normalizeChoiceEffects(choice.effects ?? {});
  const visibleEffects = getVisibleStatEffects(lifeEffects);
  applyEffects(player, visibleEffects);

  state.pendingLifeChoices[player.id] = choiceId;
  moveLifePlayerToRoute(player.id, event, choice);

  const result = {
    playerId: player.id,
    playerName: player.name,
    eventTitle: event.title,
    choiceId: choice.id,
    choiceLabel: choice.label,
    effects: visibleEffects,
    tone: choice.tone,
    storyTags: choice.storyTags,
  };
  state.lastChoiceResult = result;
  state.pendingLifeResults[player.id] = result;
  recordChoiceHistory(player, event, choice, visibleEffects, choice.flagEffects ?? choice.setFlags, submittedBy);

  // Master feature: simultaneous mode holds results until everyone is done.
  // Sequential mode broadcasts each result immediately (original codex behavior).
  if (state.currentChoiceMode === "simultaneous") {
    if (!state.pendingLifeResults) state.pendingLifeResults = {};
    state.pendingLifeResults[player.id] = result;
  } else {
    broadcast({ type: "choice_result", result });
  }

  if (state.currentChoiceMode === "simultaneous") {
    // 一斉モード: 全員揃うまで結果を隠す
    if (tryAdvanceTimelineEvent(event)) {
      return;
    }
    broadcastState();
  } else {
    broadcast({ type: "choice_result", result });
    if (tryAdvanceTimelineEvent(event)) {
      return;
    }
    broadcastState();
  }
}

function tryAdvanceTimelineEvent(event = getCurrentTimelineEvent()) {
  if (!event || state.mode !== "life_map" || state.phase !== "choosing") return false;

  const activePlayerIds = state.players.filter((p) => p.online).map((p) => p.id);
  if (activePlayerIds.length === 0) return false;

  const allDone = activePlayerIds.every((id) => state.pendingLifeChoices[id]);
  if (!allDone) {
    return false;
  }

  // Master feature: in simultaneous mode, reveal all choices together
  // and wait for the host to advance (state.phase = "revealed").
  if (state.currentChoiceMode === "simultaneous") {
    const results = activePlayerIds
      .map((playerId) => state.pendingLifeResults?.[playerId])
      .filter(Boolean);
    state.phase = "revealed";
    broadcast({ type: "all_choices_revealed", results });
    broadcastState();
    return true;
  }

  // Sequential mode: immediately advance to the next event (codex behavior).
  state.lifePlayers = state.lifePlayers.map((lifePlayer) => {
    const selectedId = state.pendingLifeChoices[lifePlayer.id];
    const selectedChoice = event.choices.find((c) => c.id === selectedId);
    if (!selectedChoice) return lifePlayer;
    return applyTimelineChoice(lifePlayer, event, selectedChoice, state.choicePhilosophy);
  });

  state.currentSeasonIndex += 1;
  if (state.currentSeasonIndex >= TIMELINE_EVENTS.length) {
    endTimelineGame();
    return true;
  }
  presentTimelineEvent();
  return true;
}

// Master feature: advance after the host reviews all simultaneous results.
function advanceAfterReveal() {
  if (state.mode !== "life_map" || state.phase !== "revealed") return;
  const event = getCurrentTimelineEvent();
  if (!event) return;

  state.lifePlayers = state.lifePlayers.map((lifePlayer) => {
    const selectedId = state.pendingLifeChoices[lifePlayer.id];
    const selectedChoice = event.choices.find((c) => c.id === selectedId);
    if (!selectedChoice) return lifePlayer;
    return applyTimelineChoice(lifePlayer, event, selectedChoice);
  });

  state.currentSeasonIndex += 1;
  if (state.currentSeasonIndex >= TIMELINE_EVENTS.length) {
    endTimelineGame();
    return;
  }
  presentTimelineEvent();
}

function endTimelineGame() {
  const lifeResults = generateTimelineResults(state.lifePlayers);
  const results = enrichResults(lifeResults.map((result) => {
    const player = state.players.find((p) => p.id === result.playerId);
    return {
      playerId: result.playerId,
      playerName: result.playerName,
      academicStatus: result.academicStatus,
      lifeArchetype: result.lifeArchetype,
      storyAward: result.storyAward,
      summary: result.summary,
      resources: player?.resources ?? defaultResources(),
      experience: player?.experience ?? defaultExperience(),
      flags: player?.flags ?? defaultFlags(),
      flagHistory: player?.flagHistory ?? [],
      choiceHistory: player?.choiceHistory ?? [],
      storyTags: result.storyTags,
    };
  }));

  state.phase = "result";
  state.finalResults = results;
  state.currentEvent = null;
  state.availableChoiceIds = [];
  state.activeTurnPlayerIds = [];
  state.activeTurnEvents = {};
  state.availableChoiceIdsByPlayer = {};
  state.pendingTurnChoices = {};
  state.pendingRecoveryOriginalEvents = {};
  state.yearRecap = null;
  state.lastChoiceResult = null;

  writeSessionLogIfPossible(results);
  broadcast({ type: "game_result", results });
  broadcastState();
}

/**
 * Get the current player whose turn it is.
 */
function getCurrentPlayer() {
  if (state.turnOrder.length === 0) return null;
  const playerId = state.turnOrder[state.turnIndex];
  return state.players.find((p) => p.id === playerId) ?? null;
}

function getPlayerById(playerId) {
  return state.players.find((player) => player.id === playerId) ?? null;
}

function isPlayerActiveInBoardGroup(playerId) {
  return state.mode !== "life_map" && state.activeTurnPlayerIds.includes(playerId);
}

function selectNextBoardTurnGroup() {
  const remainingIds = state.turnOrder
    .filter((id) => !state.completedTurns.includes(id))
    .filter((id) => getPlayerById(id)?.online);
  const nextIds = state.turnMode === "all"
    ? remainingIds
    : remainingIds.slice(0, TURN_GROUP_SIZE);

  state.activeTurnPlayerIds = nextIds;
  state.turnIndex = nextIds.length > 0 ? Math.max(0, state.turnOrder.indexOf(nextIds[0])) : 0;
  return nextIds;
}

function clearBoardTurnEventState({ clearResults = false } = {}) {
  state.currentEvent = null;
  state.availableChoiceIds = [];
  state.activeTurnEvents = {};
  state.availableChoiceIdsByPlayer = {};
  state.pendingTurnChoices = {};
  state.pendingRecoveryOriginalEvents = {};
  state.lastChoiceResult = null;
  if (clearResults) {
    state.lastTurnGroupResults = [];
  }
}

function prepareNextBoardTurnGroup() {
  clearBoardTurnEventState();
  state.lastRoll = null;
  state.turnStartedAt = null;

  const remainingIds = state.turnOrder
    .filter((id) => !state.completedTurns.includes(id));
  const nextIds = selectNextBoardTurnGroup();
  if (nextIds.length === 0) {
    if (remainingIds.length > 0) {
      state.phase = "rolling";
      state.activeTurnPlayerIds = [];
      broadcastState();
      return;
    }
    endRound();
    return;
  }

  state.phase = "rolling";
  broadcastState();
}

/**
 * Move a player forward by a number of squares on the board.
 */
function movePlayer(player, squaresToMove) {
  let currentPos = player.position;
  for (let i = 0; i < squaresToMove; i++) {
    const nextId = getNextSquareId(currentPos, player);
    if (nextId === null) break; // Already at goal
    currentPos = nextId;
    // Stop at branch points — player must choose a route
    const square = BOARD[currentPos];
    if (square && square.type === "branch_point") break;
  }
  player.position = currentPos;
}

function prepareBoardEventForPlayer(player) {
  // Branch points always show their own event (route selection)
  const square = BOARD[player.position];
  const isBranchPoint = square && square.type === "branch_point";

  // Check threshold events first (but not at branch points)
  let event = null;
  if (!isBranchPoint) {
    event = checkThresholdEvents(player);
  }

  if (!event) {
    event = getEventForPosition(player.position, player);
  }

  if (!event) {
    return null;
  }

  // Resolve conditional variants
  const resolvedEvent = resolveEventChoices(event, player);

  // If no choices (branch point / goal), auto-advance
  if (!resolvedEvent.choices || resolvedEvent.choices.length === 0) {
    return null;
  }

  // Filter available choices
  const available = filterAvailableChoices(resolvedEvent.choices, player);

  if (available.length === 0) {
    return null;
  }

  const availableIds = available.map((c) => c.id);
  const original = { event: resolvedEvent, availableIds };
  const recoveryEvent = buildNegativeRecoveryEvent(player);
  if (recoveryEvent) {
    return {
      event: recoveryEvent,
      availableIds: recoveryEvent.choices.map((choice) => choice.id),
      recoveryOriginal: original,
    };
  }

  return { event: resolvedEvent, availableIds };
}

/**
 * Present one shared turn window for up to two active board players.
 */
function presentBoardTurnGroupEvents(triggeringPlayer) {
  if (!isPlayerActiveInBoardGroup(triggeringPlayer.id)) return;
  const activePlayers = state.activeTurnPlayerIds
    .map(getPlayerById)
    .filter((player) => player && player.online);
  if (activePlayers.length === 0) {
    prepareNextBoardTurnGroup();
    return;
  }

  const monthSquare = String(Math.min(state.currentRound, BOARD_FINAL_ROUND));
  const activeTurnEvents = {};
  const availableChoiceIdsByPlayer = {};
  const pendingRecoveryOriginalEvents = {};
  let leadEvent = null;
  let leadAvailableIds = [];

  for (const player of activePlayers) {
    player.position = monthSquare;
    player.lastRoll = 1;
    const prepared = prepareBoardEventForPlayer(player);
    if (!prepared) {
      state.completedTurns.push(player.id);
      continue;
    }
    activeTurnEvents[player.id] = prepared.event;
    availableChoiceIdsByPlayer[player.id] = prepared.availableIds;
    if (prepared.recoveryOriginal) {
      pendingRecoveryOriginalEvents[player.id] = prepared.recoveryOriginal;
    }
    if (!leadEvent) {
      leadEvent = prepared.event;
      leadAvailableIds = prepared.availableIds;
    }
  }

  const eventPlayerIds = Object.keys(activeTurnEvents);
  state.activeTurnPlayerIds = state.activeTurnPlayerIds.filter((id) => eventPlayerIds.includes(id));
  if (!leadEvent || state.activeTurnPlayerIds.length === 0) {
    prepareNextBoardTurnGroup();
    return;
  }

  state.phase = "choosing";
  state.currentEvent = leadEvent;
  state.availableChoiceIds = leadAvailableIds;
  state.activeTurnEvents = activeTurnEvents;
  state.availableChoiceIdsByPlayer = availableChoiceIdsByPlayer;
  state.pendingRecoveryOriginalEvents = pendingRecoveryOriginalEvents;
  state.pendingTurnChoices = {};
  state.lastTurnGroupResults = [];
  state.lastChoiceResult = null;
  state.turnStartedAt = Date.now();

  for (const playerId of state.activeTurnPlayerIds) {
    sendToController(playerId, {
      type: "show_event",
      event: activeTurnEvents[playerId],
      availableChoiceIds: availableChoiceIdsByPlayer[playerId],
      playerId,
    });
  }

  state.lastRoll = {
    playerId: triggeringPlayer.id,
    playerName: triggeringPlayer.name,
    value: 1,
    squaresAdvanced: 1,
  };

  broadcastState();
}

function rollForPlayer(player) {
  if (state.mode !== "life_map") {
    presentBoardTurnGroupEvents(player);
    return;
  }
}

function buildYearAnchorEvent(year) {
  const nextYear = Math.min(4, year + 1);
  return {
    id: `year_anchor:${year}`,
    title: `${nextYear}年目の方針`,
    description: "ここから何を大事にするかを決める。すぐに点数は動かないが、この後のイベントと最終結果に残る。",
    year,
    category: "方針",
    choices: [
      {
        id: `year_anchor:${year}:study`,
        label: "授業と研究の土台を固める",
        effects: {},
        preserveEffects: true,
        yearAnchor: true,
        intentTags: ["study", "research"],
        storyTags: ["学びの軸"],
        resultWeight: 2,
      },
      {
        id: `year_anchor:${year}:social`,
        label: "友人関係と居場所を広げる",
        effects: {},
        preserveEffects: true,
        yearAnchor: true,
        intentTags: ["social", "community"],
        storyTags: ["人間関係"],
        resultWeight: 2,
      },
      {
        id: `year_anchor:${year}:romance`,
        label: "恋愛もちゃんと大事にする",
        effects: {},
        preserveEffects: true,
        yearAnchor: true,
        intentTags: ["romance", "social"],
        storyTags: ["恋愛"],
        resultWeight: 2,
      },
      {
        id: `year_anchor:${year}:creative`,
        label: "趣味や制作に踏み込む",
        effects: {},
        preserveEffects: true,
        yearAnchor: true,
        intentTags: ["creative", "adventure"],
        storyTags: ["制作"],
        resultWeight: 2,
      },
      {
        id: `year_anchor:${year}:career`,
        label: "進路を早めに見る",
        effects: {},
        preserveEffects: true,
        yearAnchor: true,
        intentTags: ["career", "work"],
        storyTags: ["進路"],
        resultWeight: 2,
      },
      {
        id: `year_anchor:${year}:rest`,
        label: "生活リズムと余白を守る",
        effects: {},
        preserveEffects: true,
        yearAnchor: true,
        intentTags: ["rest"],
        storyTags: ["生活"],
        resultWeight: 2,
      },
    ],
  };
}

function presentYearAnchorEvent(finishedRound) {
  const year = Math.ceil(finishedRound / 12);
  const event = buildYearAnchorEvent(year);
  const activeIds = state.players
    .filter((player) => player.online)
    .map((player) => player.id);

  if (activeIds.length === 0) {
    startNextBoardRound(finishedRound);
    return;
  }

  const availableIds = event.choices.map((choice) => choice.id);
  state.phase = "choosing";
  state.yearRecap = null;
  state.activeTurnPlayerIds = activeIds;
  state.turnIndex = 0;
  state.currentEvent = event;
  state.availableChoiceIds = availableIds;
  state.activeTurnEvents = Object.fromEntries(activeIds.map((id) => [id, event]));
  state.availableChoiceIdsByPlayer = Object.fromEntries(activeIds.map((id) => [id, availableIds]));
  state.pendingTurnChoices = {};
  state.pendingRecoveryOriginalEvents = {};
  state.lastTurnGroupResults = [];
  state.lastChoiceResult = null;
  state.turnStartedAt = Date.now();
  for (const playerId of activeIds) {
    sendToController(playerId, {
      type: "show_event",
      event,
      availableChoiceIds: availableIds,
      playerId,
    });
  }
  broadcastState();
}

function submitChoiceForPlayer(player, choiceId, submittedBy = "controller") {
  if (state.mode === "life_map") {
    if (!state.availableChoiceIds.includes(choiceId)) return false;
    processTimelineChoice(player, choiceId, submittedBy);
    return true;
  }

  if (!isPlayerActiveInBoardGroup(player.id)) return false;
  const availableIds = state.availableChoiceIdsByPlayer[player.id] ?? [];
  if (!availableIds.includes(choiceId)) return false;
  if (state.pendingTurnChoices[player.id]) return false;

  processBoardGroupChoice(player, choiceId, submittedBy);
  return true;
}

function refreshLeadBoardEvent() {
  const leadPlayerId = state.activeTurnPlayerIds.find((id) => state.activeTurnEvents[id]);
  state.currentEvent = leadPlayerId ? state.activeTurnEvents[leadPlayerId] : null;
  state.availableChoiceIds = leadPlayerId ? state.availableChoiceIdsByPlayer[leadPlayerId] ?? [] : [];
}

function returnToRecoveryOriginalEvent(player) {
  const original = state.pendingRecoveryOriginalEvents?.[player.id];
  if (!original) return false;
  const recoveryEventId = state.activeTurnEvents[player.id]?.id ?? "";
  const recoveryStatKey = recoveryEventId.startsWith("negative_recovery:")
    ? recoveryEventId.split(":")[1]
    : null;
  if (recoveryStatKey) {
    noteRecoveryUsed(player, recoveryStatKey);
  }

  state.activeTurnEvents = {
    ...state.activeTurnEvents,
    [player.id]: original.event,
  };
  state.availableChoiceIdsByPlayer = {
    ...state.availableChoiceIdsByPlayer,
    [player.id]: original.availableIds,
  };
  const pendingRecoveryOriginalEvents = { ...state.pendingRecoveryOriginalEvents };
  delete pendingRecoveryOriginalEvents[player.id];
  state.pendingRecoveryOriginalEvents = pendingRecoveryOriginalEvents;
  refreshLeadBoardEvent();

  sendToController(player.id, {
    type: "show_event",
    event: original.event,
    availableChoiceIds: original.availableIds,
    playerId: player.id,
  });
  broadcastState();
  return true;
}

function addCompletedTurn(playerId) {
  if (!state.completedTurns.includes(playerId)) {
    state.completedTurns.push(playerId);
  }
}

function processYearAnchorChoice(player, event, choice, submittedBy) {
  const year = Number(event.id.split(":")[1]);
  const intentTags = deriveIntentTagsForChoice(choice, event);
  const storyTags = choice.storyTags ?? [];
  ensurePlayerPathState(player);
  player.yearAnchors = [
    ...player.yearAnchors.filter((anchor) => anchor.year !== year),
    {
      year,
      choiceId: choice.id,
      choiceLabel: choice.label,
      intentTags,
      storyTags,
    },
  ].sort((a, b) => a.year - b.year);
  recordMilestone(player, event, choice, intentTags, storyTags);

  const result = {
    playerId: player.id,
    playerName: player.name,
    eventTitle: event.title,
    choiceId: choice.id,
    choiceLabel: choice.label,
    effects: {},
    intentTags,
    routeTags: deriveRouteTagsForChoice(choice, event),
    outcomeTags: deriveOutcomeTagsForChoice(choice),
    storyTags,
    submittedBy,
  };

  state.lastChoiceResult = result;
  state.pendingTurnChoices[player.id] = choice.id;
  state.lastTurnGroupResults = [
    ...state.lastTurnGroupResults.filter((entry) => entry.playerId !== player.id),
    result,
  ];
  broadcast({ type: "choice_result", result });
  tryCompleteBoardTurnGroup();
}

/**
 * Process a player's choice.
 */
function processBoardGroupChoice(player, choiceId, submittedBy = "controller") {
  const event = state.activeTurnEvents[player.id] ?? state.currentEvent;
  if (!event) return;

  const choice = event.choices.find((c) => c.id === choiceId);
  if (!choice) return;

  if (choice.skipRecovery) {
    returnToRecoveryOriginalEvent(player);
    return;
  }
  if (choice.yearAnchor || event.id.startsWith("year_anchor:")) {
    processYearAnchorChoice(player, event, choice, submittedBy);
    return;
  }
  if (event.id.startsWith("negative_recovery:")) {
    const recoveryStatKey = event.id.split(":")[1];
    if (recoveryStatKey) {
      noteRecoveryUsed(player, recoveryStatKey);
    }
  }

  const flagEffects = choice.flagEffects ?? choice.setFlags;
  let randomOutcome;
  let randomEffects = {};
  let specialConsequenceEffects = {};
  let randomFlagEffects = null;
  let forcedFlagEffects = null;

  if (choice.dynamicRandomChance?.formula === "romance_success") {
    const success = Math.random() < calcRomanceChance(player);
    randomEffects = success
      ? choice.dynamicRandomChance.onSuccess
      : choice.dynamicRandomChance.onFailure;
    randomFlagEffects = success
      ? choice.dynamicRandomChance.onSuccessFlags
      : choice.dynamicRandomChance.onFailureFlags;
    randomOutcome = success ? "success" : "failure";
  }

  if (choice.cheatAction && player.flags.has_partner) {
    const exposed = Math.random() < 0.7;
    if (exposed) {
      specialConsequenceEffects = {
        romance_exp: -5,
        connections: -4,
        health: -3,
      };
      forcedFlagEffects = {
        has_partner: false,
        cheating: false,
        cheated_before: true,
        breakup: true,
      };
      randomOutcome = "cheat_exposed";
    } else {
      forcedFlagEffects = {
        cheating: true,
        cheated_before: true,
      };
      randomOutcome = "cheat_hidden";
    }
  }

  // Handle random chance
  if (choice.randomChance !== undefined) {
    const roll = Math.random();
    if (roll < choice.randomChance) {
      randomEffects = choice.randomBonusEffects ?? {};
    } else {
      randomEffects = choice.randomPenaltyEffects ?? {};
    }
  }

  const appliedEffects = choice.preserveEffects
    ? mergeStatEffects(choice.effects, randomEffects)
    : normalizeChoiceEffectOutcome(choice, randomEffects, {
      event,
      targetTotal: effectBudgetTargetFor(event, choice),
    });
  applyEffects(player, appliedEffects);
  if (Object.keys(specialConsequenceEffects).length > 0) {
    applyEffects(player, specialConsequenceEffects);
    mergeEffects(appliedEffects, specialConsequenceEffects);
  }

  // Apply flag effects
  const appliedFlagEffects = mergeFlagEffects(
    flagEffects ? applyFlagEffects(player, flagEffects) : undefined,
    randomFlagEffects ? applyFlagEffects(player, randomFlagEffects) : undefined,
    forcedFlagEffects ? applyFlagEffects(player, forcedFlagEffects) : undefined,
  );
  if (state.pendingRecoveryOriginalEvents?.[player.id]) {
    const pendingRecoveryOriginalEvents = { ...state.pendingRecoveryOriginalEvents };
    delete pendingRecoveryOriginalEvents[player.id];
    state.pendingRecoveryOriginalEvents = pendingRecoveryOriginalEvents;
  }

  const reportedFlagEffects = appliedFlagEffects;
  const intentTags = deriveIntentTagsForChoice(choice, event);
  const routeTags = deriveRouteTagsForChoice(choice, event);
  const outcomeTags = deriveOutcomeTagsForChoice(choice, reportedFlagEffects);
  const storyTags = choice.storyTags ?? event.storyTags ?? [];
  updateBadLuck(player, event, choice, appliedEffects);
  recordTurnDuration(player);
  recordChoiceHistory(player, event, choice, appliedEffects, reportedFlagEffects, submittedBy);

  const result = {
    playerId: player.id,
    playerName: player.name,
    eventTitle: event.title,
    choiceId: choice.id,
    choiceLabel: choice.label,
    effects: appliedEffects,
    flagEffects: reportedFlagEffects,
    intentTags,
    routeTags,
    outcomeTags,
    storyTags,
    randomOutcome,
    submittedBy,
  };

  state.lastChoiceResult = result;
  state.pendingTurnChoices[player.id] = choiceId;
  state.lastTurnGroupResults = [
    ...state.lastTurnGroupResults.filter((entry) => entry.playerId !== player.id),
    result,
  ];

  broadcast({ type: "choice_result", result });

  // If choice has a branchRoute, move player to that branch start
  if (choice.branchRoute) {
    player.position = choice.branchRoute;
  }

  tryCompleteBoardTurnGroup();
}

/**
 * Advance to the next player's turn, or end the round.
 */
function tryCompleteBoardTurnGroup() {
  const activeIds = state.activeTurnPlayerIds.filter((id) => getPlayerById(id)?.online);
  if (activeIds.length === 0) {
    prepareNextBoardTurnGroup();
    return true;
  }

  const allDone = activeIds.every((id) => state.pendingTurnChoices[id]);
  if (!allDone) {
    broadcastState();
    return false;
  }

  const completedYearAnchorRound = state.currentEvent?.id?.startsWith("year_anchor:")
    ? state.currentRound
    : null;

  for (const id of activeIds) {
    addCompletedTurn(id);
  }

  state.phase = "animating";
  state.currentEvent = null;
  state.availableChoiceIds = [];
  state.activeTurnEvents = {};
  state.availableChoiceIdsByPlayer = {};
  state.pendingTurnChoices = {};
  state.pendingRecoveryOriginalEvents = {};
  broadcastState();

  scheduleGroupResultAdvance(completedYearAnchorRound);
  return true;
}

// The comparison ("ふたりの選択") screen is shown while phase === "animating".
// It normally auto-advances after TURN_GROUP_RESULT_MS, but the display can skip
// the wait. Both paths run advanceAfterTurnGroup, guarded by the phase check so
// they can never double-advance.
let groupResultTimer = null;
let pendingGroupResultAnchorRound = null;

function clearGroupResultTimer() {
  if (groupResultTimer) {
    clearTimeout(groupResultTimer);
    groupResultTimer = null;
  }
}

function advanceAfterTurnGroup(completedYearAnchorRound) {
  if (state.mode !== "life_map" && state.phase === "animating") {
    if (completedYearAnchorRound !== null) {
      startNextBoardRound(completedYearAnchorRound);
    } else {
      prepareNextBoardTurnGroup();
    }
  }
}

function scheduleGroupResultAdvance(completedYearAnchorRound) {
  clearGroupResultTimer();
  pendingGroupResultAnchorRound = completedYearAnchorRound;
  groupResultTimer = setTimeout(() => {
    groupResultTimer = null;
    advanceAfterTurnGroup(completedYearAnchorRound);
  }, TURN_GROUP_RESULT_MS);
}

function skipGroupResultAdvance() {
  if (state.mode === "life_map" || state.phase !== "animating") return false;
  clearGroupResultTimer();
  advanceAfterTurnGroup(pendingGroupResultAnchorRound);
  return true;
}

function topExperienceLabels(player) {
  const labels = {
    intellect: "学び",
    connections: "人間関係",
    work_tolerance: "働く力",
    action_power: "行動力",
    romance_exp: "恋愛経験",
  };
  return Object.entries(player.experience)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([key]) => labels[key] ?? key);
}

function warningSignsForPlayer(player, expectedCredits) {
  const warnings = [];
  if (player.resources.credits < expectedCredits - 8) warnings.push("単位の挽回が必要");
  if (player.resources.health <= 4) warnings.push("体力が落ち気味");
  if (player.resources.time <= 4) warnings.push("時間に余裕がない");
  if (player.resources.money <= 0) warnings.push("金欠気味");
  if (warnings.length === 0) warnings.push("大きな危険サインなし");
  return warnings;
}

function creditStatusFor(credits, expectedCredits) {
  if (credits >= expectedCredits + 4) return "順調";
  if (credits >= expectedCredits - 4) return "少し遅れ";
  if (credits >= expectedCredits - 12) return "挽回可能";
  return "要注意";
}

function graduationOutlookFor(credits, round) {
  const projected = Math.round((credits / round) * BOARD_FINAL_ROUND);
  if (projected >= CREDIT_CHECKPOINTS[48] + 8) return "卒業見込みはかなり安定";
  if (projected >= CREDIT_CHECKPOINTS[48]) return "卒業見込みあり";
  if (projected >= 108) return "追加履修で届く";
  return "集中講義や補講が必要";
}

function buildYearRecap(finishedRound) {
  const year = Math.ceil(finishedRound / 12);
  const expectedCredits = expectedCreditsForRound(finishedRound);
  return {
    year,
    round: finishedRound,
    title: `${year}年終了時点の状態`,
    players: state.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      credits: player.resources.credits,
      creditStatus: creditStatusFor(player.resources.credits, expectedCredits),
      graduationOutlook: graduationOutlookFor(player.resources.credits, finishedRound),
      strengths: topExperienceLabels(player),
      warningSigns: warningSignsForPlayer(player, expectedCredits),
      resources: { ...player.resources },
      experience: { ...player.experience },
    })),
  };
}

function applyCreditAudit(finishedRound) {
  if (!CREDIT_AUDIT_ROUNDS.has(finishedRound)) return [];

  const expectedCredits = expectedCreditsForRound(finishedRound);
  const maxBonus = YEAR_RECAP_ROUNDS.has(finishedRound)
    ? YEAR_END_CREDIT_AUDIT_MAX_BONUS
    : CREDIT_AUDIT_MAX_BONUS;
  const adjustments = [];

  for (const player of state.players) {
    const deficit = expectedCredits - player.resources.credits;
    if (
      finishedRound === BOARD_FINAL_ROUND
      && canApplyFinalCreditAudit(player)
      && deficit > 0
    ) {
      player.resources.credits = clampResource("credits", player.resources.credits + deficit);
      adjustments.push({ playerName: player.name, bonus: deficit });
      continue;
    }

    if (deficit <= CREDIT_AUDIT_GRACE_GAP) continue;

    const bonus = Math.min(
      maxBonus,
      Math.max(1, Math.ceil((deficit - CREDIT_AUDIT_GRACE_GAP) / 2)),
    );
    player.resources.credits = clampResource("credits", player.resources.credits + bonus);
    adjustments.push({ playerName: player.name, bonus });
  }

  return adjustments;
}

/**
 * End the current round, apply per-round effects, check credit checkpoints.
 */
function endRound() {
  const finishedRound = state.currentRound;
  const roundInfo = getRoundInfo(finishedRound);

  // Semester credit bonus. The final-semester bonus (month 48) is paid at
  // month 46 instead — one event before the graduation judgment (event 47) —
  // so year-4 players can actually choose to graduate at 卒業判定 rather than
  // only clearing the 124-credit bar afterwards via the year-end audit.
  const isFinalSemesterBonusRound = finishedRound === FINAL_SEMESTER_BONUS_ROUND;
  const isRegularSemesterBonusRound =
    finishedRound % 6 === 0 && finishedRound !== BOARD_FINAL_ROUND;
  if (isFinalSemesterBonusRound || isRegularSemesterBonusRound) {
    for (const player of state.players) {
      player.resources.credits = clampResource(
        "credits",
        player.resources.credits + SEMESTER_CREDIT_BONUS,
      );
    }
    broadcast({
      type: "system",
      message: isFinalSemesterBonusRound
        ? `卒業に向けた履修整理で全員に${SEMESTER_CREDIT_BONUS}単位が入りました。`
        : `学期末の履修整理で全員に${SEMESTER_CREDIT_BONUS}単位が入りました。`,
    });
  }

  const creditAdjustments = applyCreditAudit(finishedRound);
  if (creditAdjustments.length > 0) {
    const names = creditAdjustments
      .slice(0, 3)
      .map((entry) => `${entry.playerName}+${entry.bonus}`)
      .join("、");
    const suffix = creditAdjustments.length > 3 ? ` ほか${creditAdjustments.length - 3}人` : "";
    broadcast({
      type: "system",
      message: `履修確認で遅れを調整しました（${names}${suffix}単位）。`,
    });
  }

  // Check credit checkpoints
  const creditReq = CREDIT_CHECKPOINTS[finishedRound];
  if (creditReq !== undefined) {
    for (const player of state.players) {
      if (player.resources.credits < creditReq) {
        broadcast({
          type: "system",
          message: `${player.name} の単位が不足しています！（${player.resources.credits}/${creditReq}単位）`,
        });
      }
    }
  }

  // Broadcast round end
  broadcast({ type: "round_end", round: finishedRound, roundInfo });

  // Check if game is over (month 48)
  if (finishedRound >= BOARD_FINAL_ROUND) {
    endGame();
    return;
  }

  // Apply lifestyle effects at the end of the finished month.
  for (const player of state.players) {
    if (player.online) {
      applyPerRoundFlagEffects(player);
      tickRecoveryCooldowns(player);
    }
    applyRelationshipStrain(player, finishedRound);
  }

  if (YEAR_RECAP_ROUNDS.has(finishedRound)) {
    state.phase = "year_recap";
    state.yearRecap = buildYearRecap(finishedRound);
    state.activeTurnPlayerIds = [];
    clearBoardTurnEventState();
    state.turnStartedAt = null;
    broadcastState();
    return;
  }

  startNextBoardRound(finishedRound);
}

function startNextBoardRound(finishedRound) {
  state.currentRound = finishedRound + 1;
  state.completedTurns = [];
  state.thresholdFiredThisRound = new Set();
  state.turnIndex = 0;
  state.lastRoll = null;
  state.lastChoiceResult = null;
  state.yearRecap = null;
  state.lastTurnGroupResults = [];
  clearBoardTurnEventState({ clearResults: true });
  state.turnStartedAt = null;

  prepareNextBoardTurnGroup();
}

/**
 * End the game, calculate results, broadcast.
 */
function endGame() {
  const activePlayers = state.players.slice(); // Include all players regardless of online status
  for (const player of activePlayers) {
    if (
      canApplyFinalCreditAudit(player)
      && player.resources.credits < CREDIT_CHECKPOINTS[48]
    ) {
      player.resources.credits = CREDIT_CHECKPOINTS[48];
    }
  }
  const results = enrichResults(generateResults(activePlayers));

  state.phase = "result";
  state.finalResults = results;
  state.currentEvent = null;
  state.availableChoiceIds = [];
  state.lastChoiceResult = null;

  writeSessionLogIfPossible(results);
  broadcast({ type: "game_result", results });
  broadcastState();
}

// ═══════════════════════════════════════════════════════════════════
//  WebSocket Connection Handler
// ═══════════════════════════════════════════════════════════════════

wss.on("connection", (socket) => {
  sockets.set(socket, { id: null, role: null, name: null });

  socket.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ─── join ──────────────────────────────────────────────────
    if (payload.type === "join") {
      const role = payload.role;
      const requestedId = typeof payload.clientId === "string" ? payload.clientId : null;
      const name = typeof payload.name === "string" ? payload.name : "Guest";
      const passkey = typeof payload.passkey === "string" ? payload.passkey.trim() : "";
      const faculty = normalizeFaculty(payload.faculty);

      let clientId = requestedId ?? randomUUID();
      let issuedPasskey;

      if (role === "controller") {
        const registration = registerOrRestorePlayer({
          requestedId,
          name,
          passkey,
          faculty,
        });
        if (registration.error) {
          sendTo(socket, { type: "auth_error", message: registration.error });
          return;
        }
        clientId = registration.clientId;
        issuedPasskey = registration.passkey;
        addPlayerToActiveGame(clientId);
      } else {
        if (!clientId) {
          clientId = randomUUID();
        }
      }

      sockets.set(socket, { id: clientId, role, name });

      if (role === "host") {
        hostId = clientId;
      }

      sendTo(socket, {
        type: "welcome",
        clientId,
        hostId,
        urls: role === "host" ? getHostUrls() : undefined,
        passkey: issuedPasskey,
      });
      if (role === "controller" && state.mode === "life_map" && state.phase === "choosing" && state.currentEvent) {
        sendTo(socket, {
          type: "show_life_event",
          event: state.currentEvent,
          availableChoiceIds: state.availableChoiceIds,
        });
      }
      if (role === "controller" && state.mode !== "life_map" && state.phase === "choosing" && state.currentEvent) {
        const event = state.activeTurnEvents[clientId];
        const availableChoiceIds = state.availableChoiceIdsByPlayer[clientId];
        if (event && availableChoiceIds) {
          sendTo(socket, {
            type: "show_event",
            event,
            availableChoiceIds,
            playerId: clientId,
          });
        }
      }
      broadcastState();
      sendHostPlayerManagement();
      return;
    }

    const client = sockets.get(socket);
    if (!client?.id) return;

    // ─── start_game ────────────────────────────────────────────
    if (payload.type === "start_game") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (!state.players.some((player) => player.online)) return;

      // Initialize game state
      startSession("board");
      state.phase = "rolling";
      state.currentRound = 1;
      state.turnOrder = state.players.map((p) => p.id);
      state.completedTurns = [];
      state.turnIndex = 0;
      state.lastRoll = null;
      state.currentEvent = null;
      state.availableChoiceIds = [];
      state.lastChoiceResult = null;
      state.activeTurnPlayerIds = [];
      state.activeTurnEvents = {};
      state.availableChoiceIdsByPlayer = {};
      state.pendingTurnChoices = {};
      state.pendingRecoveryOriginalEvents = {};
      state.lastTurnGroupResults = [];
      state.yearRecap = null;
      state.currentSeasonIndex = 0;
      state.lifePlayers = [];
      state.lifeMapSquares = [];
      state.lifePlayerPositions = {};
      state.lifePlayerRoutes = {};
      state.pendingLifeChoices = {};
      state.finalResults = null;
      state.fallbackMode = false;

      // Reset all players
      for (const player of state.players) {
        player.resources = defaultResources();
        player.experience = defaultExperience();
        player.experienceProgress = {};
        player.negativeMoneyStreak = 0;
        player.flags = defaultFlags();
        player.position = "1";
        player.lastRoll = undefined;
        player.badLuckPoints = 0;
        player.flagHistory = [];
        player.choiceHistory = [];
        player.pathScores = defaultPathScores();
        player.yearAnchors = [];
        player.milestones = [];
        player.recoveryCooldowns = {};
        player.recoveryUsesByYear = {};
      }

      prepareNextBoardTurnGroup();
      sendHostPlayerManagement();
      broadcastNavigate("/controller-play.html", ["controller"]);
      return;
    }

    // ─── start_life_map_game ────────────────────────────────────
    if (payload.type === "start_life_map_game") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (state.players.length === 0) return;

      startSession("life_map");
      state.phase = "choosing";
      state.currentRound = 1;
      state.turnOrder = state.players.map((p) => p.id);
      state.completedTurns = [];
      state.turnIndex = 0;
      state.lastRoll = null;
      state.currentEvent = null;
      state.availableChoiceIds = [];
      state.lastChoiceResult = null;
      state.activeTurnPlayerIds = [];
      state.activeTurnEvents = {};
      state.availableChoiceIdsByPlayer = {};
      state.pendingTurnChoices = {};
      state.pendingRecoveryOriginalEvents = {};
      state.lastTurnGroupResults = [];
      state.yearRecap = null;
      state.currentSeasonIndex = 0;
      state.pendingLifeChoices = {};
      state.pendingLifeResults = {};
      state.finalResults = null;
      // Master feature: choice philosophy ("equal" | "realistic")
      // NOTE: currently stored only; actual gameplay differentiation
      // is tracked in a follow-up issue (interacts with codex's effectBudget).
      state.choicePhilosophy = payload.philosophy === "realistic" ? "realistic" : "equal";
      state.fallbackMode = false;
      for (const player of state.players) {
        player.resources = defaultResources();
        player.experience = defaultExperience();
        player.experienceProgress = {};
        player.negativeMoneyStreak = 0;
        player.flags = defaultFlags();
        player.position = "1";
        player.lastRoll = undefined;
        player.badLuckPoints = 0;
        player.flagHistory = [];
        player.choiceHistory = [];
        player.pathScores = defaultPathScores();
        player.yearAnchors = [];
        player.milestones = [];
        player.recoveryCooldowns = {};
        player.recoveryUsesByYear = {};
      }
      state.choicePhilosophy = payload.philosophy ?? "equal";
      state.lifePlayers = state.players.map((player) => createTimelinePlayer(player.id, player.name));
      state.lifeMapSquares = PUBLIC_LIFE_MAP_SQUARES;
      state.lifePlayerPositions = Object.fromEntries(
        state.lifePlayers.map((player) => [player.id, LIFE_MAP.startSquareId]),
      );
      state.lifePlayerRoutes = Object.fromEntries(
        state.lifePlayers.map((player) => [player.id, []]),
      );

      broadcastNavigate("/controller-play.html", ["controller"]);
      presentTimelineEvent();
      return;
    }

    // ─── reset_game ────────────────────────────────────────────
    if (payload.type === "reset_game") {
      if (client.role !== "host" || client.id !== hostId) return;

      // Drop all players & game state, return to lobby
      state = defaultGameState();
      playerAuth.clear();
      sessionId = null;
      sessionStartedAtIso = null;
      broadcast({
        type: "system",
        message: "ホストがゲームをリセットしました。ロビーに戻ります。",
      });
      broadcastNavigate("/controller.html", ["controller"]);
      broadcastState();
      sendHostPlayerManagement();
      return;
    }

    // ─── end_game ──────────────────────────────────────────────
    if (payload.type === "end_game") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (state.phase === "lobby" || state.phase === "result") return;

      if (state.mode === "life_map") {
        endTimelineGame();
      } else {
        endGame();
      }
      return;
    }

    // ─── remove_player ──────────────────────────────────────────
    if (payload.type === "remove_player") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (typeof payload.playerId !== "string") return;

      const removedPlayer = removePlayer(payload.playerId);
      if (!removedPlayer) return;

      broadcast({
        type: "system",
        message: `${removedPlayer.name} をプレイヤー一覧から削除しました。`,
      });
      broadcastState();
      sendHostPlayerManagement();
      return;
    }

    // ─── fallback mode ─────────────────────────────────────────
    if (payload.type === "set_fallback_mode") {
      if (client.role !== "host" || client.id !== hostId) return;
      state.fallbackMode = Boolean(payload.enabled);
      broadcastState();
      return;
    }

    if (payload.type === "set_turn_mode") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (!TURN_MODES.has(payload.mode)) return;
      state.turnMode = payload.mode;
      broadcastState();
      return;
    }

    if (payload.type === "host_player_roll") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (state.mode === "life_map") return;
      if (state.phase !== "rolling") return;
      if (!isDisplayReadyForBoard()) return;
      if (typeof payload.playerId !== "string") return;

      const targetPlayer = getPlayerById(payload.playerId);
      if (!targetPlayer || !isPlayerActiveInBoardGroup(targetPlayer.id)) return;
      rollForPlayer(targetPlayer);
      return;
    }

    if (payload.type === "display_start_game") {
      if (!["display", "host"].includes(client.role)) return;
      if (state.mode !== "board") return;
      if (state.phase === "lobby" || state.phase === "result") return;
      state.displayStartedAt = state.startedAt;
      broadcastState();
      return;
    }

    if (payload.type === "host_player_choice") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (state.phase !== "choosing") return;
      if (typeof payload.playerId !== "string" || typeof payload.choiceId !== "string") return;

      const targetPlayer = state.players.find((player) => player.id === payload.playerId);
      if (!targetPlayer) return;
      submitChoiceForPlayer(targetPlayer, payload.choiceId, "host");
      return;
    }

    if (payload.type === "display_player_choice") {
      if (client.role !== "display") return;
      if (state.mode === "life_map") return;
      if (state.phase !== "choosing") return;
      if (typeof payload.playerId !== "string" || typeof payload.choiceId !== "string") return;

      const targetPlayer = getPlayerById(payload.playerId);
      if (!targetPlayer) return;
      submitChoiceForPlayer(targetPlayer, payload.choiceId, "display");
      return;
    }

    if (payload.type === "display_skip_group_result") {
      if (!["display", "host"].includes(client.role)) return;
      skipGroupResultAdvance();
      return;
    }

    if (payload.type === "continue_year_recap") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (state.mode === "life_map") return;
      if (state.phase !== "year_recap") return;
      presentYearAnchorEvent(state.currentRound);
      return;
    }

    // ─── host_force_advance_choices (master feature: simultaneous mode) ──
    if (payload.type === "host_force_advance_choices") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (state.mode !== "life_map" || state.phase !== "choosing") return;
      if (state.currentChoiceMode !== "simultaneous") return;

      const firstChoiceId = state.availableChoiceIds[0];
      if (!firstChoiceId) return;

      const activePlayerIds = state.players.filter((p) => p.online).map((p) => p.id);
      for (const playerId of activePlayerIds) {
        if (!state.pendingLifeChoices[playerId]) {
          const player = state.players.find((p) => p.id === playerId);
          if (player) submitChoiceForPlayer(player, firstChoiceId, "host_force");
        }
      }
      return;
    }

    // ─── host_advance_after_reveal (master feature: simultaneous mode) ───
    if (payload.type === "host_advance_after_reveal") {
      if (client.role !== "host" || client.id !== hostId) return;
      if (state.mode !== "life_map" || state.phase !== "revealed") return;
      advanceAfterReveal();
      return;
    }

    // ─── player_roll ───────────────────────────────────────────
    if (payload.type === "player_roll") {
      if (client.role !== "controller") return;
      if (state.phase !== "rolling") return;
      if (!isDisplayReadyForBoard()) return;
      if (state.turnOrder.length === 0) return;

      const currentPlayer = getPlayerById(client.id);
      if (!currentPlayer || !currentPlayer.online || !isPlayerActiveInBoardGroup(currentPlayer.id)) return;

      rollForPlayer(currentPlayer);
      return;
    }

    // ─── player_choice ─────────────────────────────────────────
    if (payload.type === "player_choice") {
      if (client.role !== "controller") return;
      if (state.phase !== "choosing") return;

      const currentPlayer = getPlayerById(client.id);
      const timelinePlayer = state.mode === "life_map"
        ? state.players.find((p) => p.id === client.id)
        : null;
      if (state.mode !== "life_map" && (!currentPlayer || !isPlayerActiveInBoardGroup(currentPlayer.id))) return;
      if (state.mode === "life_map" && !timelinePlayer) return;

      const choiceId = payload.choiceId;
      const availableIds = state.mode === "life_map"
        ? state.availableChoiceIds
        : state.availableChoiceIdsByPlayer[client.id] ?? [];
      if (!availableIds.includes(choiceId)) return;

      submitChoiceForPlayer(state.mode === "life_map" ? timelinePlayer : currentPlayer, choiceId);
      return;
    }

    // ─── request_state ─────────────────────────────────────────
    if (payload.type === "request_state") {
      sendTo(socket, { type: "state", state });
      return;
    }
  });

  socket.on("close", () => {
    const client = sockets.get(socket);
    sockets.delete(socket);
    if (!client?.id) return;

    if (client.role === "controller") {
      markOffline(client.id);
      if (state.mode !== "life_map" && state.phase === "choosing" && state.activeTurnPlayerIds.includes(client.id)) {
        tryCompleteBoardTurnGroup();
      }
      if (state.mode !== "life_map" && state.phase === "rolling" && state.activeTurnPlayerIds.includes(client.id)) {
        state.activeTurnPlayerIds = state.activeTurnPlayerIds.filter((id) => id !== client.id);
        if (state.activeTurnPlayerIds.length === 0) {
          prepareNextBoardTurnGroup();
        }
      }
      sendHostPlayerManagement();
    }

    if (client.role === "host" && client.id === hostId) {
      hostId = null;
      broadcast({
        type: "system",
        message: "ホストとの接続が切れました。ゲーム状態を保持して再接続を待ちます。",
      });
    }

    broadcastState();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Admin Endpoints (localhost only)
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
//  Static File Serving
// ═══════════════════════════════════════════════════════════════════

app.use(express.json());

// start-game.mjs がCloudflare TunnelのURLをここにPOSTする
app.post("/admin/tunnel-url", (req, res) => {
  const remoteAddress = req.socket.remoteAddress ?? "";
  const isLocalRequest =
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
  if (!isLocalRequest) {
    res.status(403).json({ error: "localhost only" });
    return;
  }

  const url = req.body?.url;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    res.status(400).json({ error: "invalid url" });
    return;
  }

  publicTunnelUrl = url.replace(/\/+$/, "");
  broadcastHostUrls();
  console.log(`\n🌐 Tunnel URL set: ${publicTunnelUrl}\n`);
  res.json({ ok: true, url: publicTunnelUrl });
});

if (fs.existsSync(path.join(process.cwd(), STATIC_DIR))) {
  app.use(express.static(STATIC_DIR));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(process.cwd(), STATIC_DIR, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.send("<h1>Campus Life Game Server</h1><p>Run npm run build first.</p>");
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
  const urls = getHostUrls();
  if (urls.length > 1) {
    console.log("Also available at:");
    urls.filter((u) => !u.includes("localhost")).forEach((u) => console.log(`  ${u}`));
  }
});
