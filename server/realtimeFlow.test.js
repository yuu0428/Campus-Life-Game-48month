import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import WebSocket from "ws";

const TEST_TIMEOUT_MS = 2500;
const TURN_GROUP_RESULT_MS = 20;

function randomPort() {
  return 45000 + Math.floor(Math.random() * 10000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(t) {
  const port = randomPort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      STATIC_DIR: "__missing_static_for_tests__",
      TURN_GROUP_RESULT_MS: String(TURN_GROUP_RESULT_MS),
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
    }, TEST_TIMEOUT_MS);

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

  t.after(() => {
    child.kill();
  });

  return { port };
}

async function connectClient(t, port, joinPayload) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  socket.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()));
  });

  await once(socket, "open");
  socket.send(JSON.stringify({ type: "join", ...joinPayload }));

  const welcome = await waitForMessage(messages, (message) => message.type === "welcome");
  t.after(() => {
    socket.close();
  });

  return {
    socket,
    clientId: welcome.clientId,
    passkey: welcome.passkey,
    messages,
    send(payload) {
      socket.send(JSON.stringify(payload));
    },
    waitFor(predicate) {
      return waitForMessage(messages, predicate);
    },
  };
}

async function connectRaw(port, joinPayload) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  socket.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()));
  });

  await once(socket, "open");
  socket.send(JSON.stringify({ type: "join", ...joinPayload }));
  return {
    socket,
    messages,
    waitFor(predicate) {
      return waitForMessage(messages, predicate);
    },
  };
}

async function waitForMessage(messages, predicate) {
  const startedAt = Date.now();
  let cursor = 0;

  while (Date.now() - startedAt < TEST_TIMEOUT_MS) {
    while (cursor < messages.length) {
      const message = messages[cursor];
      cursor += 1;
      if (predicate(message)) {
        return message;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for expected WebSocket message");
}

async function startBoardGame(host, { displayStart = true } = {}) {
  host.send({ type: "start_game" });
  const started = await host.waitFor(
    (message) => message.type === "state"
      && message.state.mode === "board"
      && message.state.phase === "rolling",
  );
  if (!displayStart) return started;

  host.send({ type: "display_start_game" });
  return host.waitFor(
    (message) => message.type === "state"
      && message.state.mode === "board"
      && message.state.phase === "rolling"
      && message.state.startedAt !== null
      && message.state.displayStartedAt === message.state.startedAt,
  );
}

test("board game does not start when every registered player is offline", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const player = await connectClient(t, port, { role: "controller", name: "Aoi" });

  player.socket.close();
  await once(player.socket, "close");
  await delay(100);

  host.messages.length = 0;
  host.send({ type: "start_game" });
  await delay(100);
  host.send({ type: "request_state" });

  const stateMessage = await host.waitFor(
    (message) => message.type === "state" && message.state.phase === "lobby",
  );
  assert.equal(stateMessage.state.currentRound, 1);
  assert.equal(stateMessage.state.startedAt, null);
});

test("board game waits on the current month when everyone disconnects and resumes on reconnect", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const player = await connectClient(t, port, { role: "controller", name: "Aoi" });

  await startBoardGame(host, { displayStart: false });

  player.socket.close();
  await once(player.socket, "close");
  await delay(100);
  host.messages.length = 0;
  host.send({ type: "request_state" });

  const waitingState = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.activeTurnPlayerIds.length === 0,
  );
  assert.equal(waitingState.state.currentRound, 1);

  const restored = await connectClient(t, port, {
    role: "controller",
    name: "Aoi",
    clientId: player.clientId,
    passkey: player.passkey,
  });
  const resumedState = await restored.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 1
      && message.state.activeTurnPlayerIds.includes(player.clientId),
  );
  assert.deepEqual(resumedState.state.activeTurnPlayerIds, [player.clientId]);
});

