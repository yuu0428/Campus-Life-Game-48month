#!/usr/bin/env node
/**
 * ゲームサーバー起動スクリプト
 *
 * 使い方:
 *   node scripts/start-game.mjs                        # ローカルWiFiモード（ポート4173）
 *   node scripts/start-game.mjs --tunnel               # Cloudflare Tunnelモード
 *   node scripts/start-game.mjs --port 4174 --tunnel   # 2ゲーム目（別ポート）
 *   node scripts/start-game.mjs --port 4175 --name "Aチーム" --tunnel
 *
 * npm scripts:
 *   npm run game              # ローカルモード
 *   npm run game:tunnel       # トンネルモード
 */

import { spawn } from "node:child_process";

// ─── CLI 引数（codex 流の構造化パース＋バリデーション） ─────────────
function parseArgs(argv) {
  const options = {
    port: 4173,
    tunnel: false,
    name: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--name" && next) {
      options.name = next;
      index += 1;
    } else if (arg === "--tunnel") {
      options.tunnel = true;
    }
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port は 1〜65535 の整数で指定してください");
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const PORT = options.port;
const USE_TUNNEL = options.tunnel;
const GAME_NAME = options.name || `ゲーム (ポート ${PORT})`;

// ─── ユーティリティ ───────────────────────────────────────────────
const sep = "═".repeat(60);

function printBox(lines) {
  console.log("\n" + sep);
  lines.forEach((l) => console.log(l));
  console.log(sep + "\n");
}

// ─── サーバー起動 ─────────────────────────────────────────────────
function startServer(tunnelUrl = null) {
  const env = { ...process.env, PORT: String(PORT) };
  if (tunnelUrl) env.PUBLIC_URL = tunnelUrl;

  const server = spawn(process.execPath, ["server/index.js"], {
    env,
    stdio: "inherit",
    cwd: process.cwd(),
  });

  server.on("exit", (code) => process.exit(code ?? 0));
  return server;
}

// ─── Cloudflare Tunnel 起動 & URL取得 ────────────────────────────
function startTunnel() {
  return new Promise((resolve, reject) => {
    const cf = spawn(
      "npx",
      ["--yes", "cloudflared", "tunnel", "--url", `http://localhost:${PORT}`],
      { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() }
    );

    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cf.kill();
      reject(new Error("Tunnel URL取得タイムアウト (60秒)"));
    }, 60_000);

    const onData = (data) => {
      if (settled) return;
      const text = data.toString();
      const match = text.match(urlPattern);
      if (match) {
        settled = true;
        clearTimeout(timeout);
        resolve({ url: match[0], process: cf });
      }
    };

    cf.stdout.on("data", onData);
    cf.stderr.on("data", onData);
    cf.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    cf.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`cloudflared が終了しました (code: ${code ?? "unknown"})`));
    });
  });
}

// ─── サーバーにトンネルURLを通知 ──────────────────────────────────
async function notifyServer(url, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/admin/tunnel-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (res.ok) return true;
    } catch {
      // サーバー起動待ち
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ─── メイン ───────────────────────────────────────────────────────
async function main() {
  if (!USE_TUNNEL) {
    // ── ローカルWiFiモード ──────────────────────────────────────
    const localHost = `http://localhost:${PORT}`;
    printBox([
      `🎮  ${GAME_NAME}`,
      `📡  モード: ローカルWiFi`,
      `🔌  ポート: ${PORT}`,
      ``,
      `🖥️   ホスト画面:`,
      `    ${localHost}`,
      `📺  ディスプレイ:`,
      `    ${localHost}/display.html?host=${encodeURIComponent(localHost)}`,
      `📱  参加者:`,
      `    ${localHost}/controller.html?host=${encodeURIComponent(localHost)}`,
      ``,
      `参加者と同じWiFiに繋いで、ホスト画面のQRコードを共有してください。`,
    ]);
    startServer();
    return;
  }

  // ── Cloudflare Tunnelモード ──────────────────────────────────
  console.log(`\n🚀 ${GAME_NAME} を起動中... (Cloudflare Tunnelモード)`);
  console.log(`   ポート: ${PORT}`);

  // 1. サーバー起動
  const server = startServer();
  let tunnelProc = null;

  // Ctrl+C でクリーンアップ（早めに登録）
  process.on("SIGINT", () => {
    console.log("\nゲームを終了します...");
    tunnelProc?.kill();
    server?.kill();
    process.exit(0);
  });

  // 2. Tunnel起動
  console.log("🌐 Cloudflare Tunnel を起動中... (10〜30秒かかります)");
  try {
    const { url, process: cf } = await startTunnel();
    tunnelProc = cf;

    // 3. サーバーにURL通知
    const notified = await notifyServer(url);
    if (!notified) {
      console.warn("⚠️  サーバーへのURL通知に失敗しましたが、起動は続行します。");
    }

    printBox([
      `🎮  ${GAME_NAME} — 起動完了！`,
      ``,
      `📱  参加者向けURL (どこからでもアクセス可):`,
      `    ${url}/controller.html?host=${encodeURIComponent(url)}`,
      ``,
      `🖥️   ホスト管理画面:`,
      `    ${url}`,
      `📺  ディスプレイ画面:`,
      `    ${url}/display.html?host=${encodeURIComponent(url)}`,
      ``,
      `💡  参加者向けURLをQRコードに変換してプロジェクターに映すか、`,
      `    参加者に直接送ってください。`,
      ``,
      `⚠️   このターミナルを閉じるとゲームが終了します。`,
    ]);
  } catch (err) {
    console.error(`\n❌ Tunnel起動失敗: ${err.message}`);
    console.error("ローカルWiFiモードで継続します。");
    console.error("cloudflared がインストールされていない場合は自動でインストールが試みられます。");
    console.error("手動インストール: npm install -g cloudflared");
    // サーバーはそのまま継続
  }
}

main().catch((err) => {
  console.error("起動エラー:", err);
  process.exit(1);
});
