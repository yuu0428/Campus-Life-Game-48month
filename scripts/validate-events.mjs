import { EVENTS, RANDOM_POOL, THRESHOLD_EVENTS, VACATION_POOL } from "../server/events.js";
import { BOARD } from "../server/board.js";
import {
  INTENT_TAGS,
  ROUTE_TAGS,
  deriveIntentTagsForChoice,
  normalizeOutcomeTags,
} from "../server/intentTags.js";
import {
  getChoiceEffectBudgetOutcomes,
  getEffectBudgetTarget,
  sumEffectValues,
} from "../server/effectBudget.js";

const errors = [];
const warnings = [];

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
const INTENT_TAG_SET = new Set(INTENT_TAGS);
const ROUTE_TAG_SET = new Set(ROUTE_TAGS);
const RAW_BUDGET_MODES = new Set(["failure", "crisis_recovery", "story_only"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEffects(effects, context) {
  if (!isPlainObject(effects)) {
    errors.push(`${context}: effects must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(effects)) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors.push(`${context}: effect '${key}' must be a number`);
    }
  }
}

function validateEffectBudget(choice, context, budgetContext) {
  if (RAW_BUDGET_MODES.has(choice.budgetMode)) return;
  const targetTotal = choice.effectBudgetTarget ?? budgetContext.event?.effectBudgetTarget;
  const target = getEffectBudgetTarget({ ...budgetContext, choice, targetTotal });
  const outcomes = getChoiceEffectBudgetOutcomes(choice, { ...budgetContext, targetTotal });

  for (const outcome of outcomes) {
    const total = sumEffectValues(outcome.effects);
    if (total !== target) {
      errors.push(`${context} ${outcome.label}: normalized effects must sum to +${target}, got ${total}`);
    }
    if ((outcome.effects.credits ?? 0) < 0) {
      errors.push(`${context} ${outcome.label}: normalized credits must not be negative`);
    }
  }
}

const SEMANTIC_PREREQUISITE_RULES = [
  {
    flag: "has_partner",
    regex: /恋人と|恋人との|恋人がいる|浮気|別の相手に惹かれて|危ない誘い|二人で少し遠く/,
  },
  {
    flag: "has_license",
    regex: /ドライブ|車で|免許を活か/,
  },
  {
    flag: "living_alone",
    regex: /家賃|一人暮らしの生活|一人暮らしの部屋|自炊/,
  },
];

function hasRequiredFlag(condition, flag) {
  return condition?.requiredFlags?.[flag] === true;
}

function hasConditionFlagValue(condition, flag, value) {
  return condition?.requiredFlags?.[flag] === value;
}

function requiresSemanticFlag(condition, flag) {
  if (flag === "living_alone") {
    return hasRequiredFlag(condition, "living_alone")
      || hasConditionFlagValue(condition, "housing", "alone");
  }
  return hasRequiredFlag(condition, flag);
}

function flagValueKey(flag, value) {
  return `${flag}:${JSON.stringify(value)}`;
}

function collectReachableFlagValues(eventMaps) {
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

  for (const eventMap of eventMaps) {
    for (const event of Object.values(eventMap)) {
      for (const choice of event.choices ?? []) collectChoice(choice);
      for (const variant of event.conditionalVariants ?? []) {
        for (const choice of variant.choices ?? []) collectChoice(choice);
      }
    }
  }

  return reachable;
}

const REACHABLE_FLAG_VALUES = collectReachableFlagValues([
  EVENTS,
  THRESHOLD_EVENTS,
  VACATION_POOL,
  RANDOM_POOL,
]);

function validateConditionReachability(condition, context) {
  if (!condition) return;

  for (const [flag, value] of Object.entries(condition.requiredFlags ?? {})) {
    if (!REACHABLE_FLAG_VALUES.has(flagValueKey(flag, value))) {
      errors.push(`${context}: requiredFlags '${flag}'=${JSON.stringify(value)} is not reachable`);
    }
  }

  for (const [flag, value] of Object.entries(condition.excludedFlags ?? {})) {
    if (!REACHABLE_FLAG_VALUES.has(flagValueKey(flag, value))) {
      errors.push(`${context}: excludedFlags '${flag}'=${JSON.stringify(value)} is not reachable`);
    }
  }

  if (condition.requiredAnyFlags !== undefined) {
    if (!Array.isArray(condition.requiredAnyFlags)) {
      errors.push(`${context}: requiredAnyFlags must be an array`);
      return;
    }

    const hasReachableOption = condition.requiredAnyFlags.some((requiredFlags) => (
      isPlainObject(requiredFlags)
      && Object.entries(requiredFlags).every(([flag, value]) => REACHABLE_FLAG_VALUES.has(flagValueKey(flag, value)))
    ));
    if (!hasReachableOption) {
      errors.push(`${context}: requiredAnyFlags has no reachable option`);
    }
  }
}

function validateSemanticPrerequisites(choice, event, variant, context) {
  const text = [
    event.title,
    event.description,
    choice.label,
    choice.description,
  ].filter(Boolean).join(" ");

  for (const rule of SEMANTIC_PREREQUISITE_RULES) {
    if (!rule.regex.test(text)) continue;
    if (choice.flagEffects?.[rule.flag] === true || choice.setFlags?.[rule.flag] === true) continue;
    const isRequired = requiresSemanticFlag(choice.condition, rule.flag)
      || requiresSemanticFlag(event.condition, rule.flag)
      || requiresSemanticFlag(variant?.condition, rule.flag);
    if (!isRequired) {
      errors.push(`${context}: semantic prerequisite '${rule.flag}' is mentioned but not required`);
    }
  }
}

function validateIntentTags(choice, event, context) {
  for (const tag of choice.intentTags ?? []) {
    if (!INTENT_TAG_SET.has(tag)) {
      errors.push(`${context}: intentTags contains unknown tag '${tag}'`);
    }
  }
  for (const tag of event.intentTags ?? []) {
    if (!INTENT_TAG_SET.has(tag)) {
      errors.push(`${context}: event intentTags contains unknown tag '${tag}'`);
    }
  }
}

function validateRouteAndOutcomeTags(choice, event, context) {
  for (const tag of choice.routeTags ?? []) {
    if (!ROUTE_TAG_SET.has(tag)) {
      errors.push(`${context}: routeTags contains unknown tag '${tag}'`);
    }
  }
  for (const tag of event.routeTags ?? []) {
    if (!ROUTE_TAG_SET.has(tag)) {
      errors.push(`${context}: event routeTags contains unknown tag '${tag}'`);
    }
  }
  const normalizedOutcomeTags = normalizeOutcomeTags(choice.outcomeTags ?? []);
  if (normalizedOutcomeTags.length !== (choice.outcomeTags ?? []).length) {
    errors.push(`${context}: outcomeTags must be non-empty strings`);
  }
}

function validateNoRawCreditLoss(choice, context) {
  const effectSets = [
    ["effects", choice.effects],
    ["randomBonusEffects", choice.randomBonusEffects],
    ["randomPenaltyEffects", choice.randomPenaltyEffects],
    ["dynamicRandomChance.onSuccess", choice.dynamicRandomChance?.onSuccess],
    ["dynamicRandomChance.onFailure", choice.dynamicRandomChance?.onFailure],
  ];

  for (const [label, effects] of effectSets) {
    if ((effects?.credits ?? 0) < 0) {
      errors.push(`${context} ${label}: credits must not be negative`);
    }
  }
}

function validateIntentDiversity(choices, event, context) {
  if (!Array.isArray(choices) || choices.length < 3) return;
  const tagsInChoices = new Set();
  for (const choice of choices) {
    for (const tag of deriveIntentTagsForChoice(choice, event)) {
      tagsInChoices.add(tag);
    }
  }
  if (tagsInChoices.size < 3) {
    errors.push(`${context}: choices should cover at least 3 different intent tags, got ${tagsInChoices.size}`);
  }
}

function validateChoices(choices, context, budgetContext) {
  if (!Array.isArray(choices)) {
    errors.push(`${context}: choices must be an array`);
    return;
  }

  const seenChoiceIds = new Set();
  for (let index = 0; index < choices.length; index += 1) {
    const choice = choices[index];
    const choiceContext = `${context} choice[${index}]`;

    if (!isPlainObject(choice)) {
      errors.push(`${choiceContext}: choice must be an object`);
      continue;
    }

    if (!choice.id || typeof choice.id !== "string") {
      errors.push(`${choiceContext}: missing string id`);
    } else if (seenChoiceIds.has(choice.id)) {
      errors.push(`${context}: duplicate choice id '${choice.id}'`);
    } else {
      seenChoiceIds.add(choice.id);
    }

    if (!choice.label || typeof choice.label !== "string") {
      errors.push(`${choiceContext}: missing string label`);
    }

    validateEffects(choice.effects, choiceContext);
    validateEffectBudget(choice, choiceContext, budgetContext);
    validateNoRawCreditLoss(choice, choiceContext);
    validateIntentTags(choice, budgetContext.event, choiceContext);
    validateRouteAndOutcomeTags(choice, budgetContext.event, choiceContext);
    validateConditionReachability(choice.condition, `${choiceContext} condition`);
    validateSemanticPrerequisites(choice, budgetContext.event, budgetContext.variant, choiceContext);

    if (choice.branchRoute && !BOARD[choice.branchRoute]) {
      errors.push(`${choiceContext}: branchRoute '${choice.branchRoute}' is not in BOARD`);
    }

    if (choice.randomChance !== undefined) {
      if (typeof choice.randomChance !== "number" || choice.randomChance < 0 || choice.randomChance > 1) {
        errors.push(`${choiceContext}: randomChance must be between 0 and 1`);
      }
    }

    if (choice.randomBonusEffects !== undefined) {
      validateEffects(choice.randomBonusEffects, `${choiceContext} randomBonusEffects`);
    }
    if (choice.randomPenaltyEffects !== undefined) {
      validateEffects(choice.randomPenaltyEffects, `${choiceContext} randomPenaltyEffects`);
    }
    if (choice.dynamicRandomChance !== undefined) {
      if (!isPlainObject(choice.dynamicRandomChance)) {
        errors.push(`${choiceContext}: dynamicRandomChance must be an object`);
      } else {
        if (choice.dynamicRandomChance.formula !== "romance_success") {
          errors.push(`${choiceContext}: dynamicRandomChance formula must be 'romance_success'`);
        }
        if (choice.dynamicRandomChance.onSuccess !== undefined) {
          validateEffects(choice.dynamicRandomChance.onSuccess, `${choiceContext} dynamicRandomChance.onSuccess`);
        }
        if (choice.dynamicRandomChance.onFailure !== undefined) {
          validateEffects(choice.dynamicRandomChance.onFailure, `${choiceContext} dynamicRandomChance.onFailure`);
        }
        for (const key of ["onSuccessFlags", "onFailureFlags"]) {
          if (choice.dynamicRandomChance[key] !== undefined && !isPlainObject(choice.dynamicRandomChance[key])) {
            errors.push(`${choiceContext}: dynamicRandomChance.${key} must be an object`);
          }
        }
      }
    }
  }
}

function validateEventMap(eventMap, mapName, { enforceBoardSquareMatch, isThresholdEvent }) {
  if (!isPlainObject(eventMap)) {
    errors.push(`${mapName}: event map must be an object`);
    return;
  }

  const seenEventIds = new Set();
  for (const [key, event] of Object.entries(eventMap)) {
    const context = `${mapName}['${key}']`;

    if (enforceBoardSquareMatch && !BOARD[key]) {
      warnings.push(`${context}: key is not present in BOARD`);
    }

    if (!isPlainObject(event)) {
      errors.push(`${context}: event must be an object`);
      continue;
    }

    if (!event.id || typeof event.id !== "string") {
      errors.push(`${context}: missing string id`);
    } else if (seenEventIds.has(event.id)) {
      errors.push(`${mapName}: duplicate event id '${event.id}'`);
    } else {
      seenEventIds.add(event.id);
    }

    if (!event.title || typeof event.title !== "string") {
      errors.push(`${context}: missing string title`);
    }

    if (typeof event.description !== "string") {
      errors.push(`${context}: description must be a string`);
    }

    validateConditionReachability(event.condition, `${context} condition`);
    validateIntentDiversity(event.choices, event, context);
    validateChoices(event.choices, context, { event, isThresholdEvent });

    if (event.conditionalVariants !== undefined) {
      if (!Array.isArray(event.conditionalVariants)) {
        errors.push(`${context}: conditionalVariants must be an array`);
      } else {
        for (let i = 0; i < event.conditionalVariants.length; i += 1) {
          const variant = event.conditionalVariants[i];
          const variantContext = `${context} conditionalVariants[${i}]`;
          if (!isPlainObject(variant)) {
            errors.push(`${variantContext}: variant must be an object`);
            continue;
          }
          validateConditionReachability(variant.condition, `${variantContext} condition`);
          const variantChoices = variant.choices ?? event.choices;
          validateIntentDiversity(variantChoices, event, variantContext);
          validateChoices(variantChoices, variantContext, {
            event,
            variant,
            isConditionalVariant: true,
            isThresholdEvent,
          });
        }
      }
    }
  }
}

validateEventMap(EVENTS, "EVENTS", { enforceBoardSquareMatch: true, isThresholdEvent: false });
validateEventMap(THRESHOLD_EVENTS, "THRESHOLD_EVENTS", { enforceBoardSquareMatch: false, isThresholdEvent: true });
validateEventMap(VACATION_POOL, "VACATION_POOL", { enforceBoardSquareMatch: false, isThresholdEvent: false });
validateEventMap(RANDOM_POOL, "RANDOM_POOL", { enforceBoardSquareMatch: false, isThresholdEvent: false });

if (warnings.length > 0) {
  console.warn("Warnings:");
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

if (errors.length > 0) {
  console.error("Event validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`OK: ${Object.keys(EVENTS).length} main events, ${Object.keys(THRESHOLD_EVENTS).length} threshold events.`);
