export interface CardData {
  playerName: string;
  archetypeId: string;
  archetypeTitle: string;
  archetypeDescription: string;
  storyTags: string[];
}

const CARD_BACKGROUNDS = new Set([
  "adventurer",
  "balanced",
  "self_searcher",
  "social_burnout",
  "social_connector",
  "steady_builder",
]);

const ARCHETYPE_BACKGROUND_MAP: Record<string, string> = {
  scholar: "steady_builder",
  campus_connector: "social_connector",
  romantic: "social_connector",
  career_builder: "steady_builder",
  creative_runner: "adventurer",
  rest_keeper: "self_searcher",
  balanced_life: "balanced",
};

const PANEL_RATIO = 0.72;
const PAD = 50;

export async function generateResultCard(data: CardData): Promise<string> {
  const backgroundId = resolveBackgroundId(data.archetypeId);
  const image = await loadImage(`/cards/bg_${backgroundId}.png`);

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available");
  }

  context.drawImage(image, 0, 0);

  const width = canvas.width;
  const height = canvas.height;
  const panelY = Math.round(height * PANEL_RATIO);
  const fontFamily = `"Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif`;

  context.font = `32px ${fontFamily}`;
  context.fillStyle = "rgba(255, 255, 255, 0.60)";
  context.fillText(`${data.playerName} の4年間`, PAD, panelY + 52);

  context.font = `bold 58px ${fontFamily}`;
  context.fillStyle = "#ffffff";
  const titleWidth = context.measureText(data.archetypeTitle).width;
  if (titleWidth > width - PAD * 2) {
    const scale = (width - PAD * 2) / titleWidth;
    context.font = `bold ${Math.floor(58 * scale)}px ${fontFamily}`;
  }
  context.fillText(data.archetypeTitle, PAD, panelY + 128);

  context.font = `26px ${fontFamily}`;
  context.fillStyle = "rgba(255, 255, 255, 0.78)";
  const descriptionLines = wrapText(context, data.archetypeDescription, width - PAD * 2);
  const descriptionLineHeight = 36;
  descriptionLines.slice(0, 3).forEach((line, index) => {
    context.fillText(line, PAD, panelY + 190 + index * descriptionLineHeight);
  });

  const tags = data.storyTags.slice(0, 6);
  if (tags.length > 0) {
    const tagBaseY = panelY + 190 + Math.min(descriptionLines.length, 3) * descriptionLineHeight + 36;
    context.font = `26px ${fontFamily}`;
    context.fillStyle = "rgba(255, 255, 255, 0.55)";
    context.fillText(tags.slice(0, 3).map((tag) => `#${tag}`).join("   "), PAD, tagBaseY);
    const secondRow = tags.slice(3, 6).map((tag) => `#${tag}`).join("   ");
    if (secondRow) {
      context.fillText(secondRow, PAD, tagBaseY + 38);
    }
  }

  return canvas.toDataURL("image/png");
}

function resolveBackgroundId(archetypeId: string): string {
  if (CARD_BACKGROUNDS.has(archetypeId)) return archetypeId;
  return ARCHETYPE_BACKGROUND_MAP[archetypeId] ?? "balanced";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    image.src = src;
  });
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let current = "";

  for (const char of text) {
    const candidate = current + char;
    if (context.measureText(candidate).width > maxWidth) {
      if (current) lines.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }

  if (current) lines.push(current);
  return lines;
}
