/**
 * Campus Life Game — ゲームバランス検証シミュレーター
 *
 * エージェント（Claude Code等）がペルソナJSONを生成し、
 * --personas-file で渡してシミュレーションを実行する。
 *
 * 典型的な使い方:
 *   1. エージェントがペルソナを生成して /tmp/personas.json に保存
 *   2. node scripts/simulate.mjs --runs 1000 --personas-file /tmp/personas.json
 *
 * ペルソナJSONのスキーマ (配列):
 *   [
 *     {
 *       "type": "ペルソナ名",
 *       "description": "この学生の価値観・行動パターン",
 *       "weights": {
 *         "academic":      -3〜4  // 学業への関心
 *         "stability":     -3〜4  // 安定・規則正しさ
 *         "wellbeing":     -3〜4  // 体調・精神的健康
 *         "relationships": -3〜4  // 人間関係の重視
 *         "freedom":       -3〜4  // 自分のペース・自由
 *         "challenge":     -3〜4  // 挑戦・新しいこと
 *         "career":        -3〜4  // 就職・将来キャリア
 *         "memory":        -3〜4  // 思い出・経験の蓄積
 *         "selfhood":      -3〜4  // 自己表現・アイデンティティ
 *       },
 *       "stressThresholds": {   // 低下したとき特に危機感を持つトレイト（任意、最大2つ）
 *         "wellbeing": 2        // このトレイトが2以下になると回復行動を優先
 *       }
 *     }
 *   ]
 *
 * オプション:
 *   --runs    N              シミュレーション回数 (デフォルト: 1000)
 *   --players N              1回あたりのプレイヤー数 (デフォルト: 5)
 *   --personas-file <path>   ペルソナJSONファイルのパス
 *   --temperature F          選択のぶれ幅。小さいほど価値観に忠実 (デフォルト: 2.0)
 *   --strategy               persona (デフォルト) / random / spread
 *   --verbose                各ランの詳細をstderrに出力
 *   --json                   JSON形式で出力（CI・機械読み取り用）
 */

import { readFileSync } from "node:fs";
import { TIMELINE_EVENTS } from "../server/timelineEvents.js";
import {
  createTimelinePlayer,
  applyTimelineChoice,
  generateTimelineResults,
  LIFE_TRAIT_KEYS,
} from "../server/timelineGame.js";

// ─── CLI 引数パース ─────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? def : (args[idx + 1] ?? def);
}
const hasFlag = (name) => args.includes(`--${name}`);

const RUNS            = parseInt(getArg("runs", "1000"), 10);
const PLAYERS_PER_RUN = parseInt(getArg("players", "5"), 10);
const TEMPERATURE     = parseFloat(getArg("temperature", "2.0"));
const STRATEGY        = getArg("strategy", "persona");
const PERSONAS_FILE   = getArg("personas-file", null);
const ACADEMIC_BONUS  = parseInt(getArg("academic-bonus", "0"), 10);
const PHILOSOPHY      = getArg("philosophy", "equal"); // "equal" | "realistic"
const VERBOSE         = hasFlag("verbose");
const AS_JSON         = hasFlag("json");

// ─── ペルソナ読み込み ────────────────────────────────────────────────

function loadPersonas() {
  if (PERSONAS_FILE) {
    const raw = readFileSync(PERSONAS_FILE, "utf8");
    const personas = JSON.parse(raw);
    // バリデーション & 正規化
    for (const p of personas) {
      if (!p.type || !p.weights) throw new Error(`不正なペルソナ: ${JSON.stringify(p)}`);
      for (const key of LIFE_TRAIT_KEYS) {
        if (p.weights[key] === undefined) p.weights[key] = 0;
        p.weights[key] = Math.max(-3, Math.min(4, Math.round(Number(p.weights[key]))));
      }
      p.stressThresholds ??= {};
    }
    return { personas, source: PERSONAS_FILE };
  }
  return { personas: BUILTIN_PERSONAS, source: "builtin" };
}

