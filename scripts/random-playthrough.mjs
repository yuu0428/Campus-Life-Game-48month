#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import WebSocket from "ws";

const DEFAULT_RUNS = 100;
const DEFAULT_PLAYERS = 4;
const DEFAULT_TURN_MODE = "pair";
const DEFAULT_TIMEOUT_MS = 30000;
const PLAYER_NAMES = ["Aoi", "Ren", "Mio", "Sora", "Yui", "Haru", "Nagi", "Riko"];

function parseArgs(argv) {
  const options = {
    runs: DEFAULT_RUNS,
    players: DEFAULT_PLAYERS,
    turnMode: DEFAULT_TURN_MODE,
    seed: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    enforceAfter: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--runs" && next) {
      options.runs = Number(next);
      index += 1;
    } else if (arg === "--players" && next) {
      options.players = Number(next);
      index += 1;
    } else if (arg === "--turn-mode" && next) {
      options.turnMode = next;
      index += 1;
    } else if (arg === "--seed" && next) {
      options.seed = Number(next);
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
    } else if (arg === "--enforce-after") {
      options.enforceAfter = true;
    }
  }

  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isInteger(options.players) || options.players < 1) {
    throw new Error("--players must be a positive integer");
  }
  if (!["pair", "all"].includes(options.turnMode)) {
    throw new Error("--turn-mode must be pair or all");
  }
  if (!Number.isFinite(options.seed)) {
    throw new Error("--seed must be a number");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be an integer >= 1000");
  }

  return options;
}

function countFor(entries, key) {
  return entries.find((entry) => entry.key === key)?.count ?? 0;
}

function rate(count, total) {
  if (total === 0) return 0;
  return Number((count / total).toFixed(3));
}

function validateAfterTargets(summary) {
  const playerCount = summary.totals.playerResults;
  const choiceResultCount = summary.totals.choiceResultsSeen;
  const romanticRate = rate(countFor(summary.lifeArchetypes, "恋愛も大事にした人"), playerCount);
  const studyingAbroadRate = rate(summary.flags.studyingAbroad, playerCount);
  const onLeaveRate = rate(summary.flags.onLeave, playerCount);
  const creditRecoveryEventRate = rate(summary.totals.creditRecoveryEventsSeen, choiceResultCount);
  const failures = [];

  const checks = [
    [summary.graduationRate >= 0.9, `graduationRate ${summary.graduationRate} is below 0.9`],
    [summary.graduationRate <= 0.96, `graduationRate ${summary.graduationRate} is above 0.96`],
    [
      summary.balanceSignals.maxLifeArchetypeShare <= 0.35,
      `maxLifeArchetypeShare ${summary.balanceSignals.maxLifeArchetypeShare} is above 0.35`,
    ],
    [
      romanticRate >= 0.08,
      `romantic archetype rate ${romanticRate} is below 0.08`,
    ],
    [
      studyingAbroadRate >= 0.03,
      `studyingAbroad rate ${studyingAbroadRate} is below 0.03`,
    ],
    [
      studyingAbroadRate <= 0.1,
      `studyingAbroad rate ${studyingAbroadRate} is above 0.1`,
    ],
    [
      onLeaveRate >= 0.02,
      `onLeave rate ${onLeaveRate} is below 0.02`,
    ],
    [
      onLeaveRate <= 0.07,
      `onLeave rate ${onLeaveRate} is above 0.07`,
    ],
    [
      summary.balanceSignals.recoveryChoiceRate >= 0.03,
      `recoveryChoiceRate ${summary.balanceSignals.recoveryChoiceRate} is below 0.03`,
    ],
    [
      summary.balanceSignals.recoveryChoiceRate <= 0.09,
      `recoveryChoiceRate ${summary.balanceSignals.recoveryChoiceRate} is above 0.09`,
    ],
    [
      creditRecoveryEventRate <= 0.055,
      `creditRecoveryEventRate ${creditRecoveryEventRate} is above 0.055`,
    ],
  ];

  for (const [passed, message] of checks) {
    if (!passed) failures.push(message);
  }

  if (failures.length > 0) {
    const error = new Error(`After targets failed:\n- ${failures.join("\n- ")}`);
    error.failures = failures;
    throw error;
  }
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomPort() {
  return 46000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(port) {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      STATIC_DIR: "__missing_static_for_random_sim__",
      TURN_GROUP_RESULT_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);

    child.stdout.on("data", () => {
      if (!stdout.includes(`http://localhost:${port}`)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited early with ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });

  return {
    port,
    stop() {
      child.kill();
    },
  };
}

class WsClient {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.waiters = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
    socket.on("close", () => {
      while (this.waiters.length > 0) {
        this.waiters.shift().reject(new Error("WebSocket closed"));
      }
    });
    socket.on("error", (error) => {
      while (this.waiters.length > 0) {
        this.waiters.shift().reject(error);
      }
    });
  }

  send(payload) {
    this.socket.send(JSON.stringify(payload));
  }

  nextMessage(timeoutMs) {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, timeoutMs);

      this.waiters.push({
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const message = await this.nextMessage(Math.max(1, timeoutMs - (Date.now() - startedAt)));
      if (predicate(message)) {
        return message;
      }
    }
    throw new Error("Timed out waiting for expected message");
  }

  close() {
    this.socket.close();
  }
}

async function connectClient(port, joinPayload, timeoutMs) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const client = new WsClient(socket);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out opening WebSocket")), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  client.send({ type: "join", ...joinPayload });
  const welcome = await client.waitFor((message) => message.type === "welcome", timeoutMs);
  client.clientId = welcome.clientId;
  return client;
}

