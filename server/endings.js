import { INTENT_TAGS } from "./intentTags.js";

// ─── Score Calculation ───────────────────────────────────────────
// Plain JS mirror of src/endings.ts for Node.js server

const EXPERIENCE_KEYS = [
  "intellect",
  "connections",
  "work_tolerance",
  "action_power",
  "romance_exp",
];

const EXPERIENCE_WEIGHTS = {
  intellect: 3,
  connections: 3,
  work_tolerance: 2,
  action_power: 2,
  romance_exp: 1,
};

export function calculateScore(player) {
  return calculateScoreBreakdown(player).total;
}

export function calculateScoreBreakdown(player) {
  const exp = player.experience;
  const res = player.resources;

  let experience = 0;

  // Weighted experience sum
  for (const key of EXPERIENCE_KEYS) {
    experience += exp[key] * EXPERIENCE_WEIGHTS[key];
  }

  // Resource contributions
  const health = res.health * 1;
  const money = res.money * 0.5;

  // Credit bonus / penalty (卒業要件: 124単位)
  let credits = -10;
  if (res.credits >= 140) {
    credits = 15;
  } else if (res.credits >= 124) {
    credits = 10;
  } else if (res.credits >= 100) {
    credits = 3;
  }

  return {
    experience,
    health,
    money,
    credits,
    total: experience + health + money + credits,
  };
}

// ─── Ending Data ─────────────────────────────────────────────────

const ENDINGS = {
  jobless: {
    id: "jobless",
    title: "無職エンド",
    emoji: "😶",
    description: "予定通りにはいかなかった。でも、ここで終わりではない。",
    flavorText: "進路はまだ決まっていない。少し休んでから考え直せる。",
  },
  ryuunen: {
    id: "ryuunen",
    title: "留年エンド",
    emoji: "🔄",
    description: "まだキャンパスにいる。もう1周。",
    flavorText: "足りなかった単位は、次の作戦会議の材料になる。",
  },
  therapy: {
    id: "therapy",
    title: "療養エンド",
    emoji: "🏥",
    description: "頑張りすぎた。まずは休もう。",
    flavorText: "無理を続けるより、一度休む判断をした。",
  },
  realist: {
    id: "realist",
    title: "稼ぐ現実主義者",
    emoji: "💰",
    description: "金の力を知った学生時代。投資もう始めてそう。",
    flavorText: "お金や生活のことをちゃんと見て動けるようになった。",
  },
  balanced: {
    id: "balanced",
    title: "バランス最強の理想型",
    emoji: "⭐",
    description: "何でもできる。器用貧乏とも言う。",
    flavorText: "授業、友達、生活を少しずつ守って卒業まで来た。",
  },
  void: {
    id: "void",
    title: "虚無…だが自由",
    emoji: "😴",
    description: "何もしなかった。でも後悔はない…たぶん。",
    flavorText: "何もしていないように見えても、自分のペースは守っていた。",
  },
  scholar: {
    id: "scholar",
    title: "学究の道",
    emoji: "📚",
    description: "知を追い求めた4年間。研究者か、それに近い何か。",
    flavorText: "気になったことを追い続けた結果、研究の道が見えてきた。",
  },
  popular: {
    id: "popular",
    title: "愛されキャンパス王",
    emoji: "🤝",
    description: "誰からも慕われる存在。人脈が最大の財産。",
    flavorText: "卒業後も連絡できる人がたくさん残った。",
  },
  worker: {
    id: "worker",
    title: "プロ社会人",
    emoji: "💼",
    description: "即戦力。上司が泣いて喜ぶ新人。",
    flavorText: "レポート、バイト、締切の積み重ねが社会に出る準備になった。",
  },
  adventurer: {
    id: "adventurer",
    title: "冒険者タイプ",
    emoji: "🚀",
    description: "誰もやらないことをやった。起業か、旅か、革命か。",
    flavorText: "普通の進路から少し外れたぶん、選択肢は増えた。",
  },
  romantic: {
    id: "romantic",
    title: "恋に生きた4年間",
    emoji: "💕",
    description: "恋愛経験値MAX。結婚式のスピーチが長い。",
    flavorText: "心が動いた場面の多さが、この4年間の熱量だった。",
  },
};

