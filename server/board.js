// Main board definition for the 48-month calendar.

export const BOARD = {
  "1": { id: "1", eventId: "ev_1", next: "2", year: 1, type: "start" },
  "2": { id: "2", eventId: "ev_2", next: "3", year: 1, type: "normal" },
  "3": { id: "3", eventId: "ev_3", next: "4", year: 1, type: "normal" },
  "4": { id: "4", eventId: "ev_4", next: "5", year: 1, type: "normal" },
  "5": { id: "5", eventId: "ev_5", next: "6", year: 1, type: "normal" },
  "6": { id: "6", eventId: "ev_6", next: "7", year: 1, type: "normal" },
  "7": { id: "7", eventId: "ev_7", next: "8", year: 1, type: "normal" },
  "8": { id: "8", eventId: "ev_8", next: "9", year: 1, type: "normal" },
  "9": { id: "9", eventId: "ev_9", next: "10", year: 1, type: "normal" },
  "10": { id: "10", eventId: "ev_10", next: "11", year: 1, type: "normal" },
  "11": { id: "11", eventId: "ev_11", next: "12", year: 1, type: "normal" },
  "12": { id: "12", eventId: "ev_12", next: "13", year: 1, type: "checkpoint" },
  "13": { id: "13", eventId: "ev_13", next: "14", year: 2, type: "normal" },
  "14": { id: "14", eventId: "ev_14", next: "15", year: 2, type: "normal" },
  "15": { id: "15", eventId: "ev_15", next: "16", year: 2, type: "normal" },
  "16": { id: "16", eventId: "ev_16", next: "17", year: 2, type: "normal" },
  "17": { id: "17", eventId: "ev_17", next: "18", year: 2, type: "normal" },
  "18": { id: "18", eventId: "ev_18", next: "19", year: 2, type: "normal" },
  "19": { id: "19", eventId: "ev_19", next: "20", year: 2, type: "normal" },
  "20": { id: "20", eventId: "ev_20", next: "21", year: 2, type: "normal" },
  "21": { id: "21", eventId: "ev_21", next: "22", year: 2, type: "normal" },
  "22": { id: "22", eventId: "ev_22", next: "23", year: 2, type: "normal" },
  "23": { id: "23", eventId: "ev_23", next: "24", year: 2, type: "normal" },
  "24": { id: "24", eventId: "ev_24", next: "25", year: 2, type: "checkpoint" },
  "25": { id: "25", eventId: "ev_25", next: "26", year: 3, type: "normal" },
  "26": { id: "26", eventId: "ev_26", next: "27", year: 3, type: "normal" },
  "27": { id: "27", eventId: "ev_27", next: "28", year: 3, type: "normal" },
  "28": { id: "28", eventId: "ev_28", next: "29", year: 3, type: "normal" },
  "29": { id: "29", eventId: "ev_29", next: "30", year: 3, type: "normal" },
  "30": { id: "30", eventId: "ev_30", next: "31", year: 3, type: "normal" },
  "31": { id: "31", eventId: "ev_31", next: "32", year: 3, type: "normal" },
  "32": { id: "32", eventId: "ev_32", next: "33", year: 3, type: "normal" },
  "33": { id: "33", eventId: "ev_33", next: "34", year: 3, type: "normal" },
  "34": { id: "34", eventId: "ev_34", next: "35", year: 3, type: "normal" },
  "35": { id: "35", eventId: "ev_35", next: "36", year: 3, type: "normal" },
  "36": { id: "36", eventId: "ev_36", next: "37", year: 3, type: "checkpoint" },
  "37": { id: "37", eventId: "ev_37", next: "38", year: 4, type: "normal" },
  "38": { id: "38", eventId: "ev_38", next: "39", year: 4, type: "normal" },
  "39": { id: "39", eventId: "ev_39", next: "40", year: 4, type: "normal" },
  "40": { id: "40", eventId: "ev_40", next: "41", year: 4, type: "normal" },
  "41": { id: "41", eventId: "ev_41", next: "42", year: 4, type: "normal" },
  "42": { id: "42", eventId: "ev_42", next: "43", year: 4, type: "normal" },
  "43": { id: "43", eventId: "ev_43", next: "44", year: 4, type: "normal" },
  "44": { id: "44", eventId: "ev_44", next: "45", year: 4, type: "normal" },
  "45": { id: "45", eventId: "ev_45", next: "46", year: 4, type: "normal" },
  "46": { id: "46", eventId: "ev_46", next: "47", year: 4, type: "normal" },
  "47": { id: "47", eventId: "ev_47", next: "48", year: 4, type: "normal" },
  "48": { id: "48", eventId: "ev_48", next: null, year: 4, type: "goal" },
};

export const MAIN_TRACK_ORDER = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48"];

export function meetsCondition(player, condition) {
  if (condition.minStats) {
    const stats = { ...player.resources, ...player.experience };
    for (const [key, threshold] of Object.entries(condition.minStats)) {
      if ((stats[key] ?? 0) < threshold) return false;
    }
  }
  if (condition.requiredFlags) {
    const flags = { ...player.flags };
    for (const [key, required] of Object.entries(condition.requiredFlags)) {
      if (flags[key] !== required) return false;
    }
  }
  if (condition.excludedFlags) {
    const flags = { ...player.flags };
    for (const [key, excluded] of Object.entries(condition.excludedFlags)) {
      if (flags[key] === excluded) return false;
    }
  }
  if (condition.requiredAnyFlags) {
    const flags = { ...player.flags };
    const hasAny = condition.requiredAnyFlags.some((requiredFlags) => (
      Object.entries(requiredFlags).every(([key, required]) => flags[key] === required)
    ));
    if (!hasAny) return false;
  }
  if (condition.minRound && (player.currentRound ?? 1) < condition.minRound) {
    return false;
  }
  if (condition.faculty && player.faculty !== condition.faculty) {
    return false;
  }
  return true;
}

export function getNextSquareId(currentId) {
  return BOARD[currentId]?.next ?? null;
}
