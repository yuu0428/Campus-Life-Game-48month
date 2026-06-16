export const INTENT_TAGS = [
  "study",
  "research",
  "social",
  "community",
  "romance",
  "career",
  "work",
  "creative",
  "adventure",
  "rest",
  "risk",
];

export const ROUTE_TAGS = [
  "job",
  "grad_school",
  "startup",
  "teaching",
  "abroad",
  "leave",
  "romance",
  "social",
  "research",
];

const INTENT_TAG_SET = new Set(INTENT_TAGS);
const ROUTE_TAG_SET = new Set(ROUTE_TAGS);

function addTag(tags, tag, allowedTags) {
  if (allowedTags.has(tag)) {
    tags.add(tag);
  }
}

function normalizeTags(tags = [], allowedTags) {
  const normalized = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    if (!allowedTags.has(tag)) continue;
    if (!normalized.includes(tag)) normalized.push(tag);
  }
  return normalized;
}

export function normalizeIntentTags(tags = []) {
  return normalizeTags(tags, INTENT_TAG_SET);
}

export function normalizeRouteTags(tags = []) {
  return normalizeTags(tags, ROUTE_TAG_SET);
}

export function normalizeOutcomeTags(tags = []) {
  const normalized = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const clean = tag.trim();
    if (!clean) continue;
    if (!normalized.includes(clean)) normalized.push(clean);
  }
  return normalized;
}

function flagEffectsFor(choice = {}) {
  return {
    ...(choice.flagEffects ?? {}),
    ...(choice.setFlags ?? {}),
    ...(choice.dynamicRandomChance?.onSuccessFlags ?? {}),
    ...(choice.dynamicRandomChance?.onFailureFlags ?? {}),
  };
}

function addIntentFallbacks(tags, choice = {}, event = {}) {
  const effects = choice.effects ?? {};
  if ((effects.credits ?? 0) > 0 || (effects.intellect ?? 0) > 0) addTag(tags, "study", INTENT_TAG_SET);
  if ((effects.connections ?? 0) > 0) addTag(tags, "social", INTENT_TAG_SET);
  if ((effects.work_tolerance ?? 0) > 0) addTag(tags, "work", INTENT_TAG_SET);
  if ((effects.action_power ?? 0) > 0) addTag(tags, "adventure", INTENT_TAG_SET);
  if ((effects.romance_exp ?? 0) > 0) addTag(tags, "romance", INTENT_TAG_SET);
  if ((effects.health ?? 0) > 0 || (effects.time ?? 0) > 0) addTag(tags, "rest", INTENT_TAG_SET);
  if ((effects.money ?? 0) > 0) addTag(tags, "work", INTENT_TAG_SET);

  const flagEffects = flagEffectsFor(choice);
  if (flagEffects.has_partner === true || flagEffects.romance_committed === true) addTag(tags, "romance", INTENT_TAG_SET);
  if (flagEffects.in_seminar === true) {
    addTag(tags, "study", INTENT_TAG_SET);
    addTag(tags, "research", INTENT_TAG_SET);
  }
  if (flagEffects.teaching_cert === true) {
    addTag(tags, "study", INTENT_TAG_SET);
    addTag(tags, "career", INTENT_TAG_SET);
  }
  if (flagEffects.studying_abroad === true || flagEffects.has_license === true) addTag(tags, "adventure", INTENT_TAG_SET);
  if (flagEffects.career_path || flagEffects.career_failed !== undefined) addTag(tags, "career", INTENT_TAG_SET);
  if (flagEffects.job_offer || flagEffects.grad_admitted || flagEffects.startup_traction) addTag(tags, "career", INTENT_TAG_SET);
  if (flagEffects.job_hunt_failed || flagEffects.grad_exam_failed || flagEffects.startup_failed) addTag(tags, "career", INTENT_TAG_SET);
  if (flagEffects.job_type) addTag(tags, "work", INTENT_TAG_SET);
  if (flagEffects.club_type) addTag(tags, flagEffects.club_type === "community" ? "community" : "social", INTENT_TAG_SET);
  if (flagEffects.housing === "dorm_share") {
    addTag(tags, "social", INTENT_TAG_SET);
    addTag(tags, "community", INTENT_TAG_SET);
  }
  if (flagEffects.housing === "alone" || flagEffects.living_alone === true) addTag(tags, "adventure", INTENT_TAG_SET);

  if (
    choice.cheatAction
    || choice.budgetMode === "failure"
    || choice.polarity === "negative"
    || event.polarity === "negative"
    || (typeof choice.badLuckDelta === "number" && choice.badLuckDelta > 0)
  ) {
    addTag(tags, "risk", INTENT_TAG_SET);
  }
}