// ─── Ending Determination ────────────────────────────────────────

const ACADEMIC_STATUSES = {
  retained: {
    id: "retained",
    title: "卒業は持ち越し",
    emoji: "🔄",
    description: "単位が足りず、卒業はもう少し先になった。",
    flavorText: "足りない分が見えたので、次は取り返せる。",
  },
  recovery_first: {
    id: "recovery_first",
    title: "休む判断",
    emoji: "🏥",
    description: "まずは体調と生活を戻すことを優先した。",
    flavorText: "止まる判断が、次に進むための準備になった。",
  },
  graduated: {
    id: "graduated",
    title: "卒業",
    emoji: "🎓",
    description: "必要な単位を取り切り、卒業までたどり着いた。",
    flavorText: "派手ではなくても、4年間を終えた事実は強い。",
  },
};

const CAREER_OUTCOMES = {
  job_offer: {
    id: "job_offer",
    title: "就職先が決まった",
    emoji: "💼",
    description: "働く場所が決まり、卒業後の生活が見えている。",
    flavorText: "就活の積み重ねが、ちゃんと形になった。",
  },
  job_hunt_failed: {
    id: "job_hunt_failed",
    title: "就活は立て直し",
    emoji: "🧭",
    description: "就活はうまくいかなかったが、卒業後に組み直せる。",
    flavorText: "失敗は進路の失敗であって、4年間そのものの失敗ではない。",
  },
  grad_admitted: {
    id: "grad_admitted",
    title: "大学院に進む",
    emoji: "🔬",
    description: "研究を続ける進路が見えている。",
    flavorText: "問いを持っただけでなく、次の場所までつなげた。",
  },
  grad_exam_failed: {
    id: "grad_exam_failed",
    title: "院試は再設計",
    emoji: "📘",
    description: "研究への関心は残ったが、進路は組み直しになった。",
    flavorText: "院試の結果と、研究してきた時間は別の話として残る。",
  },
  startup_traction: {
    id: "startup_traction",
    title: "起業に手応えあり",
    emoji: "🚀",
    description: "小さく売る、仲間を集めるなど、事業の手応えが出た。",
    flavorText: "思いつきではなく、動いて確かめた挑戦だった。",
  },
  startup_failed: {
    id: "startup_failed",
    title: "起業は撤退",
    emoji: "🧪",
    description: "事業は畳んだが、実験した経験は残った。",
    flavorText: "撤退も、何も試さなかったこととは違う。",
  },
  career_in_progress: {
    id: "career_in_progress",
    title: "進路は進行中",
    emoji: "🧳",
    description: "まだ確定ではないが、選んだ方向に動いている。",
    flavorText: "決まり切っていない余白も、大学生活らしい終わり方だ。",
  },
  career_unsettled: {
    id: "career_unsettled",
    title: "進路保留",
    emoji: "🧭",
    description: "卒業は見えたが、進路はまだ決め切れていない。",
    flavorText: "急がず決め直す時間も、大学生活の続きにある。",
  },
};

