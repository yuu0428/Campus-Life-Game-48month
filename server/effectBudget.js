export const EFFECT_BUDGET_NORMAL_TOTAL = 3;
export const EFFECT_BUDGET_GATED_TOTAL = 5;

const DEFAULT_FALLBACK_STAT = "credits";
const RAW_BUDGET_MODES = new Set(["failure", "crisis_recovery", "story_only"]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toEffectRecord(effects = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(effects ?? {})) {
    if (!isFiniteNumber(value) || value === 0) continue;
    if (key === "credits" && value < 0) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

export function sumEffectValues(effects = {}) {
  return Object.values(effects ?? {})
    .filter(isFiniteNumber)
    .reduce((total, value) => total + value, 0);
}

export function mergeStatEffects(...effectsList) {
  const merged = {};
  for (const effects of effectsList) {
    for (const [key, value] of Object.entries(effects ?? {})) {
      if (!isFiniteNumber(value) || value === 0) continue;
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}

function pickGrowthStat(effects, choice) {
  const positiveEntries = Object.entries(effects ?? {})
    .filter(([, value]) => isFiniteNumber(value) && value > 0)
    .sort(([, a], [, b]) => b - a);

  if (positiveEntries.length > 0) {
    return positiveEntries[0][0];
  }

  if (choice?.tone === "romance" || choice?.cheatAction) {
    return "romance_exp";
  }

  return DEFAULT_FALLBACK_STAT;
}

function normalizeTargetTotal(targetTotal) {
  if (targetTotal === EFFECT_BUDGET_GATED_TOTAL) return EFFECT_BUDGET_GATED_TOTAL;
  return EFFECT_BUDGET_NORMAL_TOTAL;
}

export function getEffectBudgetTarget({
  choice,
  event,
  isConditionalVariant = false,
  isThresholdEvent = false,
  targetTotal,
} = {}) {
  if (targetTotal !== undefined) return normalizeTargetTotal(targetTotal);
  if (choice?.effectBudgetTarget !== undefined) {
    return normalizeTargetTotal(choice.effectBudgetTarget);
  }
  if (isThresholdEvent || isConditionalVariant || choice?.condition || event?.condition) {
    return EFFECT_BUDGET_GATED_TOTAL;
  }
  return EFFECT_BUDGET_NORMAL_TOTAL;
}

export function normalizeStatEffectsToBudget(effects = {}, targetTotal = EFFECT_BUDGET_NORMAL_TOTAL, options = {}) {
  const target = normalizeTargetTotal(targetTotal);
  const normalized = toEffectRecord(effects);
  const fallbackKey = options.fallbackKey ?? DEFAULT_FALLBACK_STAT;

  let total = sumEffectValues(normalized);

  if (total > target) {
    let excess = total - target;

    while (excess > 0) {
      const reducibleEntries = Object.entries(normalized)
        .filter(([, value]) => isFiniteNumber(value) && value > 0)
        .sort(([, a], [, b]) => b - a);

      if (reducibleEntries.length === 0) break;

      for (const [key, value] of reducibleEntries) {
        const step = Math.min(value, excess);
        normalized[key] = value - step;
        excess -= step;
        if (normalized[key] === 0) {
          delete normalized[key];
        }
        if (excess === 0) break;
      }
    }

    if (excess > 0) {
      normalized[fallbackKey] = (normalized[fallbackKey] ?? 0) - excess;
    }
  }

  total = sumEffectValues(normalized);

  if (total < target) {
    const deficit = target - total;
    const growthKey = options.growthKey ?? pickGrowthStat(normalized, options.choice);
    normalized[growthKey] = (normalized[growthKey] ?? 0) + deficit;
  }

  if (normalized.credits !== undefined && normalized.credits < 0) {
    const creditDeficit = Math.abs(normalized.credits);
    delete normalized.credits;
    const growthKey = options.growthKey ?? pickGrowthStat(normalized, options.choice);
    normalized[growthKey] = (normalized[growthKey] ?? 0) + creditDeficit;
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (value === 0) {
      delete normalized[key];
    }
  }

  return normalized;
}

export function normalizeChoiceEffectBudget(choice, context = {}) {
  if (RAW_BUDGET_MODES.has(choice?.budgetMode)) {
    return toEffectRecord(choice?.effects ?? {});
  }
  const target = getEffectBudgetTarget({ ...context, choice });
  const growthKey = pickGrowthStat(choice?.effects, choice);
  return normalizeStatEffectsToBudget(choice?.effects ?? {}, target, { choice, growthKey });
}

export function normalizeChoiceEffectOutcome(choice, extraEffects = {}, context = {}) {
  const mergedEffects = mergeStatEffects(choice?.effects, extraEffects);
  if (RAW_BUDGET_MODES.has(choice?.budgetMode)) {
    return toEffectRecord(mergedEffects);
  }
  const target = getEffectBudgetTarget({ ...context, choice });
  const growthKey = pickGrowthStat(mergedEffects, choice);
  return normalizeStatEffectsToBudget(mergedEffects, target, { choice, growthKey });
}

export function getChoiceEffectBudgetOutcomes(choice, context = {}) {
  if (choice?.dynamicRandomChance) {
    return [
      {
        label: "success",
        effects: normalizeChoiceEffectOutcome(choice, choice.dynamicRandomChance.onSuccess, context),
      },
      {
        label: "failure",
        effects: normalizeChoiceEffectOutcome(choice, choice.dynamicRandomChance.onFailure, context),
      },
    ];
  }

  if (choice?.randomChance !== undefined) {
    return [
      {
        label: "bonus",
        effects: normalizeChoiceEffectOutcome(choice, choice.randomBonusEffects, context),
      },
      {
        label: "penalty",
        effects: normalizeChoiceEffectOutcome(choice, choice.randomPenaltyEffects, context),
      },
    ];
  }

  return [
    {
      label: "base",
      effects: normalizeChoiceEffectBudget(choice, context),
    },
  ];
}
