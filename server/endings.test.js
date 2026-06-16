import test from "node:test";
import assert from "node:assert/strict";

import { generateResults } from "./endings.js";

const baseFlags = {
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

function buildPlayer(overrides = {}) {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "Aoi",
    faculty: "humanities",
    resources: {
      time: 8,
      money: 8,
      credits: 128,
      health: 8,
      ...(overrides.resources ?? {}),
    },
    experience: {
      intellect: 8,
      connections: 6,
      work_tolerance: 6,
      action_power: 6,
      romance_exp: 6,
      ...(overrides.experience ?? {}),
    },
    flags: {
      ...baseFlags,
      ...(overrides.flags ?? {}),
    },
    position: "48",
    online: true,
    badLuckPoints: 0,
    flagHistory: [],
    pathScores: overrides.pathScores ?? {},
    yearAnchors: overrides.yearAnchors ?? [],
    milestones: overrides.milestones ?? [],
    choiceHistory: overrides.choiceHistory ?? [],
  };
}

function historyEntry(round, choiceLabel, intentTags, extra = {}) {
  return {
    round,
    eventId: String(round),
    eventTitle: `Event ${round}`,
    choiceId: `${round}A`,
    choiceLabel,
    effects: {},
    intentTags,
    storyTags: intentTags,
    ...extra,
  };
}

test("board results do not turn high intellect alone into the scholar life archetype", () => {
  const highIntellectOnly = buildPlayer({
    experience: {
      intellect: 10,
      connections: 4,
      work_tolerance: 4,
      action_power: 4,
      romance_exp: 4,
    },
    choiceHistory: [
      historyEntry(1, "友人と過ごす", ["social"]),
      historyEntry(2, "アルバイトを続ける", ["work"]),
      historyEntry(3, "休む", ["rest"]),
    ],
  });

  const [result] = generateResults([highIntellectOnly]);

  assert.equal(result.academicStatus.id, "graduated");
  assert.notEqual(result.lifeArchetype.id, "scholar");
  assert.notEqual(result.ending.id, "scholar");
});

test("board results use choice history to distinguish similar final stats", () => {
  const researchPlayer = buildPlayer({
    id: "research",
    name: "Research",
    choiceHistory: [
      historyEntry(20, "ゼミで研究を進める", ["study", "research"]),
      historyEntry(28, "論文を読む", ["study", "research"]),
      historyEntry(35, "卒論テーマを深める", ["study", "research"]),
      historyEntry(43, "研究発表をする", ["study", "research"]),
    ],
  });
  const romancePlayer = buildPlayer({
    id: "romance",
    name: "Romance",
    choiceHistory: [
      historyEntry(20, "恋人との時間を作る", ["romance", "social"]),
      historyEntry(28, "記念日を大事にする", ["romance"]),
      historyEntry(35, "相手と将来を話す", ["romance", "career"]),
      historyEntry(43, "二人の関係を整える", ["romance", "rest"]),
    ],
  });

  const results = generateResults([researchPlayer, romancePlayer]);
  const byId = new Map(results.map((result) => [result.playerId, result]));

  assert.equal(byId.get("research").lifeArchetype.id, "scholar");
  assert.equal(byId.get("romance").lifeArchetype.id, "romantic");
  assert.notEqual(byId.get("research").storyAward.id, byId.get("romance").storyAward.id);
});

test("year anchors alone declare intent without deciding the life archetype", () => {
  const careerAnchored = buildPlayer({
    yearAnchors: [
      { year: 1, choiceId: "year_anchor:1:career", choiceLabel: "進路を早めに見る", intentTags: ["career"] },
      { year: 2, choiceId: "year_anchor:2:career", choiceLabel: "インターンを軸にする", intentTags: ["career"] },
      { year: 3, choiceId: "year_anchor:3:career", choiceLabel: "就活を仕上げる", intentTags: ["career"] },
    ],
    choiceHistory: [
      historyEntry(8, "授業をこなす", ["study"]),
      historyEntry(16, "友人と過ごす", ["social"]),
    ],
  });

  const [result] = generateResults([careerAnchored]);

  assert.notEqual(result.lifeArchetype.id, "career_builder");
  assert.equal(result.careerOutcome.id, "career_unsettled");
  assert.match(result.summary, /進路|就活|インターン/);
});

test("romance commitments can define the life archetype without being swallowed by broad social ties", () => {
  const romanceCommitted = buildPlayer({
    flags: {
      has_partner: true,
    },
    pathScores: {
      social: 10,
      community: 2,
      romance: 5,
      study: 2,
      research: 0,
      career: 1,
      work: 1,
      creative: 0,
      adventure: 0,
      rest: 1,
      risk: 0,
    },
    yearAnchors: [
      {
        year: 2,
        choiceId: "year_anchor:2:romance",
        choiceLabel: "恋愛もちゃんと大事にする",
        intentTags: ["romance", "social"],
      },
    ],
    choiceHistory: [
      historyEntry(14, "気になる人と二人で出かける", ["romance"]),
      historyEntry(21, "関係をはっきりさせる", ["romance"]),
      historyEntry(33, "恋人との将来を話す", ["romance", "career"]),
    ],
  });

  const [result] = generateResults([romanceCommitted]);

  assert.equal(result.lifeArchetype.id, "romantic");
  assert.equal(result.storyAward.id, "romance_committed");
  assert.equal(result.relationshipOutcome.id, "dating");
});