const RELATIONSHIP_OUTCOMES = {
  restarted: {
    id: "restarted",
    title: "別れた後に再スタート",
    emoji: "🌤️",
    description: "一度関係が終わった後、新しい関係を作り直した。",
    flavorText: "別れで終わらず、次の関係に進んだ履歴が残った。",
  },
  dating_after_cheating: {
    id: "dating_after_cheating",
    title: "恋人あり・過去に浮気あり",
    emoji: "⚠️",
    description: "今は恋人がいるが、過去に関係を揺らす選択もあった。",
    flavorText: "現在の関係と過去の火種は、別々に残る。",
  },
  committed: {
    id: "committed",
    title: "関係は続いている",
    emoji: "💕",
    description: "恋人や大事な相手との関係を続けている。",
    flavorText: "いつの間にかではなく、選択の積み重ねで残った関係だ。",
  },
  dating: {
    id: "dating",
    title: "恋人がいる",
    emoji: "💞",
    description: "恋人がいる状態で卒業を迎えた。",
    flavorText: "恋愛も学生生活の一部として残った。",
  },
  cheating: {
    id: "cheating",
    title: "現在進行中の浮気",
    emoji: "⚠️",
    description: "関係を揺らす選択があり、最後まで火種が残った。",
    flavorText: "盛り上がりだけでは済まない選択もあった。",
  },
  cheated_before: {
    id: "cheated_before",
    title: "過去に浮気した",
    emoji: "⚠️",
    description: "今は続いていなくても、関係を揺らした履歴が残った。",
    flavorText: "過去の選択は、現在状態とは別に記録される。",
  },
  breakup: {
    id: "breakup",
    title: "恋愛は区切り",
    emoji: "🌧️",
    description: "恋愛に向き合った結果、別の道を選んだ。",
    flavorText: "終わった関係も、なかったことにはならない。",
  },
  single: {
    id: "single",
    title: "恋愛はこれから",
    emoji: "🌱",
    description: "恋愛が主軸ではない4年間だった。",
    flavorText: "恋人の有無だけで学生生活の濃さは決まらない。",
  },
};

const LIFE_ARCHETYPES = {
  scholar: {
    id: "scholar",
    title: "研究・学び型",
    emoji: "📚",
    description: "授業や研究を積み重ね、自分の問いを持つようになった。",
    flavorText: "知性の高さではなく、問い続けた履歴がこの結果を作った。",
  },
  campus_connector: {
    id: "campus_connector",
    title: "人間関係の中心",
    emoji: "🤝",
    description: "友人、先輩、学外のつながりが学生生活の軸になった。",
    flavorText: "困った時に名前を呼べる相手が増えた。",
  },
  romantic: {
    id: "romantic",
    title: "恋愛も大事にした人",
    emoji: "💕",
    description: "恋愛や近い関係にちゃんと時間を使った。",
    flavorText: "心が動いた選択が、4年間の記憶に残った。",
  },
  career_builder: {
    id: "career_builder",
    title: "進路を作った人",
    emoji: "💼",
    description: "バイト、インターン、就活を通して進路を早めに形にした。",
    flavorText: "進路や就活を後回しにせず、少しずつ現実にしていった。",
  },
  startup_builder: {
    id: "startup_builder",
    title: "起業・実験型",
    emoji: "🚀",
    description: "事業計画、仲間集め、販売テストを通じて、自分の道を作ろうとした。",
    flavorText: "成果の大小より、実際に試した履歴がこのタイプを作った。",
  },
  creative_runner: {
    id: "creative_runner",
    title: "制作・挑戦型",
    emoji: "🚀",
    description: "趣味、制作、旅、企画など、外へ踏み出す選択が多かった。",
    flavorText: "普通の学生生活から少しはみ出した分だけ、話せることが増えた。",
  },
  rest_keeper: {
    id: "rest_keeper",
    title: "生活を守った人",
    emoji: "🌿",
    description: "無理をしすぎず、体調や生活リズムを守りながら進んだ。",
    flavorText: "派手さよりも、続けられる状態を選んだ。",
  },
  global_challenger: {
    id: "global_challenger",
    title: "外へ踏み出した人",
    emoji: "🌏",
    description: "留学や旅行など、普段の場所から外に出る経験が軸になった。",
    flavorText: "キャンパスの外で得たものも、学生生活の一部になった。",
  },
  balanced_life: {
    id: "balanced_life",
    title: "バランス型",
    emoji: "⭐",
    description: "学業、友人、生活、進路を大きく崩さずに進めた。",
    flavorText: "突出はしなくても、ちゃんと自分の形になった。",
  },
};