function randomItem(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

async function playOneRun({ port, runIndex, players, turnMode, rng, timeoutMs }) {
  const host = await connectClient(port, { role: "host", name: `Host ${runIndex}` }, timeoutMs);
  const controllers = [];
  for (let index = 0; index < players; index += 1) {
    const name = PLAYER_NAMES[index % PLAYER_NAMES.length] + `-${runIndex}`;
    controllers.push(await connectClient(port, { role: "controller", name }, timeoutMs));
  }

  const run = {
    index: runIndex,
    results: null,
    stateMessages: 0,
    choiceResults: 0,
    recoveryEventsSeen: 0,
    yearRecapsSeen: 0,
  };
  const rolledGroups = new Set();
  const continuedRecaps = new Set();
  const seenRecoveryKeys = new Set();

  await host.waitFor(
    (message) => message.type === "state" && message.state.players.length === players,
    timeoutMs,
  );
  host.send({ type: "set_turn_mode", mode: turnMode });
  await host.waitFor(
    (message) => message.type === "state" && message.state.turnMode === turnMode,
    timeoutMs,
  );
  host.send({ type: "start_game" });
  host.send({ type: "display_start_game" });

  const startedAt = Date.now();
  while (!run.results) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Run ${runIndex} timed out`);
    }

    const message = await host.nextMessage(timeoutMs);
    if (message.type === "choice_result") {
      run.choiceResults += 1;
      continue;
    }
    if (message.type === "game_result") {
      run.results = message.results;
      break;
    }
    if (message.type !== "state") {
      continue;
    }

    const state = message.state;
    run.stateMessages += 1;

    if (state.phase === "rolling") {
      const activeIds = state.activeTurnPlayerIds ?? [];
      const key = `${state.currentRound}:${activeIds.join(",")}`;
      if (activeIds.length > 0 && !rolledGroups.has(key)) {
        rolledGroups.add(key);
        host.send({ type: "host_player_roll", playerId: activeIds[0] });
      }
    } else if (state.phase === "choosing") {
      const activeIds = state.activeTurnPlayerIds ?? [];
      for (const playerId of activeIds) {
        if (state.pendingTurnChoices?.[playerId]) continue;
        const availableIds = state.availableChoiceIdsByPlayer?.[playerId] ?? [];
        if (availableIds.length === 0) continue;

        const event = state.activeTurnEvents?.[playerId] ?? state.currentEvent;
        if (event?.id?.startsWith("negative_recovery:")) {
          const recoveryKey = `${runIndex}:${state.currentRound}:${playerId}:${event.id}`;
          if (!seenRecoveryKeys.has(recoveryKey)) {
            seenRecoveryKeys.add(recoveryKey);
            run.recoveryEventsSeen += 1;
          }
        }

        host.send({
          type: "host_player_choice",
          playerId,
          choiceId: randomItem(availableIds, rng),
        });
      }
    } else if (state.phase === "year_recap") {
      const key = String(state.currentRound);
      if (!continuedRecaps.has(key)) {
        continuedRecaps.add(key);
        run.yearRecapsSeen += 1;
        host.send({ type: "continue_year_recap" });
      }
    }
  }

  host.send({ type: "reset_game" });
  await sleep(10);
  host.close();
  for (const controller of controllers) {
    controller.close();
  }
  await sleep(5);
  return run;
}

function addCount(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function numericSummary(values) {
  if (values.length === 0) {
    return { min: null, p10: null, median: null, mean: null, p90: null, max: null };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: Math.min(...values),
    p10: percentile(values, 0.1),
    median: percentile(values, 0.5),
    mean: Number((sum / values.length).toFixed(2)),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
  };
}

function topEntries(map, limit = 10) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function summarize(runs, options) {
  const allResults = runs.flatMap((run) => run.results ?? []);
  const endingCounts = new Map();
  const academicCounts = new Map();
  const lifeArchetypeCounts = new Map();
  const storyAwardCounts = new Map();
  const intentTagCounts = new Map();
  const eventCounts = new Map();
  const choiceCounts = new Map();
  const choiceByEventCounts = new Map();
  const flags = {
    hasPartner: 0,
    careerFailed: 0,
    cheating: 0,
    cheatedBefore: 0,
    romanceRestarted: 0,
    exPartners: 0,
    studyingAbroad: 0,
    onLeave: 0,
  };
  const credits = [];
  const scores = [];
  const health = [];
  const money = [];
  const time = [];
  const choiceHistoryLengths = [];
  const duplicateRoundPlayers = [];
  const shortHistoryPlayers = [];
  const longHistoryPlayers = [];
  let graduated = 0;
  let creditRecoveryEventsSeen = 0;

  for (const result of allResults) {
    addCount(endingCounts, result.ending?.title ?? result.ending?.id ?? "unknown");
    addCount(academicCounts, result.academicStatus?.title ?? result.academicStatus?.id ?? "unknown");
    addCount(lifeArchetypeCounts, result.lifeArchetype?.title ?? result.lifeArchetype?.id ?? "unknown");
    addCount(storyAwardCounts, result.storyAward?.title ?? result.storyAward?.id ?? "unknown");
    credits.push(result.resources?.credits ?? 0);
    scores.push(result.score ?? 0);
    health.push(result.resources?.health ?? 0);
    money.push(result.resources?.money ?? 0);
    time.push(result.resources?.time ?? 0);
    if ((result.resources?.credits ?? 0) >= 124) graduated += 1;
    if (result.flags?.has_partner) flags.hasPartner += 1;
    if (result.flags?.career_failed) flags.careerFailed += 1;
    if (result.flags?.cheating) flags.cheating += 1;
    if (result.flags?.cheated_before) flags.cheatedBefore += 1;
    if (result.flags?.romance_restarted) flags.romanceRestarted += 1;
    flags.exPartners += result.flags?.ex_partner_count ?? 0;
    if (result.flags?.studying_abroad) flags.studyingAbroad += 1;
    if (result.flags?.on_leave) flags.onLeave += 1;

    const history = result.choiceHistory ?? [];
    choiceHistoryLengths.push(history.length);
    if (history.length < 48) shortHistoryPlayers.push(`${result.playerName}:${history.length}`);
    if (history.length > 48) longHistoryPlayers.push(`${result.playerName}:${history.length}`);

    const rounds = new Set();
    for (const entry of history) {
      const roundKey = String(entry.round);
      if (rounds.has(roundKey)) {
        duplicateRoundPlayers.push(`${result.playerName}:round${entry.round}`);
      }
      rounds.add(roundKey);
      addCount(eventCounts, entry.eventTitle);
      addCount(choiceCounts, entry.choiceLabel);
      addCount(choiceByEventCounts, `${entry.eventTitle} -> ${entry.choiceLabel}`);
      if (entry.eventId === "単位回収") {
        creditRecoveryEventsSeen += 1;
      }
      for (const tag of entry.intentTags ?? []) {
        addCount(intentTagCounts, tag);
      }
    }
  }

  const playerCount = allResults.length;
  const lifeArchetypes = topEntries(lifeArchetypeCounts, 20);
  const maxLifeArchetypeShare = playerCount === 0 || lifeArchetypes.length === 0
    ? null
    : Number((lifeArchetypes[0].count / playerCount).toFixed(3));
  const recoveryChoiceRate = runs.reduce((total, run) => total + run.choiceResults, 0) === 0
    ? null
    : Number((runs.reduce((total, run) => total + run.recoveryEventsSeen, 0)
      / runs.reduce((total, run) => total + run.choiceResults, 0)).toFixed(3));
  return {
    config: {
      runs: options.runs,
      playersPerRun: options.players,
      turnMode: options.turnMode,
      seed: options.seed,
    },
    totals: {
      completedRuns: runs.length,
      playerResults: playerCount,
      choiceResultsSeen: runs.reduce((total, run) => total + run.choiceResults, 0),
      recoveryEventsSeen: runs.reduce((total, run) => total + run.recoveryEventsSeen, 0),
      creditRecoveryEventsSeen,
      yearRecapsSeen: runs.reduce((total, run) => total + run.yearRecapsSeen, 0),
    },
    endings: topEntries(endingCounts, 20),
    academicStatuses: topEntries(academicCounts, 20),
    lifeArchetypes,
    storyAwards: topEntries(storyAwardCounts, 20),
    intentTags: topEntries(intentTagCounts, 20),
    balanceSignals: {
      maxLifeArchetypeShare,
      maxLifeArchetypePass: maxLifeArchetypeShare === null ? null : maxLifeArchetypeShare <= 0.35,
      recoveryChoiceRate,
      recoveryChoiceRatePass: recoveryChoiceRate === null ? null : recoveryChoiceRate <= 0.15,
      creditRecoveryEventRate: runs.reduce((total, run) => total + run.choiceResults, 0) === 0
        ? null
        : Number((creditRecoveryEventsSeen
          / runs.reduce((total, run) => total + run.choiceResults, 0)).toFixed(3)),
      creditRecoveryEventRatePass: runs.reduce((total, run) => total + run.choiceResults, 0) === 0
        ? null
        : creditRecoveryEventsSeen / runs.reduce((total, run) => total + run.choiceResults, 0) <= 0.055,
    },
    graduationRate: playerCount === 0 ? null : Number((graduated / playerCount).toFixed(3)),
    resources: {
      credits: numericSummary(credits),
      health: numericSummary(health),
      money: numericSummary(money),
      time: numericSummary(time),
      score: numericSummary(scores),
      choiceHistoryLength: numericSummary(choiceHistoryLengths),
    },
    flags,
    topEvents: topEntries(eventCounts, 12),
    topChoices: topEntries(choiceCounts, 16),
    topEventChoices: topEntries(choiceByEventCounts, 16),
    flowAnomalies: {
      duplicateRoundPlayers: duplicateRoundPlayers.slice(0, 20),
      shortHistoryPlayers: shortHistoryPlayers.slice(0, 20),
      longHistoryPlayers: longHistoryPlayers.slice(0, 20),
      duplicateRoundCount: duplicateRoundPlayers.length,
      shortHistoryCount: shortHistoryPlayers.length,
      longHistoryCount: longHistoryPlayers.length,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rng = createRng(options.seed);
  const port = randomPort();
  const server = await startServer(port);
  const runs = [];

  try {
    for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
      runs.push(await playOneRun({ port, runIndex, rng, ...options }));
      if (runIndex % 10 === 0 || runIndex === options.runs) {
        console.error(`completed ${runIndex}/${options.runs}`);
      }
    }
  } finally {
    server.stop();
  }

  const summary = summarize(runs, options);
  if (options.enforceAfter) {
    validateAfterTargets(summary);
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