test("relationship outcome separates current cheating from past cheating", () => {
  const currentCheating = buildPlayer({
    id: "current-cheating",
    flags: {
      has_partner: true,
      cheating: true,
      cheated_before: true,
    },
    choiceHistory: [
      historyEntry(20, "危ない誘いに乗ってしまう", ["romance", "risk"], {
        routeTags: ["romance"],
        outcomeTags: ["romance.cheating_current", "romance.cheated_before"],
        budgetMode: "failure",
      }),
    ],
  });
  const pastCheating = buildPlayer({
    id: "past-cheating",
    flags: {
      has_partner: false,
      cheating: false,
      cheated_before: true,
      breakup: true,
    },
    choiceHistory: [
      historyEntry(20, "浮気がバレて別れた", ["romance", "risk"], {
        routeTags: ["romance"],
        outcomeTags: ["romance.cheated_before", "romance.breakup"],
        budgetMode: "failure",
      }),
    ],
  });

  const byId = new Map(generateResults([currentCheating, pastCheating]).map((result) => [result.playerId, result]));

  assert.equal(byId.get("current-cheating").relationshipOutcome.id, "cheating");
  assert.equal(byId.get("past-cheating").relationshipOutcome.id, "cheated_before");
});

test("relationship outcome can show a new partner after breakup and past cheating", () => {
  const restarted = buildPlayer({
    flags: {
      has_partner: true,
      cheating: false,
      cheated_before: true,
      breakup: true,
      romance_restarted: true,
    },
    choiceHistory: [
      historyEntry(20, "別れを経験した", ["romance", "risk"], {
        routeTags: ["romance"],
        outcomeTags: ["romance.cheated_before", "romance.breakup"],
        budgetMode: "failure",
      }),
      historyEntry(43, "卒業前に思いを伝える", ["romance"], {
        routeTags: ["romance"],
        outcomeTags: ["romance.relationship_start", "romance.restarted"],
      }),
    ],
  });

  const [result] = generateResults([restarted]);

  assert.equal(result.relationshipOutcome.id, "restarted");
  assert.equal(result.storyAward.id, "romance_committed");
});

test("ex partner count can imply breakup and restarted relationship states", () => {
  const breakupOnly = buildPlayer({
    id: "breakup-only",
    flags: {
      has_partner: false,
      ex_partner_count: 1,
    },
  });
  const restartedFromCount = buildPlayer({
    id: "restarted-from-count",
    flags: {
      has_partner: true,
      ex_partner_count: 1,
    },
  });

  const byId = new Map(generateResults([breakupOnly, restartedFromCount]).map((result) => [result.playerId, result]));

  assert.equal(byId.get("breakup-only").relationshipOutcome.id, "breakup");
  assert.equal(byId.get("restarted-from-count").relationshipOutcome.id, "restarted");
});

test("career failure no longer overrides academic graduation", () => {
  const failedJobHunt = buildPlayer({
    flags: {
      career_path: "standard",
      career_failed: true,
      job_hunt_failed: true,
    },
    choiceHistory: [
      historyEntry(39, "準備不足で投げ出してしまう", ["career", "risk"], {
        routeTags: ["job"],
        outcomeTags: ["job.failed"],
        budgetMode: "failure",
      }),
    ],
  });

  const [result] = generateResults([failedJobHunt]);

  assert.equal(result.academicStatus.id, "graduated");
  assert.equal(result.academicOutcome.id, "graduated");
  assert.equal(result.careerOutcome.id, "job_hunt_failed");
  assert.equal(result.storyAward.id, "job_rebuild");
});

test("startup route has success and failure outcomes independent from generic creative", () => {
  const traction = buildPlayer({
    id: "startup-ok",
    flags: {
      career_path: "entrepreneur",
      startup_traction: true,
    },
    choiceHistory: [
      historyEntry(37, "事業計画を作る", ["career", "creative"], {
        routeTags: ["startup"],
        outcomeTags: ["startup.plan"],
      }),
      historyEntry(39, "初期顧客をつかむ", ["career", "creative"], {
        routeTags: ["startup"],
        outcomeTags: ["startup.traction", "startup.customer"],
      }),
    ],
  });
  const closed = buildPlayer({
    id: "startup-fail",
    flags: {
      career_path: "entrepreneur",
      career_failed: true,
      startup_failed: true,
      startup_closed: true,
    },
    choiceHistory: [
      historyEntry(39, "資金と実行力の不足で事業を畳む", ["career", "risk"], {
        routeTags: ["startup"],
        outcomeTags: ["startup.failed", "startup.closed"],
        budgetMode: "failure",
      }),
    ],
  });

  const byId = new Map(generateResults([traction, closed]).map((result) => [result.playerId, result]));

  assert.equal(byId.get("startup-ok").lifeArchetype.id, "startup_builder");
  assert.equal(byId.get("startup-ok").careerOutcome.id, "startup_traction");
  assert.equal(byId.get("startup-ok").storyAward.id, "startup_first_customer");
  assert.equal(byId.get("startup-fail").careerOutcome.id, "startup_failed");
  assert.equal(byId.get("startup-fail").storyAward.id, "startup_closed");
});

test("grad school failure does not become scholar without research evidence", () => {
  const gradFailed = buildPlayer({
    flags: {
      career_path: "grad_school",
      career_failed: true,
      grad_exam_failed: true,
    },
    choiceHistory: [
      historyEntry(38, "院試の厳しさを受け止める", ["career", "risk"], {
        routeTags: ["grad_school"],
        outcomeTags: ["grad.failed"],
        budgetMode: "failure",
      }),
    ],
  });

  const [result] = generateResults([gradFailed]);

  assert.equal(result.academicStatus.id, "graduated");
  assert.equal(result.careerOutcome.id, "grad_exam_failed");
  assert.notEqual(result.lifeArchetype.id, "scholar");
  assert.equal(result.storyAward.id, "grad_failed_rebuild");
});