const STORY_AWARDS = {
  startup_first_customer: {
    id: "startup_first_customer",
    title: "初めて手応えを得た挑戦",
    emoji: "🚀",
    description: "起業や企画を、考えるだけでなく誰かに届けるところまで進めた。",
  },
  startup_closed: {
    id: "startup_closed",
    title: "事業を畳んだ経験",
    emoji: "🧪",
    description: "うまくいかなかった挑戦を、自分で区切る経験が残った。",
  },
  grad_admitted: {
    id: "grad_admitted",
    title: "研究を次につないだ",
    emoji: "🔬",
    description: "研究や院試の準備が、次の場所につながった。",
  },
  grad_failed_rebuild: {
    id: "grad_failed_rebuild",
    title: "研究と進路を組み直した",
    emoji: "📘",
    description: "院試の結果を受けて、研究への向き合い方を考え直した。",
  },
  job_offer: {
    id: "job_offer",
    title: "働く場所を決めた",
    emoji: "💼",
    description: "就活や働く経験を積み上げ、卒業後の道を形にした。",
  },
  job_rebuild: {
    id: "job_rebuild",
    title: "進路を立て直した",
    emoji: "🧭",
    description: "就活が予定通りでなくても、次の動き方を考える材料が残った。",
  },
  study_abroad: {
    id: "study_abroad",
    title: "外の世界を見た",
    emoji: "🌏",
    description: "留学や海外経験が、学生生活の視野を広げた。",
  },
  teaching_cert: {
    id: "teaching_cert",
    title: "教える道を残した",
    emoji: "🏫",
    description: "教職や資格の積み重ねが、卒業後の選択肢になった。",
  },
  romance_committed: {
    id: "romance_committed",
    title: "関係を続ける選択",
    emoji: "💕",
    description: "恋愛をイベントではなく、続ける関係として扱った。",
  },
  romance_cheating: {
    id: "romance_cheating",
    title: "危ない香りの代償",
    emoji: "⚠️",
    description: "盛り上がりの裏に、関係を揺らす選択も残った。",
  },
  research_episode: {
    id: "research_episode",
    title: "問いを持ち帰った4年間",
    emoji: "🔎",
    description: "研究や授業で気になったことが、卒業後にも残った。",
  },
  friendship_episode: {
    id: "friendship_episode",
    title: "人に恵まれた4年間",
    emoji: "🫶",
    description: "誰と過ごしたかが、一番の思い出になった。",
  },
  romance_episode: {
    id: "romance_episode",
    title: "ちゃんと好きになった4年間",
    emoji: "💕",
    description: "恋愛や近い関係に向き合った時間が残った。",
  },
  career_episode: {
    id: "career_episode",
    title: "進路を早めに見た4年間",
    emoji: "🧳",
    description: "インターン、就活、働く経験が次の道を作った。",
  },
  creative_episode: {
    id: "creative_episode",
    title: "自分の活動が残った4年間",
    emoji: "🎨",
    description: "制作、企画、挑戦の記憶が卒業後の話題になった。",
  },
  recovery_episode: {
    id: "recovery_episode",
    title: "立て直しを覚えた4年間",
    emoji: "🧩",
    description: "崩れた時に戻す経験も、学生生活の一部になった。",
  },
  leave_recovery: {
    id: "leave_recovery",
    title: "一度止まって戻した",
    emoji: "🌿",
    description: "休む判断や立て直しが、4年間を続けるための選択になった。",
  },
  ordinary_episode: {
    id: "ordinary_episode",
    title: "自分のペースで終えた4年間",
    emoji: "🌱",
    description: "大きな事件より、続けてきた生活が残った。",
  },
};

function defaultPathScores() {
  return Object.fromEntries(INTENT_TAGS.map((tag) => [tag, 0]));
}

