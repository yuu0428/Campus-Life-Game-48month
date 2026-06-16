import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { BOARD, MAIN_TRACK_ORDER } from "./board.js";
import {
  EFFECT_BUDGET_GATED_TOTAL,
  EFFECT_BUDGET_NORMAL_TOTAL,
  getChoiceEffectBudgetOutcomes,
  getEffectBudgetTarget,
  normalizeChoiceEffectBudget,
  sumEffectValues,
} from "./effectBudget.js";
import { EVENTS, RANDOM_POOL, REFLECTION_GUIDE, THRESHOLD_EVENTS, VACATION_POOL } from "./events.js";
import { determineEnding } from "./endings.js";
import { writeSessionLog } from "./sessionLogger.js";

const DEFAULT_FLAGS = {
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

const RAW_BUDGET_MODES = new Set(["failure", "crisis_recovery", "story_only"]);

function collectChoices(event) {
  return [
    ...(event.choices ?? []),
    ...(event.conditionalVariants ?? []).flatMap((variant) => variant.choices ?? []),
  ];
}

function collectBudgetedMainChoices() {
  const entries = [];
  for (const [eventKey, event] of Object.entries(EVENTS)) {
    for (const choice of event.choices ?? []) {
      entries.push({
        label: `${eventKey}:${choice.id}`,
        event,
        choice,
        isConditionalVariant: false,
        isThresholdEvent: false,
      });
    }
    for (const variant of event.conditionalVariants ?? []) {
      for (const choice of variant.choices ?? []) {
        entries.push({
          label: `${eventKey}:${choice.id}`,
          event,
          choice,
          isConditionalVariant: true,
          isThresholdEvent: false,
        });
      }
    }
  }
  return entries;
}

function hasRequiredFlag(condition, flag) {
  return condition?.requiredFlags?.[flag] === true;
}

function flagValueKey(flag, value) {
  return `${flag}:${JSON.stringify(value)}`;
}

function collectReachableFlagValues() {
  const reachable = new Set();
  for (const [flag, value] of Object.entries(DEFAULT_FLAGS)) {
    reachable.add(flagValueKey(flag, value));
  }

  const collectFlagEffects = (flagEffects) => {
    for (const [flag, value] of Object.entries(flagEffects ?? {})) {
      reachable.add(flagValueKey(flag, value));
    }
  };

  const collectChoice = (choice) => {
    collectFlagEffects(choice.flagEffects);
    collectFlagEffects(choice.setFlags);
    collectFlagEffects(choice.dynamicRandomChance?.onSuccessFlags);
    collectFlagEffects(choice.dynamicRandomChance?.onFailureFlags);
  };

  for (const eventMap of [EVENTS, VACATION_POOL, RANDOM_POOL, THRESHOLD_EVENTS]) {
    for (const event of Object.values(eventMap)) {
      for (const choice of event.choices ?? []) collectChoice(choice);
      for (const variant of event.conditionalVariants ?? []) {
        for (const choice of variant.choices ?? []) collectChoice(choice);
      }
    }
  }

  return reachable;
}

function collectFlagReachabilityProblems() {
  const reachable = collectReachableFlagValues();
  const problems = [];

  const conditionProblems = (condition, context) => {
    if (!condition) return;

    for (const [flag, value] of Object.entries(condition.requiredFlags ?? {})) {
      if (!reachable.has(flagValueKey(flag, value))) {
        problems.push(`${context} requires unreachable ${flag}=${JSON.stringify(value)}`);
      }
    }

    if (condition.requiredAnyFlags) {
      const hasReachableOption = condition.requiredAnyFlags.some((requiredFlags) => (
        Object.entries(requiredFlags).every(([flag, value]) => reachable.has(flagValueKey(flag, value)))
      ));
      if (!hasReachableOption) {
        problems.push(`${context} has no reachable requiredAnyFlags option`);
      }
    }
  };

  const eventMaps = [
    ["EVENTS", EVENTS],
    ["VACATION_POOL", VACATION_POOL],
    ["RANDOM_POOL", RANDOM_POOL],
    ["THRESHOLD_EVENTS", THRESHOLD_EVENTS],
  ];

  for (const [mapName, eventMap] of eventMaps) {
    for (const [eventKey, event] of Object.entries(eventMap)) {
      conditionProblems(event.condition, `${mapName}.${eventKey}.condition`);
      for (const choice of event.choices ?? []) {
        conditionProblems(choice.condition, `${mapName}.${eventKey}.${choice.id}.condition`);
      }
      for (const [index, variant] of (event.conditionalVariants ?? []).entries()) {
        conditionProblems(variant.condition, `${mapName}.${eventKey}.variant${index}.condition`);
        for (const choice of variant.choices ?? []) {
          conditionProblems(choice.condition, `${mapName}.${eventKey}.variant${index}.${choice.id}.condition`);
        }
      }
    }
  }

  return problems;
}

function collectSemanticPrerequisiteProblems() {
  const rules = [
    {
      flag: "has_partner",
      regex: /恋人と|恋人との|恋人がいる|浮気|別の相手に惹かれて|危ない誘い|二人で少し遠く/,
    },
    {
      flag: "has_license",
      regex: /ドライブ|車で|無灯火運転|免許を活か/,
    },
    {
      flag: "living_alone",
      regex: /家賃|一人暮らしの生活|一人暮らしの部屋|自炊/,
    },
  ];
  const eventMaps = [
    ["EVENTS", EVENTS],
    ["VACATION_POOL", VACATION_POOL],
    ["RANDOM_POOL", RANDOM_POOL],
    ["THRESHOLD_EVENTS", THRESHOLD_EVENTS],
  ];
  const problems = [];

  for (const [mapName, eventMap] of eventMaps) {
    for (const [eventKey, event] of Object.entries(eventMap)) {
      const eventText = [event.title, event.description].filter(Boolean).join(" ");
      const choiceGroups = [
        { variant: null, choices: event.choices ?? [] },
        ...(event.conditionalVariants ?? []).map((variant, index) => ({
          variant: { ...variant, index },
          choices: variant.choices ?? [],
        })),
      ];

      for (const { variant, choices } of choiceGroups) {
        for (const choice of choices) {
          const choiceText = [choice.label, choice.description].filter(Boolean).join(" ");
          for (const rule of rules) {
            if (!rule.regex.test(`${eventText} ${choiceText}`)) continue;
            if (choice.flagEffects?.[rule.flag] === true || choice.setFlags?.[rule.flag] === true) continue;
            const isRequired = hasRequiredFlag(choice.condition, rule.flag)
              || hasRequiredFlag(event.condition, rule.flag)
              || hasRequiredFlag(variant?.condition, rule.flag);
            if (!isRequired) {
              problems.push(`${mapName}.${eventKey}.${choice.id} missing ${rule.flag}`);
            }
          }
        }
      }
    }
  }

  return problems;
}

test("48-month board and main events are aligned", () => {
  const ids = Array.from({ length: 48 }, (_, index) => String(index + 1));

  assert.deepEqual(Object.keys(EVENTS), ids);
  assert.deepEqual(MAIN_TRACK_ORDER, ids);
  assert.deepEqual(Object.keys(BOARD), ids);
  assert.equal(BOARD["48"].next, null);
});

test("main events cover living alone, career, romance, faculty, and never subtract credits", () => {
  const livingAloneMonths = ["1", "6", "13"];
  for (const month of livingAloneMonths) {
    const choices = collectChoices(EVENTS[month]);
    assert.equal(
      choices.some((choice) => choice.flagEffects?.living_alone === true),
      true,
      `month ${month} should allow living_alone`,
    );
  }

  assert.equal(
    collectChoices(EVENTS["30"]).some((choice) => choice.flagEffects?.career_path),
    true,
  );
  for (const month of ["37", "38", "39"]) {
    assert.ok(EVENTS[month].conditionalVariants?.length >= 3);
  }

  const allChoices = Object.values(EVENTS).flatMap(collectChoices);
  const romanceChoiceCount = allChoices.filter(
    (choice) => choice.dynamicRandomChance || choice.cheatAction,
  ).length;
  assert.ok(romanceChoiceCount >= 5);
  assert.ok(
    allChoices.some((choice) => choice.dynamicRandomChance?.onSuccessFlags?.has_partner === true),
    "at least one successful romance choice should create a partner flag",
  );

  const facultyVariantCount = Object.values(EVENTS)
    .flatMap((event) => event.conditionalVariants ?? [])
    .filter((variant) => variant.condition?.faculty === "education" || variant.condition?.faculty === "medical")
    .length;
  assert.ok(facultyVariantCount >= 4);

  for (const choice of allChoices) {
    assert.ok((choice.effects?.credits ?? 0) >= 0, `${choice.id} subtracts credits`);
    assert.ok((choice.randomBonusEffects?.credits ?? 0) >= 0, `${choice.id} bonus subtracts credits`);
    assert.ok((choice.randomPenaltyEffects?.credits ?? 0) >= 0, `${choice.id} penalty subtracts credits`);
    assert.ok((choice.dynamicRandomChance?.onSuccess?.credits ?? 0) >= 0, `${choice.id} success subtracts credits`);
    assert.ok((choice.dynamicRandomChance?.onFailure?.credits ?? 0) >= 0, `${choice.id} failure subtracts credits`);
  }
});

test("effect budget normalization keeps board choices at +3 and gated choices at +5", () => {
  for (const entry of collectBudgetedMainChoices()) {
    const target = getEffectBudgetTarget(entry);
    const outcomes = getChoiceEffectBudgetOutcomes(entry.choice, { targetTotal: target });

    for (const outcome of outcomes) {
      if (RAW_BUDGET_MODES.has(entry.choice.budgetMode)) {
        assert.ok((outcome.effects.credits ?? 0) >= 0, `${entry.label} ${outcome.label} subtracts credits`);
        continue;
      }
      assert.equal(
        sumEffectValues(outcome.effects),
        target,
        `${entry.label} ${outcome.label} should normalize to +${target}`,
      );
      assert.ok((outcome.effects.credits ?? 0) >= 0, `${entry.label} ${outcome.label} subtracts credits`);
    }

    if (entry.isConditionalVariant || entry.choice.condition) {
      assert.equal(target, EFFECT_BUDGET_GATED_TOTAL, `${entry.label} should use the gated budget`);
    } else {
      assert.equal(target, EFFECT_BUDGET_NORMAL_TOTAL, `${entry.label} should use the normal budget`);
    }
  }
});

test("semantic prerequisite choices are gated by the matching flags", () => {
  assert.deepEqual(collectSemanticPrerequisiteProblems(), []);
});

test("flag-gated conditions are reachable from defaults or choices", () => {
  assert.deepEqual(collectFlagReachabilityProblems(), []);
});

test("threshold effects normalize to the gated budget without negative credits", () => {
  assert.ok(THRESHOLD_EVENTS["単位回収"], "credit recovery threshold event should exist");
  assert.ok(
    THRESHOLD_EVENTS["単位回収"].choices.some((choice) => (choice.effects?.credits ?? 0) > 0),
    "credit recovery event should offer credit recovery choices",
  );

  for (const [eventKey, event] of Object.entries(THRESHOLD_EVENTS)) {
    for (const choice of event.choices ?? []) {
      const normalized = normalizeChoiceEffectBudget(choice, {
        isThresholdEvent: true,
      });

      assert.equal(sumEffectValues(normalized), EFFECT_BUDGET_GATED_TOTAL, `${eventKey}:${choice.id}`);
      assert.ok((normalized.credits ?? 0) >= 0, `${eventKey}:${choice.id} subtracts credits`);
    }
  }
});

test("vacation and random pools provide the required event volume", () => {
  assert.ok(Object.keys(VACATION_POOL).length >= 10);
  assert.ok(Object.keys(RANDOM_POOL).length >= 10);
  assert.ok(Object.values(RANDOM_POOL).some((event) => event.polarity === "positive"));
  assert.ok(Object.values(RANDOM_POOL).some((event) => event.polarity === "negative"));
});

test("career failure does not override credit-based legacy ending", () => {
  const ending = determineEnding({
    id: "p1",
    name: "Aoi",
    faculty: "humanities",
    resources: { time: 10, money: 3, credits: 80, health: 10 },
    experience: {
      intellect: 1,
      connections: 1,
      work_tolerance: 1,
      action_power: 1,
      romance_exp: 1,
    },
    flags: {
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
      career_path: "standard",
      career_failed: true,
      career_unsettled: false,
      job_offer: false,
      grad_admitted: false,
      startup_traction: false,
      job_hunt_failed: true,
      grad_exam_failed: false,
      startup_failed: false,
      startup_closed: false,
      romance_committed: false,
      breakup: false,
      romance_restarted: false,
      club_type: null,
      job_type: null,
    },
    position: "48",
    online: true,
    badLuckPoints: 0,
    flagHistory: [],
    choiceHistory: [],
  });

  assert.equal(ending.id, "ryuunen");
});

test("reflection data and session log output are available", () => {
  assert.ok(REFLECTION_GUIDE.jobless);
  assert.ok(REFLECTION_GUIDE.ryuunen);

  const filePath = writeSessionLog({
    sessionId: "test-session",
    startedAt: "2026-05-17T00:00:00.000Z",
    endedAt: "2026-05-17T00:01:00.000Z",
    mode: "board",
    players: [],
    results: [],
  });
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(parsed.sessionId, "test-session");
  assert.deepEqual(parsed.results, []);
  fs.unlinkSync(filePath);
});
