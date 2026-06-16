export const LIFE_TRAIT_KEYS = [
  "academic",
  "stability",
  "wellbeing",
  "relationships",
  "freedom",
  "challenge",
  "career",
  "memory",
  "selfhood",
];

const DEFAULT_TRAITS = Object.fromEntries(
  LIFE_TRAIT_KEYS.map((key) => [key, 6]),
);

const VISIBLE_STAT_BY_LIFE_TRAIT = {
  academic: "credits",
  stability: "work_tolerance",
  wellbeing: "health",
  relationships: "connections",
  freedom: "time",
  challenge: "action_power",
  career: "money",
  memory: "romance_exp",
  selfhood: "intellect",
};

const ACADEMIC_STATUSES = {
  graduated: {
    id: "graduated",
    title: "卒業",
    description: "必要な単位と手続きを終えて、大学生活をひと区切りにした。",
  },
  barely_graduated: {
    id: "barely_graduated",
    title: "ギリ卒業",
    description: "危なかったが、なんとか卒業にこぎつけた。",
  },
  on_leave_or_retained: {
    id: "on_leave_or_retained",
    title: "休学・留年",
    description: "卒業は少し先になったが、休む時間や考え直す時間を取った。",
  },
  retained: {
    id: "retained",
    title: "留年",
    description: "卒業条件には届かなかった。でも、4年間で人間関係や経験は残った。",
  },
};

const LIFE_ARCHETYPES = {
  steady_builder: {
    id: "steady_builder",
    title: "生活を整えた堅実型",
    description: "派手さよりも生活、学業、将来の足場を整え続けた。",
  },
  social_burnout: {
    id: "social_burnout",
    title: "燃え尽き型の人脈モンスター",
    description: "人とのつながりと勢いで走り抜け、睡眠と予定の余裕を削り切った。",
  },
  self_searcher: {
    id: "self_searcher",
    title: "自分探しの自由人",
    description: "制度のレールより、自分の納得と変化を優先した。",
  },
  adventurer: {
    id: "adventurer",
    title: "挑戦偏重型",
    description: "安定よりも、何かを始めることに大学生活を使った。",
  },
  social_connector: {
    id: "social_connector",
    title: "友達と先輩に強い型",
    description: "人間関係を広げ、誰かとの関わりから生活を作った。",
  },
  balanced: {
    id: "balanced",
    title: "ほどほど統合型",
    description: "極端な偏りは少ないが、そのぶん複数の軸を保った。",
  },
};

const STORY_AWARDS = {
  quietly_built_future: {
    id: "quietly_built_future",
    title: "準備を積み上げた人",
    description: "派手な出来事より、授業や生活を続けたことが残った。",
  },
  campus_legend_retained: {
    id: "campus_legend_retained",
    title: "伝説だけ残して単位を落とした人",
    description: "卒業条件は落としたが、キャンパスには確かな存在感を残した。",
  },
  left_with_selfhood: {
    id: "left_with_selfhood",
    title: "単位より自分を持って帰った人",
    description: "単位や進路は弱いが、自分が何をしたいかははっきりしてきた。",
  },
  nonlinear_beauty: {
    id: "nonlinear_beauty",
    title: "まっすぐ戻らなかった人",
    description: "予定通りには進まなかったが、人とは違う経験を持って卒業を迎えた。",
  },
  protected_blank_space: {
    id: "protected_blank_space",
    title: "休む時間を守った人",
    description: "予定を入れすぎず、自分の生活を立て直す時間に使った。",
  },
  hard_landing: {
    id: "hard_landing",
    title: "現実に着地した人",
    description: "最後は楽ではなかったが、生活の重さを知って前に進んだ。",
  },
  campus_memory_keeper: {
    id: "campus_memory_keeper",
    title: "思い出の密度で勝った人",
    description: "点数では測れない場面を、誰より多く持ち帰った。",
  },
};

function clampTrait(value) {
  return Math.max(0, Math.min(20, value));
}

function sumEffectValues(effects) {
  return Object.values(effects).reduce((total, value) => total + value, 0);
}