function addScore(scores, tag, amount = 1) {
  if (scores[tag] === undefined) return;
  scores[tag] += amount;
}

function collectPathScores(player) {
  const savedScores = {
    ...defaultPathScores(),
    ...(player.pathScores ?? {}),
  };
  const hasSavedScores = Object.values(savedScores).some((value) => value > 0);
  const scores = hasSavedScores ? savedScores : defaultPathScores();

  if (!hasSavedScores) {
    for (const entry of player.choiceHistory ?? []) {
      for (const tag of entry.intentTags ?? []) {
        addScore(scores, tag, 1);
      }
    }
  }

  return scores;
}

function collectDeclaredIntentScores(player) {
  const scores = defaultPathScores();
  for (const anchor of player.yearAnchors ?? []) {
    for (const tag of anchor.intentTags ?? []) {
      addScore(scores, tag, Number(anchor.resultWeight ?? 2));
    }
  }
  return scores;
}

function scoreGroup(scores, tags) {
  return tags.reduce((sum, tag) => sum + (scores[tag] ?? 0), 0);
}

function countAnchors(player, tags) {
  return (player.yearAnchors ?? []).filter((anchor) => (
    anchor.intentTags?.some((tag) => tags.includes(tag))
  )).length;
}

function topIntentTags(scores, limit = 3) {
  return Object.entries(scores)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}

export function determineBoardAcademicStatus(player) {
  if (player.flags?.on_leave || player.resources.health <= 1) return ACADEMIC_STATUSES.recovery_first;
  if (player.resources.credits < 124) return ACADEMIC_STATUSES.retained;
  return ACADEMIC_STATUSES.graduated;
}

function historyHas(player, key, predicate) {
  return (player.choiceHistory ?? []).some((entry) => (
    Array.isArray(entry[key]) && entry[key].some(predicate)
  ));
}

function historyCount(player, key, predicate) {
  return (player.choiceHistory ?? []).reduce((total, entry) => {
    if (!Array.isArray(entry[key])) return total;
    return total + entry[key].filter(predicate).length;
  }, 0);
}

function hasOutcome(player, outcomeTag) {
  return historyHas(player, "outcomeTags", (tag) => tag === outcomeTag);
}

function hasOutcomePrefix(player, prefix) {
  return historyHas(player, "outcomeTags", (tag) => tag.startsWith(prefix));
}

function routeCount(player, routeTag) {
  return historyCount(player, "routeTags", (tag) => tag === routeTag);
}

function choiceIdCount(player, prefixes) {
  return (player.choiceHistory ?? []).filter((entry) => (
    prefixes.some((prefix) => entry.choiceId?.startsWith(prefix))
  )).length;
}

function buildResultEvidence(player) {
  const evidence = [];
  for (const milestone of player.milestones ?? []) {
    if (milestone.choiceLabel && evidence.length < 4) evidence.push(milestone.choiceLabel);
  }
  for (const entry of player.choiceHistory ?? []) {
    if (entry.choiceLabel && evidence.length < 4 && !evidence.includes(entry.choiceLabel)) {
      evidence.push(entry.choiceLabel);
    }
  }
  return evidence;
}