export function deriveIntentTagsForChoice(choice = {}, event = {}) {
  const tags = new Set([
    ...normalizeIntentTags(event.intentTags),
    ...normalizeIntentTags(choice.intentTags),
  ]);
  addIntentFallbacks(tags, choice, event);
  if (tags.size === 0) addTag(tags, "rest", INTENT_TAG_SET);
  return [...tags];
}

export function deriveRouteTagsForChoice(choice = {}, event = {}) {
  const tags = new Set([
    ...normalizeRouteTags(event.routeTags),
    ...normalizeRouteTags(choice.routeTags),
  ]);
  const flagEffects = flagEffectsFor(choice);

  if (flagEffects.career_path === "standard") addTag(tags, "job", ROUTE_TAG_SET);
  if (flagEffects.career_path === "grad_school") addTag(tags, "grad_school", ROUTE_TAG_SET);
  if (flagEffects.career_path === "entrepreneur") addTag(tags, "startup", ROUTE_TAG_SET);
  if (flagEffects.career_path === "teaching" || flagEffects.teaching_cert === true) addTag(tags, "teaching", ROUTE_TAG_SET);
  if (flagEffects.job_offer || flagEffects.job_hunt_failed || flagEffects.job_type === "intern") addTag(tags, "job", ROUTE_TAG_SET);
  if (flagEffects.grad_admitted || flagEffects.grad_exam_failed) addTag(tags, "grad_school", ROUTE_TAG_SET);
  if (flagEffects.startup_traction || flagEffects.startup_failed || flagEffects.startup_closed) addTag(tags, "startup", ROUTE_TAG_SET);
  if (flagEffects.studying_abroad === true) addTag(tags, "abroad", ROUTE_TAG_SET);
  if (flagEffects.on_leave === true) addTag(tags, "leave", ROUTE_TAG_SET);
  if (flagEffects.has_partner === true || choice.cheatAction) addTag(tags, "romance", ROUTE_TAG_SET);
  if (flagEffects.in_seminar === true) addTag(tags, "research", ROUTE_TAG_SET);
  if (flagEffects.club_type) addTag(tags, "social", ROUTE_TAG_SET);

  return [...tags];
}

export function deriveOutcomeTagsForChoice(choice = {}, actualFlagEffects = {}) {
  const tags = new Set(normalizeOutcomeTags(choice.outcomeTags));
  const flagEffects = {
    ...flagEffectsFor(choice),
    ...(actualFlagEffects ?? {}),
  };

  if (flagEffects.job_offer === true) tags.add("job.offer");
  if (flagEffects.grad_admitted === true) tags.add("grad.admitted");
  if (flagEffects.startup_traction === true) tags.add("startup.traction");
  if (flagEffects.startup_closed === true) tags.add("startup.closed");
  if (flagEffects.job_hunt_failed === true) tags.add("job.failed");
  if (flagEffects.grad_exam_failed === true) tags.add("grad.failed");
  if (flagEffects.startup_failed === true) tags.add("startup.failed");
  if (flagEffects.career_unsettled === true) tags.add("career.unsettled");
  if (flagEffects.career_failed === true) tags.add("career.failed");
  if (flagEffects.teaching_cert === true) tags.add("teaching.cert");
  if (flagEffects.studying_abroad === true) tags.add("abroad.started");
  if (flagEffects.on_leave === true) tags.add("leave.started");
  if (flagEffects.has_partner === true) tags.add("romance.relationship_start");
  if (flagEffects.romance_committed === true) tags.add("romance.commitment");
  if (flagEffects.romance_restarted === true) tags.add("romance.restarted");
  if (flagEffects.cheated_before === true) tags.add("romance.cheated_before");
  if (flagEffects.cheating === true) tags.add("romance.cheating_current");
  if (flagEffects.breakup === true) tags.add("romance.breakup");
  if (choice.cheatAction) tags.add("romance.cheating_risk");

  return [...tags];
}

export function deriveBudgetModeForChoice(choice = {}, event = {}) {
  if (choice.budgetMode) return choice.budgetMode;
  if (event.budgetMode) return event.budgetMode;
  if (choice.cheatAction || choice.polarity === "negative") return "failure";
  if (choice.preserveEffects) return "story_only";
  return "balanced_choice";
}

export function deriveIntentTagsForEvent(event = {}) {
  const tags = new Set(normalizeIntentTags(event.intentTags));
  for (const choice of event.choices ?? []) {
    for (const tag of deriveIntentTagsForChoice(choice, event)) {
      tags.add(tag);
    }
  }
  return [...tags];
}