// ─── 組み込みペルソナ (--personas-file 未指定時のフォールバック) ────

const BUILTIN_PERSONAS = [
  {
    type: "真面目な優等生",
    description: "単位と将来を最優先。安定した生活を好む。",
    weights: { academic: 4, stability: 2, wellbeing: 1, relationships: 0, freedom: -1, challenge: 0, career: 2, memory: 0, selfhood: 1 },
    stressThresholds: { wellbeing: 3, stability: 2 },
  },
  {
    type: "社交的なムードメーカー",
    description: "友達と思い出を作ることが大事。ノリを大切にする。",
    weights: { academic: 0, stability: -1, wellbeing: 1, relationships: 4, freedom: 1, challenge: 1, career: 0, memory: 3, selfhood: 0 },
    stressThresholds: { wellbeing: 2, academic: 3 },
  },
  {
    type: "自由な一匹狼",
    description: "自分のペースで生きたい。縛られることを嫌う。",
    weights: { academic: -1, stability: -2, wellbeing: 1, relationships: -1, freedom: 4, challenge: 1, career: 0, memory: 1, selfhood: 4 },
    stressThresholds: { wellbeing: 2, academic: 2 },
  },
  {
    type: "就活ガチ勢",
    description: "将来のキャリアに全集中。インターンや資格を積極的に取る。",
    weights: { academic: 2, stability: 1, wellbeing: -1, relationships: 1, freedom: -1, challenge: 3, career: 4, memory: 0, selfhood: 0 },
    stressThresholds: { wellbeing: 1, academic: 3 },
  },
  {
    type: "自分探し中の放浪者",
    description: "何をしたいかわからないが、挑戦し続ける。",
    weights: { academic: 0, stability: -2, wellbeing: 0, relationships: 1, freedom: 3, challenge: 3, career: 0, memory: 1, selfhood: 4 },
    stressThresholds: { wellbeing: 2, academic: 2 },
  },
  {
    type: "コミュ力お化け",
    description: "人脈と挑戦を重視。無茶も厭わないタイプ。",
    weights: { academic: 0, stability: -1, wellbeing: -1, relationships: 4, freedom: 0, challenge: 3, career: 1, memory: 3, selfhood: 0 },
    stressThresholds: { wellbeing: 1, academic: 3 },
  },
  {
    type: "ほどほど生活者",
    description: "特に尖らず、バランスよく大学生活を送る。",
    weights: { academic: 1, stability: 2, wellbeing: 2, relationships: 1, freedom: 1, challenge: 1, career: 1, memory: 1, selfhood: 1 },
    stressThresholds: { wellbeing: 3, stability: 3 },
  },
];

// ─── 選択ロジック ────────────────────────────────────────────────────

function softmax(scores, temperature) {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / temperature));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

function stressBonus(choice, player, persona) {
  let bonus = 0;
  const effects = choice.effects ?? {};
  for (const [trait, threshold] of Object.entries(persona.stressThresholds ?? {})) {
    if ((player.traits[trait] ?? 6) <= threshold) {
      bonus += (effects[trait] ?? 0) * 2;
    }
  }
  return bonus;
}

function pickChoiceByPersona(event, player, persona) {
  const { choices } = event;
  if (!choices.length) return null;
  const scores = choices.map((c) => {
    const effects = c.effects ?? {};
    return LIFE_TRAIT_KEYS.reduce((s, k) => s + (persona.weights[k] ?? 0) * (effects[k] ?? 0), 0)
      + stressBonus(c, player, persona);
  });
  const probs = softmax(scores, TEMPERATURE);
  let rand = Math.random();
  for (let i = 0; i < choices.length; i++) { rand -= probs[i]; if (rand <= 0) return choices[i]; }
  return choices.at(-1);
}