export function determineCareerOutcome(player) {
  const flags = player.flags ?? {};
  const path = flags.career_path;

  if (flags.startup_traction || hasOutcome(player, "startup.traction") || hasOutcome(player, "startup.customer")) {
    return CAREER_OUTCOMES.startup_traction;
  }
  if (
    flags.startup_failed
    || flags.startup_closed
    || hasOutcome(player, "startup.failed")
    || hasOutcome(player, "startup.closed")
    || (flags.career_failed && path === "entrepreneur")
  ) {
    return CAREER_OUTCOMES.startup_failed;
  }
  if (flags.grad_admitted || hasOutcome(player, "grad.admitted")) {
    return CAREER_OUTCOMES.grad_admitted;
  }
  if (flags.grad_exam_failed || hasOutcome(player, "grad.failed") || (flags.career_failed && path === "grad_school")) {
    return CAREER_OUTCOMES.grad_exam_failed;
  }
  if (flags.job_offer || hasOutcome(player, "job.offer")) {
    return CAREER_OUTCOMES.job_offer;
  }
  if (flags.job_hunt_failed || hasOutcome(player, "job.failed") || (flags.career_failed && path === "standard")) {
    return CAREER_OUTCOMES.job_hunt_failed;
  }
  if (flags.career_unsettled || flags.career_failed || hasOutcome(player, "career.unsettled")) {
    return CAREER_OUTCOMES.career_unsettled;
  }
  if (path || routeCount(player, "job") > 0 || routeCount(player, "grad_school") > 0 || routeCount(player, "startup") > 0) {
    return CAREER_OUTCOMES.career_in_progress;
  }
  return CAREER_OUTCOMES.career_unsettled;
}

export function determineRelationshipOutcome(player) {
  const flags = player.flags ?? {};
  const exPartnerCount = Number(flags.ex_partner_count ?? 0);
  if (flags.cheating || hasOutcome(player, "romance.cheating_current")) return RELATIONSHIP_OUTCOMES.cheating;
  if ((flags.romance_restarted || exPartnerCount > 0 || hasOutcome(player, "romance.restarted")) && flags.has_partner) {
    return RELATIONSHIP_OUTCOMES.restarted;
  }
  if ((flags.cheated_before || hasOutcome(player, "romance.cheated_before")) && flags.has_partner) {
    return RELATIONSHIP_OUTCOMES.dating_after_cheating;
  }
  if (flags.cheated_before || hasOutcome(player, "romance.cheated_before") || hasOutcomePrefix(player, "romance.cheating")) {
    return RELATIONSHIP_OUTCOMES.cheated_before;
  }
  if (flags.breakup || exPartnerCount > 0 || hasOutcome(player, "romance.breakup")) return RELATIONSHIP_OUTCOMES.breakup;
  if (flags.romance_committed || hasOutcome(player, "romance.commitment")) return RELATIONSHIP_OUTCOMES.committed;
  if (flags.has_partner || hasOutcome(player, "romance.relationship_start")) return RELATIONSHIP_OUTCOMES.dating;
  return RELATIONSHIP_OUTCOMES.single;
}