test("controller joining during life-map play is added to the current season event", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  await connectClient(t, port, { role: "controller", name: "Aoi" });
  await connectClient(t, port, { role: "controller", name: "Ren" });

  host.send({ type: "start_life_map_game" });
  await host.waitFor((message) => message.type === "state" && message.state.mode === "life_map");

  const latePlayer = await connectClient(t, port, { role: "controller", name: "Mio" });
  const eventMessage = await latePlayer.waitFor((message) => message.type === "show_life_event");
  const stateMessage = await latePlayer.waitFor(
    (message) => message.type === "state" && message.state.lifePlayers.some((player) => player.id === latePlayer.clientId),
  );

  assert.equal(eventMessage.event.id, stateMessage.state.currentEvent.id);
  assert.equal(stateMessage.state.lifePlayerPositions[latePlayer.clientId], `${eventMessage.event.id}:hub`);
  assert.deepEqual(stateMessage.state.lifePlayerRoutes[latePlayer.clientId], []);
});

test("posted public tunnel url is sent to the host as the primary url", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const publicUrl = "https://campus-test.trycloudflare.com";

  const response = await fetch(`http://127.0.0.1:${port}/admin/tunnel-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: publicUrl }),
  });

  assert.equal(response.status, 200);

  const updatedWelcome = await host.waitFor(
    (message) => message.type === "welcome" && message.urls?.includes(publicUrl),
  );
  assert.equal(updatedWelcome.urls[0], publicUrl);
});

test("removing an unsubmitted life-map player advances once remaining players are done", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  const ren = await connectClient(t, port, { role: "controller", name: "Ren" });
  const mio = await connectClient(t, port, { role: "controller", name: "Mio" });

  host.send({ type: "start_life_map_game" });
  const eventMessage = await aoi.waitFor((message) => message.type === "show_life_event");
  const [firstChoice, secondChoice] = eventMessage.availableChoiceIds;

  aoi.send({ type: "player_choice", choiceId: firstChoice });
  ren.send({ type: "player_choice", choiceId: secondChoice });
  await host.waitFor(
    (message) => message.type === "state" && Object.keys(message.state.pendingLifeChoices).length === 2,
  );

  host.send({ type: "remove_player", playerId: mio.clientId });

  const nextSeason = await host.waitFor(
    (message) => message.type === "state" && message.state.mode === "life_map" && message.state.currentSeasonIndex === 1,
  );
  assert.equal(nextSeason.state.currentRound, 2);
  assert.equal(nextSeason.state.players.some((player) => player.id === mio.clientId), false);
});

test("life-map choices change visible stats with a net +3 effect", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  await connectClient(t, port, { role: "controller", name: "Ren" });

  host.send({ type: "start_life_map_game" });
  const eventMessage = await aoi.waitFor((message) => message.type === "show_life_event");

  aoi.send({ type: "player_choice", choiceId: eventMessage.availableChoiceIds[0] });
  const resultMessage = await aoi.waitFor((message) => message.type === "choice_result");
  const effectTotal = Object.values(resultMessage.result.effects).reduce((total, value) => total + value, 0);
  assert.equal(effectTotal, 3);
  assert.equal(resultMessage.result.effects.credits, 1);

  const stateMessage = await host.waitFor(
    (message) => message.type === "state" && message.state.pendingLifeChoices[aoi.clientId],
  );
  const updatedAoi = stateMessage.state.players.find((player) => player.id === aoi.clientId);
  assert.equal(updatedAoi.resources.credits, 1);
  assert.equal(updatedAoi.experience.work_tolerance, 2);
  assert.equal(updatedAoi.resources.time, 9);
  assert.equal(updatedAoi.experience.intellect, 2);
});

test("host can manually end board mode and show results", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  const ren = await connectClient(t, port, { role: "controller", name: "Ren" });

  await startBoardGame(host);
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.mode === "board"
      && message.state.phase === "rolling",
  );

  host.send({ type: "end_game" });

  const result = await host.waitFor((message) => message.type === "game_result");
  assert.deepEqual(
    result.results.map((entry) => entry.playerId).sort(),
    [aoi.clientId, ren.clientId].sort(),
  );
  assert.ok(result.results.every((entry) => entry.academicStatus));
  assert.ok(result.results.every((entry) => entry.lifeArchetype));
  assert.ok(result.results.every((entry) => entry.storyAward));

  const resultState = await host.waitFor(
    (message) => message.type === "state" && message.state.phase === "result",
  );
  assert.equal(resultState.state.players.length, 2);
  assert.equal(resultState.state.currentEvent, null);
});

test("board month event waits until the display start gate is acknowledged", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const display = await connectClient(t, port, { role: "display", name: "Display" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });

  const started = await startBoardGame(host, { displayStart: false });
  assert.equal(started.state.displayStartedAt, null);

  aoi.send({ type: "player_roll" });
  await delay(TURN_GROUP_RESULT_MS * 4);
  const latestState = host.messages
    .filter((message) => message.type === "state")
    .at(-1).state;
  assert.equal(latestState.phase, "rolling");
  assert.equal(latestState.currentEvent, null);

  display.send({ type: "display_start_game" });
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.displayStartedAt === message.state.startedAt,
  );

  aoi.send({ type: "player_roll" });
  const choosing = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentEvent?.id === "1",
  );
  assert.ok(choosing.state.availableChoiceIdsByPlayer?.[aoi.clientId]?.length > 0);
});

test("board choice history records intent tags for result branching", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });

  await startBoardGame(host);
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.activeTurnPlayerIds?.includes(aoi.clientId),
  );

  aoi.send({ type: "player_roll" });
  const choosing = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.availableChoiceIdsByPlayer?.[aoi.clientId]?.includes("1A"),
  );
  aoi.send({ type: "player_choice", choiceId: "1A" });

  const result = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "animating"
      && message.state.lastTurnGroupResults?.some((entry) => entry.playerId === aoi.clientId),
  );
  const player = result.state.players.find((entry) => entry.id === aoi.clientId);
  const [firstHistory] = player.choiceHistory;

  assert.ok(firstHistory.intentTags.includes("study"));
  assert.ok(player.pathScores.study > 0);
});

test("host can manually end life-map mode and show timeline results", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  const ren = await connectClient(t, port, { role: "controller", name: "Ren" });

  host.send({ type: "start_life_map_game" });
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.mode === "life_map"
      && message.state.phase === "choosing",
  );

  host.send({ type: "end_game" });

  const result = await host.waitFor((message) => message.type === "game_result");
  assert.deepEqual(
    result.results.map((entry) => entry.playerId).sort(),
    [aoi.clientId, ren.clientId].sort(),
  );
  assert.ok(result.results.every((entry) => entry.academicStatus));
  assert.ok(result.results.every((entry) => entry.lifeArchetype));

  const resultState = await host.waitFor(
    (message) => message.type === "state" && message.state.phase === "result",
  );
  assert.equal(resultState.state.players.length, 2);
});

test("board mode advances in two-player turn groups", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  const ren = await connectClient(t, port, { role: "controller", name: "Ren" });
  const mio = await connectClient(t, port, { role: "controller", name: "Mio" });
  const sora = await connectClient(t, port, { role: "controller", name: "Sora" });

  await startBoardGame(host);
  const firstGroup = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.activeTurnPlayerIds?.length === 2,
  );
  assert.deepEqual(firstGroup.state.activeTurnPlayerIds, [aoi.clientId, ren.clientId]);

  aoi.send({ type: "player_roll" });
  const aoiEvent = await aoi.waitFor((message) => message.type === "show_event");
  const renEvent = await ren.waitFor((message) => message.type === "show_event");
  assert.equal(aoiEvent.playerId, aoi.clientId);
  assert.equal(renEvent.playerId, ren.clientId);

  aoi.send({ type: "player_choice", choiceId: aoiEvent.availableChoiceIds[0] });
  const onePending = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.pendingTurnChoices?.[aoi.clientId],
  );
  assert.equal(onePending.state.activeTurnPlayerIds.includes(ren.clientId), true);
  assert.equal(onePending.state.completedTurns.includes(aoi.clientId), false);

  ren.send({ type: "player_choice", choiceId: renEvent.availableChoiceIds[1] ?? renEvent.availableChoiceIds[0] });
  const pairResult = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "animating"
      && message.state.lastTurnGroupResults?.length === 2,
  );
  assert.deepEqual(
    pairResult.state.lastTurnGroupResults.map((result) => result.playerId).sort(),
    [aoi.clientId, ren.clientId].sort(),
  );

  const secondGroup = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.activeTurnPlayerIds?.length === 2
      && message.state.activeTurnPlayerIds.includes(mio.clientId)
      && message.state.activeTurnPlayerIds.includes(sora.clientId),
  );
  assert.deepEqual(secondGroup.state.completedTurns.sort(), [aoi.clientId, ren.clientId].sort());
});

test("board mode uses a solo final group for odd player counts", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  const ren = await connectClient(t, port, { role: "controller", name: "Ren" });
  const mio = await connectClient(t, port, { role: "controller", name: "Mio" });

  await startBoardGame(host);
  const firstGroup = await host.waitFor(
    (message) => message.type === "state" && message.state.activeTurnPlayerIds?.length === 2,
  );
  assert.deepEqual(firstGroup.state.activeTurnPlayerIds, [aoi.clientId, ren.clientId]);

  aoi.send({ type: "player_roll" });
  const aoiEvent = await aoi.waitFor((message) => message.type === "show_event");
  const renEvent = await ren.waitFor((message) => message.type === "show_event");
  aoi.send({ type: "player_choice", choiceId: aoiEvent.availableChoiceIds[0] });
  ren.send({ type: "player_choice", choiceId: renEvent.availableChoiceIds[0] });

  const soloGroup = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.activeTurnPlayerIds?.length === 1
      && message.state.activeTurnPlayerIds[0] === mio.clientId,
  );
  assert.deepEqual(soloGroup.state.completedTurns.sort(), [aoi.clientId, ren.clientId].sort());
});

test("board mode never repeats a player before every online player has acted", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const players = [
    await connectClient(t, port, { role: "controller", name: "Aoi" }),
    await connectClient(t, port, { role: "controller", name: "Ren" }),
    await connectClient(t, port, { role: "controller", name: "Mio" }),
    await connectClient(t, port, { role: "controller", name: "Sora" }),
    await connectClient(t, port, { role: "controller", name: "Yui" }),
  ];

  await startBoardGame(host);

  const observedGroups = [];
  for (let groupIndex = 0; groupIndex < 3; groupIndex += 1) {
    const rolling = await host.waitFor(
      (message) => message.type === "state"
        && message.state.phase === "rolling"
        && message.state.currentRound === 1
        && message.state.activeTurnPlayerIds?.length > 0
        && !observedGroups.some((group) => group.join("|") === message.state.activeTurnPlayerIds.join("|")),
    );
    const groupIds = rolling.state.activeTurnPlayerIds;
    observedGroups.push(groupIds);

    const opener = players.find((player) => player.clientId === groupIds[0]);
    opener.send({ type: "player_roll" });
    const choosing = await host.waitFor(
      (message) => message.type === "state"
        && message.state.phase === "choosing"
        && message.state.currentRound === 1
        && groupIds.every((id) => message.state.availableChoiceIdsByPlayer?.[id]?.length > 0),
    );

    for (const playerId of groupIds) {
      const player = players.find((candidate) => candidate.clientId === playerId);
      player.send({
        type: "player_choice",
        choiceId: choosing.state.availableChoiceIdsByPlayer[playerId][0],
      });
    }
  }

  assert.deepEqual(observedGroups, [
    [players[0].clientId, players[1].clientId],
    [players[2].clientId, players[3].clientId],
    [players[4].clientId],
  ]);

  const nextRound = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 2,
  );
  assert.deepEqual(nextRound.state.activeTurnPlayerIds, [players[0].clientId, players[1].clientId]);
});

test("board mode can run a whole round as one all-player answer group", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const players = [
    await connectClient(t, port, { role: "controller", name: "Aoi" }),
    await connectClient(t, port, { role: "controller", name: "Ren" }),
    await connectClient(t, port, { role: "controller", name: "Mio" }),
    await connectClient(t, port, { role: "controller", name: "Sora" }),
    await connectClient(t, port, { role: "controller", name: "Yui" }),
  ];

  host.send({ type: "set_turn_mode", mode: "all" });
  await host.waitFor((message) => message.type === "state" && message.state.turnMode === "all");

  await startBoardGame(host);
  const firstGroup = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 1
      && message.state.activeTurnPlayerIds?.length === players.length,
  );
  assert.deepEqual(firstGroup.state.activeTurnPlayerIds, players.map((player) => player.clientId));

  players[0].send({ type: "player_roll" });
  const choosing = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && players.every((player) => message.state.availableChoiceIdsByPlayer?.[player.clientId]?.length > 0),
  );

  for (const player of players.slice(0, -1)) {
    player.send({
      type: "player_choice",
      choiceId: choosing.state.availableChoiceIdsByPlayer[player.clientId][0],
    });
  }

  const waitingForLast = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && Object.keys(message.state.pendingTurnChoices ?? {}).length === players.length - 1,
  );
  assert.equal(waitingForLast.state.completedTurns.length, 0);

  const lastPlayer = players[players.length - 1];
  lastPlayer.send({
    type: "player_choice",
    choiceId: choosing.state.availableChoiceIdsByPlayer[lastPlayer.clientId][0],
  });

  const groupResult = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "animating"
      && message.state.lastTurnGroupResults?.length === players.length,
  );
  assert.deepEqual(
    groupResult.state.lastTurnGroupResults.map((result) => result.playerId).sort(),
    players.map((player) => player.clientId).sort(),
  );

  const nextRound = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 2
      && message.state.activeTurnPlayerIds?.length === players.length,
  );
  assert.equal(nextRound.state.turnMode, "all");
});

test("display can submit board choices as a recovery fallback", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const display = await connectClient(t, port, { role: "display", name: "Display" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  const ren = await connectClient(t, port, { role: "controller", name: "Ren" });

  await startBoardGame(host);
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.activeTurnPlayerIds?.length === 2,
  );

  aoi.send({ type: "player_roll" });
  const choosing = await display.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.availableChoiceIdsByPlayer?.[aoi.clientId]?.length > 0
      && message.state.availableChoiceIdsByPlayer?.[ren.clientId]?.length > 0,
  );

  display.send({
    type: "display_player_choice",
    playerId: aoi.clientId,
    choiceId: choosing.state.availableChoiceIdsByPlayer[aoi.clientId][0],
  });
  display.send({
    type: "display_player_choice",
    playerId: ren.clientId,
    choiceId: choosing.state.availableChoiceIdsByPlayer[ren.clientId][0],
  });

  const pairResult = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "animating"
      && message.state.lastTurnGroupResults?.length === 2,
  );
  assert.deepEqual(
    pairResult.state.lastTurnGroupResults.map((result) => result.submittedBy).sort(),
    ["display", "display"],
  );
});

async function playSoloBoardRound(host, player, round, pickChoiceId) {
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === round
      && message.state.activeTurnPlayerIds?.includes(player.clientId),
  );

  player.send({ type: "player_roll" });
  const choosing = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentRound === round
      && message.state.availableChoiceIdsByPlayer?.[player.clientId]?.length > 0,
  );
  const availableIds = choosing.state.availableChoiceIdsByPlayer[player.clientId];
  const choiceId = pickChoiceId(choosing, availableIds);
  player.send({ type: "player_choice", choiceId });

  return host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "animating"
      && message.state.currentRound === round
      && message.state.lastTurnGroupResults?.some(
        (result) => result.playerId === player.clientId && result.choiceId === choiceId,
      ),
  );
}

async function createNegativeMoneyState(t) {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });

  await startBoardGame(host);

  await playSoloBoardRound(host, aoi, 1, (_choosing, availableIds) => {
    assert.ok(availableIds.includes("1B"));
    return "1B";
  });
  await playSoloBoardRound(host, aoi, 2, (_choosing, availableIds) => availableIds[0]);
  await playSoloBoardRound(host, aoi, 3, (_choosing, availableIds) => {
    assert.ok(availableIds.includes("3C"));
    return "3C";
  });
  await playSoloBoardRound(host, aoi, 4, (_choosing, availableIds) => availableIds[0]);
  const afterVacation = await playSoloBoardRound(host, aoi, 5, (_choosing, availableIds) => {
    const moneyCostChoice = availableIds.find((id) => id.includes("summer_fes"));
    assert.ok(moneyCostChoice);
    return moneyCostChoice;
  });
  const playerAfterVacation = afterVacation.state.players.find((player) => player.id === aoi.clientId);
  assert.ok(playerAfterVacation.resources.money < 0);

  await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 6,
  );

  return { host, aoi };
}

test("negative stats trigger a next-turn recovery event that can be declined for the original event", async (t) => {
  const { host, aoi } = await createNegativeMoneyState(t);

  aoi.send({ type: "player_roll" });
  const recovery = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentRound === 6
      && message.state.activeTurnEvents?.[aoi.clientId]?.id === "negative_recovery:money",
  );

  assert.ok(recovery.state.availableChoiceIdsByPlayer[aoi.clientId].includes("negative_recovery:skip"));
  aoi.send({ type: "player_choice", choiceId: "negative_recovery:skip" });

  const original = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentRound === 6
      && message.state.activeTurnEvents?.[aoi.clientId]?.id === "6"
      && !message.state.pendingTurnChoices?.[aoi.clientId],
  );
  assert.ok(original.state.availableChoiceIdsByPlayer[aoi.clientId].length > 0);
});

test("accepting a negative stat recovery restores that stat to zero with another stat cost", async (t) => {
  const { host, aoi } = await createNegativeMoneyState(t);

  aoi.send({ type: "player_roll" });
  const recovery = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentRound === 6
      && message.state.activeTurnEvents?.[aoi.clientId]?.id === "negative_recovery:money",
  );
  const playerBeforeRecovery = recovery.state.players.find((player) => player.id === aoi.clientId);
  const timeBeforeRecovery = playerBeforeRecovery.resources.time;

  aoi.send({ type: "player_choice", choiceId: "negative_recovery:money:accept" });
  const result = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "animating"
      && message.state.lastTurnGroupResults?.some(
        (entry) => entry.playerId === aoi.clientId && entry.choiceId === "negative_recovery:money:accept",
      ),
  );
  const playerAfterRecovery = result.state.players.find((player) => player.id === aoi.clientId);
  assert.equal(playerAfterRecovery.resources.money, 0);
  assert.ok(playerAfterRecovery.resources.time < timeBeforeRecovery);
});

test("accepted negative stat recovery does not repeat on the next turn while cooldown is active", async (t) => {
  const { host, aoi } = await createNegativeMoneyState(t);

  aoi.send({ type: "player_roll" });
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentRound === 6
      && message.state.activeTurnEvents?.[aoi.clientId]?.id === "negative_recovery:money",
  );
  aoi.send({ type: "player_choice", choiceId: "negative_recovery:money:accept" });
  await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "animating"
      && message.state.currentRound === 6,
  );

  const round7 = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 7,
  );
  const afterRecovery = round7.state.players.find((player) => player.id === aoi.clientId);
  assert.equal(afterRecovery.recoveryCooldowns.money > 0, true);

  aoi.send({ type: "player_roll" });
  const choosing = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentRound === 7
      && message.state.activeTurnEvents?.[aoi.clientId],
  );
  assert.notEqual(choosing.state.activeTurnEvents[aoi.clientId].id, "negative_recovery:money");
});

test("board mode pauses for year recap after the first school year", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });

  await startBoardGame(host);

  for (let round = 1; round <= 12; round += 1) {
    await host.waitFor(
      (message) => message.type === "state"
        && message.state.phase === "rolling"
        && message.state.currentRound === round,
    );
    aoi.send({ type: "player_roll" });
    const choosing = await host.waitFor(
      (message) => message.type === "state"
        && message.state.phase === "choosing"
        && message.state.currentRound === round
        && message.state.availableChoiceIdsByPlayer?.[aoi.clientId]?.length > 0,
    );
    aoi.send({
      type: "player_choice",
      choiceId: choosing.state.availableChoiceIdsByPlayer[aoi.clientId][0],
    });
  }

  const recapState = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "year_recap"
      && message.state.yearRecap?.year === 1,
  );
  const recapAoi = recapState.state.yearRecap.players.find((player) => player.playerId === aoi.clientId);
  assert.ok(recapAoi);
  assert.equal(recapAoi.credits >= 20, true);
  assert.match(recapAoi.creditStatus, /順調|少し遅れ|挽回可能|要注意/);

  host.send({ type: "continue_year_recap" });
  const anchor = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentRound === 12
      && message.state.currentEvent?.id === "year_anchor:1",
  );
  assert.ok(anchor.state.availableChoiceIdsByPlayer[aoi.clientId].includes("year_anchor:1:career"));

  aoi.send({ type: "player_choice", choiceId: "year_anchor:1:career" });
  const nextYear = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 13,
  );
  assert.equal(nextYear.state.yearRecap, null);
  const player = nextYear.state.players.find((entry) => entry.id === aoi.clientId);
  assert.equal(player.yearAnchors[0].choiceId, "year_anchor:1:career");
});

test("rejoining life-map player keeps an already selected route position", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });
  const passkey = aoi.messages.find((message) => message.type === "welcome")?.passkey;
  assert.ok(passkey);
  await connectClient(t, port, { role: "controller", name: "Ren" });

  host.send({ type: "start_life_map_game" });
  const eventMessage = await aoi.waitFor((message) => message.type === "show_life_event");
  aoi.send({ type: "player_choice", choiceId: eventMessage.availableChoiceIds[0] });

  const selectedState = await host.waitFor(
    (message) => message.type === "state" && message.state.pendingLifeChoices[aoi.clientId],
  );
  const selectedPosition = selectedState.state.lifePlayerPositions[aoi.clientId];
  assert.match(selectedPosition, /:route:/);

  aoi.socket.close();
  const restoredAoi = await connectClient(t, port, {
    role: "controller",
    name: "Aoi",
    clientId: aoi.clientId,
    passkey,
  });
  const restoredState = await restoredAoi.waitFor(
    (message) => message.type === "state" && message.state.players.some((player) => player.id === aoi.clientId && player.online),
  );

  assert.equal(restoredState.state.lifePlayerPositions[aoi.clientId], selectedPosition);
});

test("controller passkey restores a player and rejects wrong passkeys", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, {
    role: "controller",
    name: "Aoi",
    faculty: "education",
  });
  const management = await host.waitFor(
    (message) => message.type === "host_player_management"
      && message.players.some((player) => player.id === aoi.clientId && player.passkey),
  );
  const managedAoi = management.players.find((player) => player.id === aoi.clientId);
  assert.equal(managedAoi.faculty, "education");
  assert.equal(aoi.messages.some((message) => message.type === "host_player_management"), false);

  aoi.socket.close();
  await host.waitFor(
    (message) => message.type === "host_player_management"
      && message.players.some((player) => player.id === aoi.clientId && !player.online),
  );

  const rejected = await connectRaw(port, {
    role: "controller",
    name: "Aoi",
    passkey: "0000",
  });
  t.after(() => rejected.socket.close());
  const authError = await rejected.waitFor((message) => message.type === "auth_error");
  assert.match(authError.message, /一致/);

  const restored = await connectClient(t, port, {
    role: "controller",
    name: "Aoi",
    passkey: managedAoi.passkey,
  });
  assert.equal(restored.clientId, aoi.clientId);
});

test("host fallback can open a board month and submit the current player's choice", async (t) => {
  const { port } = await startServer(t);
  const host = await connectClient(t, port, { role: "host", name: "Host" });
  const aoi = await connectClient(t, port, { role: "controller", name: "Aoi" });

  await startBoardGame(host);
  host.send({ type: "set_fallback_mode", enabled: true });
  await host.waitFor((message) => message.type === "state" && message.state.fallbackMode === true);

  host.send({ type: "host_player_roll", playerId: aoi.clientId });
  const choosing = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "choosing"
      && message.state.currentEvent?.id === "1",
  );
  const choiceId = choosing.state.availableChoiceIds[0];

  host.send({ type: "host_player_choice", playerId: aoi.clientId, choiceId });
  const result = await host.waitFor(
    (message) => message.type === "choice_result"
      && message.result.playerId === aoi.clientId
      && message.result.choiceId === choiceId,
  );
  assert.equal(result.result.playerName, "Aoi");

  const nextMonth = await host.waitFor(
    (message) => message.type === "state"
      && message.state.phase === "rolling"
      && message.state.currentRound === 2,
  );
  assert.equal(nextMonth.state.completedTurns.length, 0);
});
