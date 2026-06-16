import test from "node:test";
import assert from "node:assert/strict";

import {
  createTimelinePlayer,
  generateTimelineResults,
  getVisibleStatEffects,
  getChoicePreview,
  normalizeChoiceEffects,
} from "./timelineGame.js";
import { TIMELINE_EVENTS } from "./timelineEvents.js";

test("social burnout player can be retained without collapsing into a plain ryuunen ending", () => {
  const player = createTimelinePlayer("ren", "蓮");
  player.traits.academic = 8;
  player.traits.relationships = 18;
  player.traits.challenge = 16;
  player.traits.memory = 17;
  player.traits.wellbeing = 3;
  player.traits.stability = 2;
  player.storyTags.push("サークル", "夜遊び", "入院", "金欠", "伝説");

  const [result] = generateTimelineResults([player]);

  assert.equal(result.academicStatus.id, "retained");
  assert.equal(result.lifeArchetype.id, "social_burnout");
  assert.equal(result.storyAward.id, "campus_legend_retained");
  assert.match(result.summary, /留年/);
  assert.match(result.summary, /人脈/);
  assert.equal(Object.hasOwn(result, "rank"), false);
});

test("stable academic player is described as a steady life, not only by score", () => {
  const player = createTimelinePlayer("aoi", "葵");
  player.traits.academic = 18;
  player.traits.stability = 17;
  player.traits.wellbeing = 15;
  player.traits.career = 13;
  player.traits.relationships = 8;
  player.storyTags.push("授業勢", "部活", "安全ルート", "内定");

  const [result] = generateTimelineResults([player]);

  assert.equal(result.academicStatus.id, "graduated");
  assert.equal(result.lifeArchetype.id, "steady_builder");
  assert.equal(result.storyAward.id, "quietly_built_future");
  assert.match(result.summary, /卒業/);
  assert.match(result.summary, /整え/);
  assert.match(result.summary, /^葵は生活を整えた堅実型として/);
});

test("free self-searching player is not treated as simple failure when credits are low", () => {
  const player = createTimelinePlayer("mio", "澪");
  player.traits.academic = 1;
  player.traits.freedom = 18;
  player.traits.selfhood = 18;
  player.traits.challenge = 16;
  player.traits.wellbeing = 15;
  player.storyTags.push("休学", "自分探し", "ミスコン", "自由人");

  const [result] = generateTimelineResults([player]);

  assert.equal(result.academicStatus.id, "on_leave_or_retained");
  assert.equal(result.lifeArchetype.id, "self_searcher");
  assert.equal(result.storyAward.id, "left_with_selfhood");
  assert.match(result.summary, /休学/);
  assert.match(result.summary, /自分/);
});

test("blank-space routes are awarded as a protected choice, not just inaction", () => {
  const player = createTimelinePlayer("mio-blank", "澪");
  player.traits.academic = 6;
  player.traits.freedom = 18;
  player.traits.selfhood = 17;
  player.traits.wellbeing = 18;
  player.traits.memory = 14;
  player.storyTags.push("休む", "予定少なめ", "休む時間", "一人時間");

  const [result] = generateTimelineResults([player]);

  assert.equal(result.lifeArchetype.id, "self_searcher");
  assert.equal(result.storyAward.id, "protected_blank_space");
  assert.match(result.summary, /休む時間/);
});

test("nonlinear routes can become their own beautiful story award", () => {
  const player = createTimelinePlayer("mio-route", "澪");
  player.traits.academic = 5;
  player.traits.freedom = 18;
  player.traits.selfhood = 18;
  player.traits.challenge = 14;
  player.storyTags.push("別ルート", "学外拠点", "自分探し");

  const [result] = generateTimelineResults([player]);

  assert.equal(result.storyAward.id, "nonlinear_beauty");
  assert.match(result.summary, /学業上は/);
  assert.equal(result.summary.startsWith("澪は「"), false);
});

test("choice preview exposes mood and risk without numeric effects", () => {
  const preview = getChoicePreview({
    id: "night-festival",
    label: "夜まで学祭に残る",
    tone: "社交",
    preview: {
      gain: ["思い出", "人間関係"],
      cost: ["生活リズム"],
      risk: "medium",
    },
    effects: {
      memory: 3,
      relationships: 2,
      stability: -2,
    },
    storyTags: ["学祭", "夜型"],
  });

  assert.deepEqual(preview, {
    id: "night-festival",
    label: "夜まで学祭に残る",
    tone: "社交",
    gain: ["思い出", "人間関係"],
    cost: ["生活リズム"],
    risk: "medium",
    storyTags: ["学祭", "夜型"],
  });
  assert.equal(Object.hasOwn(preview, "effects"), false);
});

test("every timeline choice has a normalized net positive effect budget", () => {
  for (const event of TIMELINE_EVENTS) {
    for (const choice of event.choices) {
      const effects = normalizeChoiceEffects(choice.effects);
      const total = Object.values(effects).reduce((sum, value) => sum + value, 0);

      assert.equal(total, 3, `${choice.id} should sum to +3`);
    }
  }
});

test("life-map effects become visible player stat changes including credits", () => {
  const lifeEffects = normalizeChoiceEffects({
    academic: 3,
    stability: 2,
    freedom: -1,
    selfhood: 1,
  });
  const visibleEffects = getVisibleStatEffects(lifeEffects);
  const total = Object.values(visibleEffects).reduce((sum, value) => sum + value, 0);

  assert.equal(total, 3);
  assert.equal(visibleEffects.credits, 1);
  assert.equal(visibleEffects.work_tolerance, 2);
  assert.equal(visibleEffects.time, -1);
  assert.equal(visibleEffects.intellect, 1);
});