export function determineBoardLifeArchetype(player) {
  const scores = collectPathScores(player);
  const declaredScores = collectDeclaredIntentScores(player);
  const researchScore = scoreGroup(scores, ["study", "research"]);
  const researchEvidence = (scores.research ?? 0)
    + routeCount(player, "research")
    + routeCount(player, "grad_school")
    + historyCount(player, "outcomeTags", (tag) => tag.startsWith("research.") || tag.startsWith("grad."))
    + (player.flags?.in_seminar ? 1 : 0);
  const socialAnchorCount = countAnchors(player, ["social", "community"]);
  const socialScore = ((scores.social ?? 0) * 0.65)
    + ((scores.community ?? 0) * 1.4)
    + (socialAnchorCount * 2);
  const careerScore = scoreGroup(scores, ["career", "work"]);
  const startupScore = routeCount(player, "startup")
    + historyCount(player, "outcomeTags", (tag) => tag.startsWith("startup."))
    + choiceIdCount(player, ["37EN", "38EN", "39EN"])
    + (player.flags?.career_path === "entrepreneur" ? 1 : 0)
    + (player.flags?.startup_traction ? 3 : 0)
    - (player.flags?.startup_failed || player.flags?.startup_closed ? 2 : 0);
  const creativeAnchorCount = countAnchors(player, ["creative", "adventure"]);
  let creativeScore = ((scores.creative ?? 0) * 0.9)
    + ((scores.adventure ?? 0) * 0.25)
    + (creativeAnchorCount * 2);
  if ((scores.creative ?? 0) < 5 && creativeAnchorCount === 0) {
    creativeScore *= 0.35;
  }
  const rawRomanceScore = scores.romance ?? 0;
  const romanceAnchorCount = countAnchors(player, ["romance"]);
  const romanceCommitmentBonus = (player.flags?.has_partner ? 3 : 0) + (romanceAnchorCount * 4);
  const romanceScore = rawRomanceScore + romanceCommitmentBonus;
  const restScore = scores.rest ?? 0;
  const nonAcademicTop = Math.max(socialScore, careerScore, creativeScore, romanceScore, restScore);

  const studyAnchorCount = countAnchors(player, ["study", "research"]);
  if (startupScore >= 3) return LIFE_ARCHETYPES.startup_builder;

  if (player.flags?.studying_abroad && ((scores.adventure ?? 0) >= 2 || routeCount(player, "abroad") > 0)) {
    return LIFE_ARCHETYPES.global_challenger;
  }

  const declaredStudyIntent = scoreGroup(declaredScores, ["study", "research"]);
  const hasResearchPath = (researchEvidence >= 3 && (declaredStudyIntent >= 2 || studyAnchorCount >= 1))
    || ((scores.research ?? 0) >= 4 && researchEvidence >= nonAcademicTop + 1)
    || (player.flags?.career_path === "grad_school" && (scores.research ?? 0) >= 4 && researchScore >= 4);
  if (hasResearchPath) return LIFE_ARCHETYPES.scholar;

  const hasCommittedRomancePath = (
    (player.flags?.has_partner && rawRomanceScore >= 1)
    || (romanceAnchorCount >= 2 && rawRomanceScore >= 4)
  )
    && romanceScore + 9 >= socialScore;
  if (hasCommittedRomancePath) return LIFE_ARCHETYPES.romantic;

  const ranked = [
    ["startup_builder", startupScore],
    ["career_builder", careerScore],
    ["romantic", romanceScore],
    ["campus_connector", socialScore],
    ["creative_runner", creativeScore],
    ["rest_keeper", restScore],
  ].sort((a, b) => b[1] - a[1]);

  const [topId, topScore] = ranked[0];
  if (topScore >= 4) return LIFE_ARCHETYPES[topId];
  if (topScore >= 2 && ranked[1] && topScore - ranked[1][1] >= 1) return LIFE_ARCHETYPES[topId];
  return LIFE_ARCHETYPES.balanced_life;
}

export function determineBoardStoryAward(player, academicStatus, lifeArchetype) {
  const careerOutcome = determineCareerOutcome(player);
  const relationshipOutcome = determineRelationshipOutcome(player);
  if (academicStatus.id === "retained" || academicStatus.id === "recovery_first") {
    if (player.flags?.on_leave) return STORY_AWARDS.leave_recovery;
    return STORY_AWARDS.recovery_episode;
  }
  if (careerOutcome.id === "startup_failed") return STORY_AWARDS.startup_closed;
  if (careerOutcome.id === "grad_exam_failed") return STORY_AWARDS.grad_failed_rebuild;
  if (careerOutcome.id === "job_hunt_failed") return STORY_AWARDS.job_rebuild;
  if (
    relationshipOutcome.id === "cheating"
    || relationshipOutcome.id === "cheated_before"
    || relationshipOutcome.id === "dating_after_cheating"
  ) {
    return STORY_AWARDS.romance_cheating;
  }
  if (careerOutcome.id === "startup_traction") return STORY_AWARDS.startup_first_customer;
  if (careerOutcome.id === "grad_admitted") return STORY_AWARDS.grad_admitted;
  if (careerOutcome.id === "job_offer") return STORY_AWARDS.job_offer;
  if (player.flags?.studying_abroad) return STORY_AWARDS.study_abroad;
  if (player.flags?.teaching_cert) return STORY_AWARDS.teaching_cert;
  if (
    relationshipOutcome.id === "committed"
    || relationshipOutcome.id === "dating"
    || relationshipOutcome.id === "restarted"
  ) {
    return STORY_AWARDS.romance_committed;
  }
  if (lifeArchetype.id === "scholar") return STORY_AWARDS.research_episode;
  if (lifeArchetype.id === "romantic") return STORY_AWARDS.romance_episode;
  if (lifeArchetype.id === "career_builder") return STORY_AWARDS.career_episode;
  if (lifeArchetype.id === "startup_builder") return STORY_AWARDS.startup_first_customer;
  if (lifeArchetype.id === "campus_connector") return STORY_AWARDS.friendship_episode;
  if (lifeArchetype.id === "creative_runner") return STORY_AWARDS.creative_episode;
  if (lifeArchetype.id === "global_challenger") return STORY_AWARDS.study_abroad;

  const scores = collectPathScores(player);
  if ((scores.risk ?? 0) >= 4 || (scores.rest ?? 0) >= 4) return STORY_AWARDS.recovery_episode;
  return STORY_AWARDS.ordinary_episode;
}