// ─── 1回のシミュレーション ──────────────────────────────────────────

const PLAYER_NAMES = ["Aoi","Riku","Hana","Sora","Kai","Mio","Ren","Yuki","Hiro","Nana","Tomo","Shun","Emi","Kenji","Sakura"];

function runSimulation(runIndex, personas) {
  const n = Math.min(PLAYERS_PER_RUN, PLAYER_NAMES.length);
  const shuffled = [...personas].sort(() => Math.random() - 0.5);
  const assigned = Array.from({ length: n }, (_, i) => shuffled[i % shuffled.length]);

  let players = Array.from({ length: n }, (_, i) =>
    createTimelinePlayer(`p${i}`, PLAYER_NAMES[(runIndex * n + i) % PLAYER_NAMES.length])
  );

  // Year boundaries: events at index 3, 7, 11 are end of years 1-3; 15 is end of year 4
  const YEAR_END_INDICES = new Set([3, 7, 11, 15]);

  const choiceLog = [];
  for (let ei = 0; ei < TIMELINE_EVENTS.length; ei++) {
    const event = TIMELINE_EVENTS[ei];
    players = players.map((player, pi) => {
      let choice;
      if (STRATEGY === "random") {
        choice = event.choices[Math.floor(Math.random() * event.choices.length)];
      } else if (STRATEGY === "spread") {
        choice = event.choices[pi % event.choices.length];
      } else {
        choice = pickChoiceByPersona(event, player, assigned[pi]);
      }
      if (!choice) return player;
      choiceLog.push({ eventId: event.id, choiceId: choice.id, choiceLabel: choice.label, playerIndex: pi, personaType: assigned[pi]?.type ?? "?" });
      return applyTimelineChoice(player, event, choice, PHILOSOPHY);
    });
    // 学年ボーナス: 学年末イベント処理後にacademicを加算
    if (ACADEMIC_BONUS > 0 && YEAR_END_INDICES.has(ei)) {
      players = players.map((p) => ({
        ...p,
        traits: { ...p.traits, academic: Math.min(20, (p.traits.academic ?? 0) + ACADEMIC_BONUS) },
      }));
    }
  }
  return { results: generateTimelineResults(players), choiceLog, assignedPersonas: assigned };
}

// ─── 統計ヘルパー ────────────────────────────────────────────────────

const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const stddev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (v, t) => ((v / t) * 100).toFixed(1);
const percentile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((p / 100) * (s.length - 1))] ?? 0; };
function shannonEntropy(counts) {
  const t = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!t) return 0;
  return -Object.values(counts).filter((c) => c > 0).reduce((s, c) => s + (c / t) * Math.log2(c / t), 0);
}
const maxEntropy = (n) => n > 1 ? Math.log2(n) : 0;

// ─── choiceMode 検証 ─────────────────────────────────────────────────

function verifyChoiceModes() {
  const issues = [], count = { simultaneous: 0, sequential: 0, unset: 0 };
  for (const e of TIMELINE_EVENTS) {
    if (e.choiceMode !== undefined && !["simultaneous","sequential"].includes(e.choiceMode))
      issues.push(`${e.id}: 不明な choiceMode "${e.choiceMode}"`);
    if (!e.choices.length) issues.push(`${e.id}: 選択肢なし`);
    if (e.choiceMode === "simultaneous") count.simultaneous++;
    else if (e.choiceMode === "sequential") count.sequential++;
    else count.unset++;
  }
  return { issues, count };
}