export function normalizeChoiceEffects(effects = {}, targetTotal = 3) {
  const normalized = {};
  for (const [key, value] of Object.entries(effects)) {
    if (!LIFE_TRAIT_KEYS.includes(key) || typeof value !== "number" || value === 0) continue;
    normalized[key] = value;
  }

  const keys = Object.keys(normalized);
  if (keys.length === 0) {
    return { academic: targetTotal };
  }

  let total = sumEffectValues(normalized);

  if (total > targetTotal) {
    let excess = total - targetTotal;
    while (excess > 0) {
      const reducibleKeys = Object.keys(normalized)
        .filter((key) => normalized[key] > 1)
        .sort((a, b) => normalized[b] - normalized[a]);
      if (reducibleKeys.length === 0) break;

      for (const key of reducibleKeys) {
        const step = Math.min(normalized[key] - 1, excess);
        normalized[key] -= step;
        excess -= step;
        if (excess === 0) break;
      }
    }

    if (excess > 0) {
      const fallbackKey = Object.keys(normalized).sort((a, b) => normalized[b] - normalized[a])[0];
      normalized[fallbackKey] -= excess;
    }
  }

  total = sumEffectValues(normalized);
  if (total < targetTotal) {
    const deficit = targetTotal - total;
    const targetKey = Object.keys(normalized)
      .filter((key) => normalized[key] > 0)
      .sort((a, b) => normalized[b] - normalized[a])[0] ?? Object.keys(normalized)[0];
    normalized[targetKey] += deficit;
  }

  for (const key of Object.keys(normalized)) {
    if (normalized[key] === 0) {
      delete normalized[key];
    }
  }

  return normalized;
}

export function getVisibleStatEffects(lifeEffects = {}) {
  const visibleEffects = {};
  for (const [lifeTrait, value] of Object.entries(lifeEffects)) {
    const statKey = VISIBLE_STAT_BY_LIFE_TRAIT[lifeTrait];
    if (!statKey) continue;
    visibleEffects[statKey] = (visibleEffects[statKey] ?? 0) + value;
  }
  return visibleEffects;
}

export function createTimelinePlayer(id, name) {
  return {
    id,
    name,
    traits: { ...DEFAULT_TRAITS },
    storyTags: [],
    history: [],
  };
}

export function getChoicePreview(choice) {
  return {
    id: choice.id,
    label: choice.label,
    tone: choice.tone,
    gain: [...(choice.preview?.gain ?? [])],
    cost: [...(choice.preview?.cost ?? [])],
    risk: choice.preview?.risk ?? "unknown",
    storyTags: [...(choice.storyTags ?? [])],
  };
}

// 学期シーズンを event.id から取得 ("year1-autumn" → "autumn")
function getSeasonFromEventId(eventId) {
  return eventId?.split("-")[1] ?? "";
}

export function applyTimelineChoice(player, seasonEvent, choice, philosophy = "equal") {
  let effects;

  if (philosophy === "realistic") {
    // 正規化なし・生値をそのまま適用。単位は増えるだけで減らない
    effects = {};
    for (const [key, value] of Object.entries(choice.effects ?? {})) {
      if (!LIFE_TRAIT_KEYS.includes(key) || typeof value !== "number" || value === 0) continue;
      effects[key] = key === "academic" ? Math.max(0, value) : value;
    }
  } else {
    // equal モード: 正規化で全選択肢の合計値を均等化
    effects = normalizeChoiceEffects(choice.effects ?? {});

    // 単位は減らない（等価体験モードでも現実と同様）
    const normalizedAcademic = effects.academic ?? 0;

    // 秋・冬は学業シーズン: 正規化後に academic が 0 以下なら +1 のフロアを与える
    // （「勉強ゼロの学期」でも大学生として多少は単位が積まれる）
    const season = getSeasonFromEventId(seasonEvent.id);
    const studySeason = season === "autumn" || season === "winter";
    const academicFloor = studySeason ? 1 : 0;
    if (normalizedAcademic !== 0) {
      effects = { ...effects, academic: Math.max(0, normalizedAcademic) };
    } else if (studySeason) {
      effects = { ...effects, academic: academicFloor };
    }
  }

  const next = {
    ...player,
    traits: { ...player.traits },
    storyTags: [...player.storyTags],
    history: [...player.history],
  };

  for (const [key, delta] of Object.entries(effects)) {
    next.traits[key] = clampTrait((next.traits[key] ?? 0) + delta);
  }

  for (const tag of choice.storyTags ?? []) {
    if (!next.storyTags.includes(tag)) {
      next.storyTags.push(tag);
    }
  }

  next.history.push({
    seasonId: seasonEvent.id,
    seasonLabel: seasonEvent.label,
    theme: seasonEvent.theme,
    choiceId: choice.id,
    choiceLabel: choice.label,
    tone: choice.tone,
    storyTags: [...(choice.storyTags ?? [])],
  });

  return next;
}