export function summarizeBoardResult(player, academicStatus, lifeArchetype, storyAward) {
  const careerOutcome = determineCareerOutcome(player);
  const relationshipOutcome = determineRelationshipOutcome(player);
  const anchorText = (player.yearAnchors ?? [])
    .map((anchor) => anchor.choiceLabel)
    .slice(-2)
    .join("、");
  const anchorSentence = anchorText ? `途中では「${anchorText}」を選んだ。` : "";
  return `${player.name}は「${lifeArchetype.title}」として4年間を終えた。到達結果は「${academicStatus.title}」、進路は「${careerOutcome.title}」、恋愛は「${relationshipOutcome.title}」。${anchorSentence}${storyAward.description}`;
}

export function determineEnding(player) {
  if (player.resources.credits < 124) return ENDINGS.ryuunen;
  if (player.flags?.on_leave || player.resources.health <= 1) return ENDINGS.therapy;

  const lifeArchetype = determineBoardLifeArchetype(player);
  if (ENDINGS[lifeArchetype.id]) return ENDINGS[lifeArchetype.id];
  return lifeArchetype;
}

// ─── Generate Results ────────────────────────────────────────────

export function generateResults(players) {
  const scored = players.map((player) => ({
    player,
    score: calculateScore(player),
    scoreBreakdown: calculateScoreBreakdown(player),
    academicStatus: determineBoardAcademicStatus(player),
    careerOutcome: determineCareerOutcome(player),
    relationshipOutcome: determineRelationshipOutcome(player),
    lifeArchetype: determineBoardLifeArchetype(player),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.map((entry, index) => {
    const storyAward = determineBoardStoryAward(entry.player, entry.academicStatus, entry.lifeArchetype);
    return {
      playerId: entry.player.id,
      playerName: entry.player.name,
      score: entry.score,
      rank: index + 1,
      ending: determineEnding(entry.player),
      academicStatus: entry.academicStatus,
      academicOutcome: entry.academicStatus,
      careerOutcome: entry.careerOutcome,
      relationshipOutcome: entry.relationshipOutcome,
      lifeArchetype: entry.lifeArchetype,
      storyAward,
      summary: summarizeBoardResult(entry.player, entry.academicStatus, entry.lifeArchetype, storyAward),
      scoreBreakdown: entry.scoreBreakdown,
      resources: entry.player.resources,
      experience: entry.player.experience,
      flags: entry.player.flags,
      flagHistory: entry.player.flagHistory,
      pathScores: collectPathScores(entry.player),
      yearAnchors: entry.player.yearAnchors ?? [],
      milestones: entry.player.milestones ?? [],
      storyTags: topIntentTags(collectPathScores(entry.player)),
      choiceHistory: entry.player.choiceHistory ?? [],
      resultEvidence: buildResultEvidence(entry.player),
    };
  });
}