// ─── メイン ──────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const { issues: modeIssues, count: modeCount } = verifyChoiceModes();
  const { personas, source: personaSource } = loadPersonas();

  // 集計バッファ
  const academicCounts  = {}, archetypeCounts = {}, awardCounts = {};
  const traitSamples    = Object.fromEntries(LIFE_TRAIT_KEYS.map((k) => [k, []]));
  const tagCounts       = {}, choiceCounts = {};
  const tagsPerPlayer   = [], uniqueArcPerRun = [];
  const personaStats    = Object.fromEntries(
    personas.map((p) => [p.type, { academic: {}, archetype: {}, traits: Object.fromEntries(LIFE_TRAIT_KEYS.map((k) => [k, []])), n: 0 }])
  );

  for (const ev of TIMELINE_EVENTS) {
    choiceCounts[ev.id] = Object.fromEntries(ev.choices.map((c) => [c.id, { count: 0, label: c.label }]));
  }

  let totalPlayers = 0;

  for (let i = 0; i < RUNS; i++) {
    const { results, choiceLog, assignedPersonas } = runSimulation(i, personas);
    for (const log of choiceLog) {
      if (choiceCounts[log.eventId]?.[log.choiceId]) choiceCounts[log.eventId][log.choiceId].count++;
    }
    const arcSet = new Set();
    for (let pi = 0; pi < results.length; pi++) {
      const r = results[pi], persona = assignedPersonas[pi];
      totalPlayers++;
      const ak = r.academicStatus?.title ?? "不明";
      const ek = r.lifeArchetype?.title  ?? "不明";
      const wk = r.storyAward?.title     ?? "なし";
      academicCounts[ak]  = (academicCounts[ak]  ?? 0) + 1;
      archetypeCounts[ek] = (archetypeCounts[ek] ?? 0) + 1;
      awardCounts[wk]     = (awardCounts[wk]     ?? 0) + 1;
      arcSet.add(ek);
      for (const k of LIFE_TRAIT_KEYS) traitSamples[k].push(r.traits[k] ?? 0);
      for (const tag of r.storyTags ?? []) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      tagsPerPlayer.push(r.storyTags?.length ?? 0);
      if (persona && personaStats[persona.type]) {
        const ps = personaStats[persona.type];
        ps.n++;
        ps.academic[ak]  = (ps.academic[ak]  ?? 0) + 1;
        ps.archetype[ek] = (ps.archetype[ek] ?? 0) + 1;
        for (const k of LIFE_TRAIT_KEYS) ps.traits[k].push(r.traits[k] ?? 0);
      }
      if (VERBOSE && i < 2) process.stderr.write(`[run ${i+1}] ${r.playerName} (${persona?.type}): ${ek} / ${ak}\n`);
    }
    uniqueArcPerRun.push(arcSet.size);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  // ─── JSON 出力 ──────────────────────────────────────────────────
  if (AS_JSON) {
    console.log(JSON.stringify({
      meta: { runs: RUNS, playersPerRun: PLAYERS_PER_RUN, strategy: STRATEGY, temperature: TEMPERATURE, personaSource, totalPlayers, elapsedSec: parseFloat(elapsed) },
      personas: personas.map((p) => ({ type: p.type, description: p.description, weights: p.weights })),
      choiceModeVerification: { issues: modeIssues, count: modeCount },
      academicResults: Object.fromEntries(Object.entries(academicCounts).map(([k,v]) => [k, { count: v, pct: pct(v, totalPlayers) }])),
      archetypeDistribution: Object.fromEntries(Object.entries(archetypeCounts).sort(([,a],[,b])=>b-a).map(([k,v]) => [k, { count: v, pct: pct(v, totalPlayers) }])),
      traitStats: Object.fromEntries(LIFE_TRAIT_KEYS.map((k) => [k, { mean: mean(traitSamples[k]).toFixed(2), stddev: stddev(traitSamples[k]).toFixed(2), min: Math.min(...traitSamples[k]), max: Math.max(...traitSamples[k]), p10: percentile(traitSamples[k],10), p90: percentile(traitSamples[k],90) }])),
      personaResults: Object.fromEntries(Object.entries(personaStats).map(([type,ps]) => [type, { count: ps.n, topAcademic: Object.entries(ps.academic).sort(([,a],[,b])=>b-a)[0]?.[0], topArchetype: Object.entries(ps.archetype).sort(([,a],[,b])=>b-a)[0]?.[0], traitMeans: Object.fromEntries(LIFE_TRAIT_KEYS.map((k) => [k, mean(ps.traits[k]).toFixed(2)])) }])),
      choiceCoverage: choiceCounts,
      diversity: { archetypeEntropy: shannonEntropy(archetypeCounts).toFixed(3), archetypeMaxEntropy: maxEntropy(Object.keys(archetypeCounts).length).toFixed(3), avgTagsPerPlayer: mean(tagsPerPlayer).toFixed(2), avgUniqueArcPerRun: mean(uniqueArcPerRun).toFixed(2) },
    }, null, 2));
    return;
  }

  // ─── 人間向け出力 ────────────────────────────────────────────────
  const HR = "─".repeat(58);
  console.log(`\n${"═".repeat(58)}`);
  console.log("  Campus Life Game シミュレーション結果");
  console.log(`${"═".repeat(58)}`);
  console.log(`  実行: ${RUNS.toLocaleString()}回  |  ${PLAYERS_PER_RUN}人/回  |  strategy: ${STRATEGY}  |  temp: ${TEMPERATURE}`);
  console.log(`  ペルソナ: ${personaSource}  |  総プレイヤー: ${totalPlayers.toLocaleString()}  |  ${elapsed}s`);
  console.log();

  console.log("【使用ペルソナ】");
  for (const p of personas) {
    console.log(`  ${p.type}`);
    console.log(`    ${p.description}`);
  }
  console.log();

  console.log("【choiceMode 検証】");
  console.log(`  simultaneous: ${modeCount.simultaneous}  sequential: ${modeCount.sequential}  未設定: ${modeCount.unset}`);
  console.log(modeIssues.length === 0 ? "  ✅ 問題なし" : modeIssues.map((i) => `  ⚠️  ${i}`).join("\n"));
  console.log();

  console.log("【学業結果】");
  for (const [label, count] of Object.entries(academicCounts).sort(([,a],[,b])=>b-a)) {
    console.log(`  ${label.padEnd(22)} ${pct(count,totalPlayers).padStart(5)}%  ${"█".repeat(Math.round(parseFloat(pct(count,totalPlayers))/2))}`);
  }
  console.log();

  const arcEnt = shannonEntropy(archetypeCounts);
  const arcMax = maxEntropy(Object.keys(archetypeCounts).length);
  const arcBal = arcMax > 0 ? (arcEnt / arcMax * 100).toFixed(0) : "N/A";
  console.log(`【人生アーキタイプ分布】  均等度: ${arcBal}%`);
  for (const [label, count] of Object.entries(archetypeCounts).sort(([,a],[,b])=>b-a)) {
    console.log(`  ${label.padEnd(24)} ${pct(count,totalPlayers).padStart(5)}%  ${"█".repeat(Math.round(parseFloat(pct(count,totalPlayers))/2))}`);
  }
  console.log(`  平均アーキタイプ種類数/ラン: ${mean(uniqueArcPerRun).toFixed(1)} / ${PLAYERS_PER_RUN}人`);
  console.log();

  console.log("【ペルソナ別 結果サマリー】");
  console.log(`  ${HR}`);
  for (const [type, ps] of Object.entries(personaStats)) {
    if (!ps.n) continue;
    const topAc = Object.entries(ps.academic).sort(([,a],[,b])=>b-a)[0];
    const topAr = Object.entries(ps.archetype).sort(([,a],[,b])=>b-a)[0];
    console.log(`  ${type}`);
    console.log(`    → ${topAc?.[0] ?? "?"} ${topAc ? pct(topAc[1], ps.n) : "?"}%  |  ${topAr?.[0] ?? "?"}  |  academic 平均: ${mean(ps.traits.academic).toFixed(1)}`);
  }
  console.log();

  console.log("【トレイト最終値統計】");
  console.log(`  ${"トレイト".padEnd(14)} ${"平均".padStart(5)}  ±SD   min  max  P10-P90`);
  console.log(`  ${HR}`);
  for (const k of LIFE_TRAIT_KEYS) {
    const s = traitSamples[k];
    const m = mean(s).toFixed(1);
    const flag = parseFloat(m) <= 3 ? " 🔴低" : parseFloat(m) >= 17 ? " 🟡高" : "";
    console.log(`  ${k.padEnd(14)} ${m.padStart(5)}  ±${stddev(s).toFixed(1).padEnd(4)}  ${String(Math.min(...s)).padStart(3)}  ${String(Math.max(...s)).padStart(3)}  ${percentile(s,10)}–${percentile(s,90)}${flag}`);
  }
  console.log();

  console.log("【選択肢使用率 (偏りチェック)】");
  let biasFound = false;
  for (const ev of TIMELINE_EVENTS) {
    const ec = choiceCounts[ev.id];
    const total = Object.values(ec).reduce((a, { count }) => a + count, 0);
    if (!total) continue;
    const pcts = Object.values(ec).map(({ count }) => (count / total) * 100);
    const isBiased = Math.max(...pcts) - Math.min(...pcts) > 25;
    if (isBiased) biasFound = true;
    const modeLabel = ev.choiceMode === "simultaneous" ? "一斉" : ev.choiceMode === "sequential" ? "個別" : "未設定";
    console.log(`  ${ev.label ?? ev.id} [${modeLabel}]${isBiased ? " ⚠️ 偏り" : ""}`);
    for (const { label, count } of Object.values(ec)) {
      const p = ((count / total) * 100).toFixed(1);
      console.log(`    ${label.padEnd(30)} ${p.padStart(5)}%  ${"▪".repeat(Math.round(parseFloat(p)/5))}`);
    }
  }
  if (!biasFound) console.log("  ✅ 大きな偏りなし");
  console.log();

  console.log("【ストーリータグ多様性】");
  console.log(`  プレイヤーあたり平均タグ数: ${mean(tagsPerPlayer).toFixed(1)}  (min: ${Math.min(...tagsPerPlayer)}, max: ${Math.max(...tagsPerPlayer)})`);
  for (const [tag, count] of Object.entries(tagCounts).sort(([,a],[,b])=>b-a).slice(0, 12)) {
    console.log(`    ${tag.padEnd(16)} ${pct(count,totalPlayers).padStart(5)}%`);
  }
  console.log();

  console.log("【バランス総評】");
  const arcBalNum = parseFloat(arcBal);
  console.log(arcBalNum >= 70 ? "  ✅ アーキタイプ分布は均等" : arcBalNum >= 50 ? `  🟡 アーキタイプにやや偏り (${arcBal}%)` : `  🔴 アーキタイプに大きな偏り (${arcBal}%) — 要調整`);
  console.log(modeIssues.length === 0 ? "  ✅ choiceMode 問題なし" : `  🔴 choiceMode に ${modeIssues.length} 件の問題`);
  const lowT  = LIFE_TRAIT_KEYS.filter((k) => mean(traitSamples[k]) <= 3);
  const highT = LIFE_TRAIT_KEYS.filter((k) => mean(traitSamples[k]) >= 17);
  if (lowT.length)  console.log(`  🔴 慢性的に低いトレイト: ${lowT.join(", ")}`);
  if (highT.length) console.log(`  🟡 上限張り付きトレイト: ${highT.join(", ")}`);
  if (!lowT.length && !highT.length) console.log("  ✅ トレイトのバランスに大きな問題なし");
  console.log();
  console.log(`${"═".repeat(58)}\n`);
}

main().catch((err) => {
  process.stderr.write(`シミュレーション失敗: ${err.message}\n`);
  process.exit(1);
});