export function determineAcademicStatus(player) {
  const academic = player.traits.academic;
  const hasLeaveStory = player.storyTags.includes("休学");

  if (academic >= 16) return ACADEMIC_STATUSES.graduated;
  if (academic >= 12) return ACADEMIC_STATUSES.barely_graduated;
  if (hasLeaveStory) return ACADEMIC_STATUSES.on_leave_or_retained;
  return ACADEMIC_STATUSES.retained;
}

export function determineLifeArchetype(player) {
  const t = player.traits;

  if (t.relationships >= 14 && t.challenge >= 12 && (t.wellbeing <= 5 || t.stability <= 5)) {
    return LIFE_ARCHETYPES.social_burnout;
  }
  if (t.freedom >= 14 && t.selfhood >= 14) {
    return LIFE_ARCHETYPES.self_searcher;
  }
  if (t.academic >= 14 && t.stability >= 14) {
    return LIFE_ARCHETYPES.steady_builder;
  }
  if (t.challenge >= 15) {
    return LIFE_ARCHETYPES.adventurer;
  }
  if (t.relationships >= 14) {
    return LIFE_ARCHETYPES.social_connector;
  }
  return LIFE_ARCHETYPES.balanced;
}

export function determineStoryAward(player, academicStatus, lifeArchetype) {
  if (academicStatus.id === "retained" && lifeArchetype.id === "social_burnout") {
    return STORY_AWARDS.campus_legend_retained;
  }
  if (
    player.storyTags.includes("予定少なめ") ||
    player.storyTags.includes("休む時間") ||
    player.storyTags.includes("連絡少なめ")
  ) {
    return STORY_AWARDS.protected_blank_space;
  }
  if (
    player.storyTags.includes("別ルート") ||
    player.storyTags.includes("キャンパス残留") ||
    player.storyTags.includes("学外拠点")
  ) {
    return STORY_AWARDS.nonlinear_beauty;
  }
  if (lifeArchetype.id === "self_searcher") {
    return STORY_AWARDS.left_with_selfhood;
  }
  if (lifeArchetype.id === "steady_builder") {
    return STORY_AWARDS.quietly_built_future;
  }
  if (player.traits.memory >= 15) {
    return STORY_AWARDS.campus_memory_keeper;
  }
  return STORY_AWARDS.hard_landing;
}

export function summarizeTimelineResult(player, academicStatus, lifeArchetype, storyAward) {
  const tagText = player.storyTags.slice(0, 5).join("、") || "特に目立つ記録なし";
  return `${player.name}は${lifeArchetype.title}として、${tagText}を残した。学業上は「${academicStatus.title}」。${storyAward.description}`;
}

export function generateTimelineResults(players) {
  return players.map((player) => {
    const academicStatus = determineAcademicStatus(player);
    const lifeArchetype = determineLifeArchetype(player);
    const storyAward = determineStoryAward(player, academicStatus, lifeArchetype);
    return {
      playerId: player.id,
      playerName: player.name,
      academicStatus,
      lifeArchetype,
      storyAward,
      summary: summarizeTimelineResult(player, academicStatus, lifeArchetype, storyAward),
      traits: { ...player.traits },
      storyTags: [...player.storyTags],
      history: [...player.history],
    };
  });
}
