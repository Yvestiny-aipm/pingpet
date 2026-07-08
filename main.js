"use strict";
const node_fs = require("node:fs");
const electron = require("electron");
const node_path = require("node:path");
const node_url = require("node:url");
const node_os = require("node:os");
const Store = require("electron-store");
const path = require("path");
const PETS = [
  {
    id: "dango",
    name: "团子",
    kind: "svg",
    source: "official",
    accentColor: "#F0B27E",
    description: "软乎乎的奶油小猫"
  },
  {
    id: "pudding",
    name: "布丁",
    kind: "svg",
    source: "official",
    accentColor: "#F5B942",
    description: "圆滚滚的小鸡"
  },
  {
    id: "momo",
    name: "墨墨",
    kind: "svg",
    source: "official",
    accentColor: "#7C8DB0",
    description: "安安静静的小墨团"
  }
];
const FALLBACK_PET_ID = "dango";
const PACK_STATES = ["idle", "happy", "sleepy", "attention", "thinking", "failed"];
const ALLOWED_EXT = [".png", ".webp", ".svg"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PACK_BYTES = 30 * 1024 * 1024;
const DEFAULT_ACCENT = "#7AA7FF";
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function checkAssetPath(packDir, rel, label) {
  if (typeof rel !== "string" || !rel.trim()) {
    return { ok: false, error: `${label} 路径必须是非空字符串` };
  }
  const r = rel.trim();
  if (node_path.isAbsolute(r)) return { ok: false, error: `${label} 不允许绝对路径：${r}` };
  const ext = r.slice(r.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return { ok: false, error: `${label} 扩展名不被允许（只允许 png/webp/svg）：${r}` };
  }
  const abs = node_path.resolve(packDir, r);
  const relBack = node_path.relative(packDir, abs);
  if (relBack.startsWith("..") || node_path.isAbsolute(relBack) || relBack.split(node_path.sep).includes("..")) {
    return { ok: false, error: `${label} 路径跳出了皮肤包目录（疑似 ../ 穿越）：${r}` };
  }
  let bytes = 0;
  try {
    const st = node_fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: `${label} 不是文件：${r}` };
    bytes = st.size;
  } catch {
    return { ok: false, error: `${label} 文件不存在：${r}` };
  }
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `${label} 文件超过 5MB 上限：${r}` };
  }
  return { ok: true, rel: r, bytes };
}
function validateManifest(raw, packDir) {
  if (!isPlainObject(raw)) return { ok: false, error: "manifest.json 不是合法的 JSON 对象" };
  const id = raw.id;
  if (typeof id !== "string" || !/^[a-z0-9_-]{2,40}$/.test(id)) {
    return { ok: false, error: "manifest.id 非法（只允许小写字母/数字/-/_，长度 2-40）" };
  }
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 30) {
    return { ok: false, error: "manifest.name 非法（非空，长度 1-30）" };
  }
  let description = "";
  if (raw.description !== void 0) {
    if (typeof raw.description !== "string" || raw.description.length > 80) {
      return { ok: false, error: "manifest.description 非法（可选，最长 80）" };
    }
    description = raw.description;
  }
  let accentColor = DEFAULT_ACCENT;
  if (typeof raw.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.accentColor)) {
    accentColor = raw.accentColor;
  }
  const version = typeof raw.version === "string" ? raw.version : "1.0.0";
  const author = typeof raw.author === "string" ? raw.author : "";
  if (!isPlainObject(raw.states)) {
    return { ok: false, error: "manifest.states 缺失或不是对象" };
  }
  const rawStates = raw.states;
  if (rawStates.idle === void 0) {
    return { ok: false, error: "皮肤包必须包含 idle 状态" };
  }
  const states = {};
  let totalBytes = 0;
  for (const state of PACK_STATES) {
    const v = rawStates[state];
    if (v === void 0) continue;
    const res = checkAssetPath(packDir, v, `states.${state}`);
    if (!res.ok) return { ok: false, error: res.error };
    states[state] = res.rel;
    totalBytes += res.bytes;
  }
  let thumbnail;
  if (raw.thumbnail !== void 0) {
    const res = checkAssetPath(packDir, raw.thumbnail, "thumbnail");
    if (!res.ok) return { ok: false, error: res.error };
    thumbnail = res.rel;
    totalBytes += res.bytes;
  }
  if (totalBytes > MAX_PACK_BYTES) {
    return { ok: false, error: "皮肤包总大小超过 30MB 上限" };
  }
  return {
    ok: true,
    manifest: { id, name: name.trim(), version, author, description, accentColor, thumbnail, states }
  };
}
function readAndValidateManifest(packDir) {
  const manifestPath = node_path.join(packDir, "manifest.json");
  let raw;
  try {
    const { readFileSync } = require("node:fs");
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      error: `读取 manifest.json 失败：${err instanceof Error ? err.message : String(err)}`
    };
  }
  return validateManifest(raw, packDir);
}
function officialPacksRoot() {
  if (electron.app.isPackaged) {
    return node_path.join(process.resourcesPath, "pet-packs", "official");
  }
  return node_path.join(electron.app.getAppPath(), "resources", "pet-packs", "official");
}
function importedPacksRoot() {
  return node_path.join(electron.app.getPath("userData"), "pet-packs", "imported");
}
function importedPackDir(petId) {
  return node_path.join(importedPacksRoot(), petId);
}
function manifestToPet(manifest, packDir, source) {
  const states = {};
  for (const [state, rel] of Object.entries(manifest.states)) {
    if (rel) states[state] = node_url.pathToFileURL(node_path.join(packDir, rel)).href;
  }
  const thumbnailUrl = manifest.thumbnail ? node_url.pathToFileURL(node_path.join(packDir, manifest.thumbnail)).href : states.idle;
  return {
    id: manifest.id,
    name: manifest.name,
    kind: "image-pack",
    source,
    accentColor: manifest.accentColor,
    description: manifest.description,
    thumbnailUrl,
    states
  };
}
function loadPacksFrom(root, source) {
  if (!node_fs.existsSync(root)) return [];
  let entries = [];
  try {
    entries = node_fs.readdirSync(root);
  } catch {
    return [];
  }
  const pets = [];
  for (const entry of entries) {
    const packDir = node_path.join(root, entry);
    try {
      if (!node_fs.statSync(packDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const res = readAndValidateManifest(packDir);
    if (!res.ok) continue;
    pets.push(manifestToPet(res.manifest, packDir, source));
  }
  return pets;
}
function getPetCatalog() {
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (pets) => {
    for (const p of pets) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      result.push(p);
    }
  };
  push(PETS);
  push(loadPacksFrom(officialPacksRoot(), "official"));
  push(loadPacksFrom(importedPacksRoot(), "imported"));
  return result;
}
function findPetInCatalog(id) {
  return getPetCatalog().find((p) => p.id === id);
}
function importPetPackFromDialog(parent) {
  const picked = electron.dialog.showOpenDialogSync(parent, {
    title: "选择皮肤包文件夹",
    properties: ["openDirectory"],
    message: "选择一个包含 manifest.json 的皮肤包文件夹"
  });
  if (!picked || picked.length === 0) {
    return { ok: false, error: "", canceled: true };
  }
  return importPetPackFromDir(picked[0]);
}
function pickSkinFromDialog(parent) {
  const picked = electron.dialog.showOpenDialogSync(parent, {
    title: "导入皮肤",
    // macOS 下同时允许选文件和文件夹；不加 filters（filters 只对文件生效，会让文件夹变灰）
    properties: ["openFile", "openDirectory"],
    buttonLabel: "导入",
    message: "选一张 PNG / WebP / SVG 图片，或一个含 manifest.json 的皮肤包文件夹\n（选文件夹时单击选中它、再点“导入”，不要双击进入）"
  });
  if (!picked || picked.length === 0) return { kind: "canceled" };
  const p = picked[0];
  let isDir = false;
  try {
    isDir = node_fs.statSync(p).isDirectory();
  } catch {
    return { kind: "error", error: "选中的路径无法读取" };
  }
  if (isDir) {
    const res = importPetPackFromDir(p);
    if (res.ok) return { kind: "pack", petId: res.petId };
    return { kind: "error", error: res.error };
  }
  const img = readImageFileAsDataUrl(p);
  if (!img.ok) return { kind: "error", error: img.error };
  return { kind: "image", dataUrl: img.dataUrl, ext: img.ext, name: img.name };
}
const IMAGE_EXTS = [".png", ".webp", ".svg"];
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
function deriveImageId(fileName) {
  const base = node_path.basename(fileName, node_path.extname(fileName));
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  const stem = slug.length >= 2 ? slug : "pet";
  return `${stem}-${Date.now().toString(36)}`.slice(0, 40);
}
function extToMime(ext) {
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
function readImageFileAsDataUrl(imgPath) {
  const ext = node_path.extname(imgPath).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) {
    return { ok: false, error: `不支持的图片格式（只允许 PNG / WebP / SVG）：${node_path.basename(imgPath)}` };
  }
  let bytes = 0;
  try {
    const st = node_fs.statSync(imgPath);
    if (!st.isFile()) return { ok: false, error: "选中的不是一个文件" };
    bytes = st.size;
  } catch {
    return { ok: false, error: "图片文件不存在或无法读取" };
  }
  if (bytes > IMAGE_MAX_BYTES) {
    return { ok: false, error: `图片超过 5MB 上限：${node_path.basename(imgPath)}` };
  }
  const { readFileSync } = require("node:fs");
  const b64 = readFileSync(imgPath).toString("base64");
  const rawName = node_path.basename(imgPath, ext).trim().slice(0, 30);
  const name = rawName.length >= 1 ? rawName : "我的桌宠";
  return { ok: true, dataUrl: `data:${extToMime(ext)};base64,${b64}`, ext, name };
}
function pickPetImageFromDialog(parent) {
  const picked = electron.dialog.showOpenDialogSync(parent, {
    title: "选择一张图片当桌宠",
    properties: ["openFile"],
    message: "选一张 PNG / WebP / SVG 图片，直接变成你的桌宠",
    filters: [{ name: "图片", extensions: ["png", "webp", "svg"] }]
  });
  if (!picked || picked.length === 0) {
    return { ok: false, error: "", canceled: true };
  }
  return readImageFileAsDataUrl(picked[0]);
}
function savePetImageFromDataUrl(dataUrl, rawName) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return { ok: false, error: "图片数据格式不正确" };
  const mime = m[1].toLowerCase();
  const isB64 = !!m[2];
  const mimeToExt = {
    "image/png": ".png",
    "image/webp": ".webp",
    "image/svg+xml": ".svg"
  };
  const ext = mimeToExt[mime];
  if (!ext) return { ok: false, error: `不支持的图片类型：${mime}` };
  let buf;
  try {
    buf = isB64 ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  } catch {
    return { ok: false, error: "图片数据解码失败" };
  }
  if (buf.byteLength > IMAGE_MAX_BYTES) {
    return { ok: false, error: "图片超过 5MB 上限" };
  }
  const name = (rawName || "").trim().slice(0, 30) || "我的桌宠";
  const id = deriveImageId(name);
  const assetName = `idle${ext}`;
  const stageDir = node_path.join(importedPacksRoot(), `.stage-${id}`);
  try {
    node_fs.mkdirSync(stageDir, { recursive: true });
    node_fs.writeFileSync(node_path.join(stageDir, assetName), buf);
    const manifest = {
      id,
      name,
      version: "1.0.0",
      description: "从一张图片生成的桌宠",
      states: { idle: assetName }
    };
    node_fs.writeFileSync(node_path.join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return importPetPackFromDir(stageDir);
  } catch (err) {
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      if (node_fs.existsSync(stageDir)) node_fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {
    }
  }
}
function importPetPackFromDir(srcDir) {
  const res = readAndValidateManifest(srcDir);
  if (!res.ok) return { ok: false, error: res.error };
  const { id } = res.manifest;
  const finalDir = importedPackDir(id);
  const tmpDir = node_path.join(importedPacksRoot(), `.tmp-${id}`);
  try {
    node_fs.mkdirSync(importedPacksRoot(), { recursive: true });
    if (node_fs.existsSync(tmpDir)) node_fs.rmSync(tmpDir, { recursive: true, force: true });
    node_fs.cpSync(srcDir, tmpDir, { recursive: true });
    const recheck = readAndValidateManifest(tmpDir);
    if (!recheck.ok) {
      node_fs.rmSync(tmpDir, { recursive: true, force: true });
      return { ok: false, error: `复制后校验失败：${recheck.error}` };
    }
    if (node_fs.existsSync(finalDir)) node_fs.rmSync(finalDir, { recursive: true, force: true });
    const { renameSync } = require("node:fs");
    try {
      renameSync(tmpDir, finalDir);
    } catch {
      node_fs.cpSync(tmpDir, finalDir, { recursive: true });
      node_fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return { ok: true, petId: id };
  } catch (err) {
    try {
      if (node_fs.existsSync(tmpDir)) node_fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
    }
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
function deleteImportedPack(petId) {
  if (!/^[a-z0-9_-]{2,40}$/.test(petId)) {
    return { ok: false, error: "非法的皮肤包 id" };
  }
  const dir = importedPackDir(petId);
  if (!node_fs.existsSync(dir)) return { ok: true };
  try {
    node_fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `删除失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
function renameImportedPack(petId, rawName) {
  if (!/^[a-z0-9_-]{2,40}$/.test(petId)) {
    return { ok: false, error: "非法的皮肤包 id" };
  }
  const name = (rawName || "").trim();
  if (name.length < 1 || name.length > 30) {
    return { ok: false, error: "名字要 1-30 个字" };
  }
  const dir = importedPackDir(petId);
  const manifestPath = node_path.join(dir, "manifest.json");
  if (!node_fs.existsSync(manifestPath)) {
    return { ok: false, error: "这个皮肤包不存在或不可改名" };
  }
  try {
    const { readFileSync, renameSync } = require("node:fs");
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    raw.name = name;
    const tmp = node_path.join(dir, `.manifest-${Date.now().toString(36)}.tmp`);
    node_fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
    renameSync(tmp, manifestPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `改名失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
function revealImportedPacksFolder() {
  const root = importedPacksRoot();
  try {
    node_fs.mkdirSync(root, { recursive: true });
  } catch {
  }
  void electron.shell.openPath(root);
}
const AGENT_ENVS = ["terminal", "vscode", "desktop"];
const IPC = {
  GetSnapshot: "pet:get-snapshot",
  UpdateSettings: "pet:update-settings",
  SelectPet: "pet:select-pet",
  ResetPetPosition: "pet:reset-position",
  ShowPet: "pet:show",
  HidePet: "pet:hide",
  QuitApp: "pet:quit",
  PetClicked: "pet:clicked",
  DragStart: "pet:drag-start",
  DragMove: "pet:drag-move",
  DragStop: "pet:drag-stop",
  SetInteractive: "pet:set-interactive",
  // v0.2：dev 模拟 Agent 事件（走真实事件同一处理链路）
  AgentSimulate: "pet:agent-simulate",
  // v0.3.3：合并后的「导入皮肤」——一个入口同时接受图片 / 皮肤包文件夹
  PickSkin: "pet:pick-skin",
  // v0.3：皮肤包导入 / 删除 / 打开导入目录
  ImportPetPack: "pet:import-pack",
  // v0.3.1：单图导入两段式（渲染进程中间抠图）——先选图拿数据，再存抠好的图
  PickPetImage: "pet:pick-image",
  SavePetImage: "pet:save-image",
  DeleteImportedPetPack: "pet:delete-pack",
  // v0.3.3：重命名一个已导入皮肤包的显示名
  RenameImportedPetPack: "pet:rename-pack",
  RevealPetPacksFolder: "pet:reveal-packs-folder",
  OnSnapshot: "pet:snapshot",
  OnShowBubble: "pet:show-bubble",
  OnHideBubble: "pet:hide-bubble",
  // v0.2.1：只切宠物状态、不弹气泡（用于 Agent working 时的安静思考视觉）
  OnSetState: "pet:set-state",
  OnRecheckHover: "pet:recheck-hover"
};
const DEFAULT_SETTINGS = {
  selectedPetId: "dango",
  petScale: 1,
  bubblesEnabled: true,
  bubbleFrequencySeconds: 180,
  petPosition: null,
  petVisible: true,
  bubbleAnchor: { angleDeg: 270, distance: 110 },
  // v0.3.1：单图导入默认自动去纯色背景
  autoRemoveBackground: true,
  // v0.2 Agent 监控：两个子开关默认开启，提示音默认关闭
  codexMonitoringEnabled: true,
  claudeMonitoringEnabled: true,
  // v0.3.3：默认监控全部三个环境
  codexMonitoringEnvs: ["terminal", "vscode", "desktop"],
  claudeMonitoringEnvs: ["terminal", "vscode", "desktop"],
  agentProgressBubblesEnabled: true,
  agentCompletionSoundEnabled: false
};
const AGENT_POLL_INTERVAL_MS = 1e3;
const AGENT_MAX_FILES_PER_SOURCE = 12;
const AGENT_TAIL_BYTES = 96e3;
const AGENT_EVENT_FRESH_MS = 12e4;
const AGENT_SEEN_IDS_MAX = 500;
const AGENT_SESSION_EXPIRE_MS = 12e4;
const AGENT_THINKING_STATE_MS = AGENT_POLL_INTERVAL_MS + 3e3;
const AGENT_TERMINAL_BUBBLE_MS = 6e3;
const AGENT_TERMINAL_COALESCE_MS = 900;
const AGENT_SCAN_MAX_DEPTH = 5;
const PET_WINDOW = { width: 600, height: 600 };
const PET_CENTER = { x: PET_WINDOW.width / 2, y: PET_WINDOW.height / 2 };
const PET_BODY_SIZE = 140;
const PET_SCALE_MIN = 0.7;
const PET_SCALE_MAX = 1.5;
const BUBBLE_MIN_DISTANCE = 96;
const BUBBLE_MAX_DISTANCE = 180;
const BUBBLE_FREQ_MIN_SECONDS = 30;
const BUBBLE_FREQ_MAX_SECONDS = 3600;
const SCREEN_EDGE_MARGIN = 24;
const IDLE_BUBBLE_LINES = [
  "我在这儿。",
  "陪你一会儿。",
  "今天也慢慢来。",
  "嗯，一切都还好。",
  "记得偶尔看看远处。",
  "你做得已经很好了。",
  "累了的话，歇一下也可以。",
  "我会安静待着的。"
];
const CLICK_BUBBLE_LINES = [
  "点到我啦。",
  "嘿嘿，在呢。",
  "干嘛戳我呀～",
  "被你发现了。",
  "我在认真陪你哦。"
];
const BUBBLE_DURATION_MS = 5e3;
const SOURCE_NAME = {
  codex: "Codex",
  claude: "Claude Code"
};
const STOP_REASON_PHRASE = {
  completed: "输出结束了，任务完成 ✅",
  needs_input: "停下来了，需要你处理一下 🙋",
  error: "出错停下了 ⚠️",
  interrupted: "输出被中断了 ⛔"
};
function buildAgentBubbleText(event) {
  const who = SOURCE_NAME[event.source];
  const reason = event.reason ?? (event.kind === "failed" ? "error" : event.kind === "needs_attention" ? "needs_input" : "completed");
  const head = `${who} ${STOP_REASON_PHRASE[reason]}`;
  const detail = event.detail?.trim();
  if (detail && (reason === "error" || reason === "interrupted" || reason === "needs_input")) {
    return `${head}
${detail}`;
  }
  return head;
}
const BUBBLE_JITTER = 0.35;
const BUBBLE_MIN_INTERVAL_MS = 15e3;
const INTERRUPTED_KEYWORDS = [
  "aborted",
  "interrupted",
  "cancelled",
  "canceled",
  "stopped by user",
  "被中断",
  "已中断",
  "中止",
  "已取消",
  "被取消"
];
const ERROR_KEYWORDS = [
  "traceback (most recent call last)",
  "cannot continue",
  "fatal error",
  "unhandled exception",
  "command failed with exit code",
  "no such file or directory",
  "报错如下",
  "执行失败",
  "运行失败",
  "构建失败",
  "编译失败",
  "无法继续",
  "无法完成任务"
];
const NEEDS_INPUT_KEYWORDS = [
  // 授权 / 批准（高置信）
  "awaiting your approval",
  "waiting for approval",
  "grant permission",
  "grant access",
  "do you want to proceed",
  "need your permission",
  "需要你授权",
  "需要您授权",
  "请授权",
  "是否允许",
  "请批准",
  "等待授权",
  // 抛问题 / 选项（高置信）
  "which option would you like",
  "please choose one",
  "please select an option",
  "let me know which",
  "请从以下选项",
  "请选择一个",
  "你想选哪",
  // 求助 / 验证（高置信）
  "please verify",
  "please confirm it works",
  "can you test",
  "请你验证",
  "帮我验证一下",
  "请确认是否正常",
  // 明确等待输入
  "waiting for input",
  "waiting for your input",
  "waiting for your response",
  "等待你的输入",
  "等待您的输入"
];
const COMPLETED_KEYWORDS = [
  "done",
  "complete",
  "completed",
  "fixed",
  "ready",
  "implemented",
  "finished",
  "all set",
  "完成",
  "已完成",
  "搞定",
  "修好了",
  "实现了",
  "处理好了"
];
function firstMatch(haystackLower, keywords) {
  for (const k of keywords) {
    if (haystackLower.includes(k.toLowerCase())) return k;
  }
  return null;
}
function extractDetail(text, hitKeyword) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (hitKeyword) {
    const lines = text.split(/\r?\n/);
    const hitLine = lines.find((l) => l.toLowerCase().includes(hitKeyword.toLowerCase()));
    if (hitLine) {
      const t = hitLine.replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 80);
    }
  }
  const firstSentence = clean.split(/(?<=[。！？!?.])\s/)[0] ?? clean;
  return firstSentence.slice(0, 80);
}
function classifyStopText(text) {
  if (!text || typeof text !== "string") return null;
  const lower = text.toLowerCase();
  const interruptedHit = firstMatch(lower, INTERRUPTED_KEYWORDS);
  if (interruptedHit) {
    return { kind: "failed", reason: "interrupted", detail: extractDetail(text, interruptedHit) };
  }
  const errorHit = firstMatch(lower, ERROR_KEYWORDS);
  if (errorHit) {
    return { kind: "failed", reason: "error", detail: extractDetail(text, errorHit) };
  }
  const needsHit = firstMatch(lower, NEEDS_INPUT_KEYWORDS);
  if (needsHit) {
    return { kind: "needs_attention", reason: "needs_input", detail: extractDetail(text, needsHit) };
  }
  const doneHit = firstMatch(lower, COMPLETED_KEYWORDS);
  if (doneHit) {
    return { kind: "done", reason: "completed", detail: extractDetail(text, doneHit) };
  }
  return null;
}
function findRecentFiles(root, exts, maxFiles, maxDepth) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = node_fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = node_path.join(dir, name);
      let stat;
      try {
        stat = node_fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (stat.isFile() && exts.some((e) => name.endsWith(e))) {
        found.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, maxFiles).map((f) => f.path);
}
function readJsonlHead(filePath, maxBytes = 8e3) {
  let fd = null;
  try {
    const stat = node_fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    fd = node_fs.openSync(filePath, "r");
    let read = 0;
    while (read < length) {
      const n = node_fs.readSync(fd, buffer, read, length - read, read);
      if (n <= 0) break;
      read += n;
    }
    const text = buffer.toString("utf8", 0, read);
    const lines = text.split("\n");
    if (length < stat.size && lines.length > 0) lines.pop();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed);
        }
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        node_fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function readJsonlTail(filePath, maxBytes = 96e3) {
  let fd = null;
  try {
    const stat = node_fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const size = stat.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    fd = node_fs.openSync(filePath, "r");
    let read = 0;
    while (read < length) {
      const n = node_fs.readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buffer.toString("utf8", 0, read);
    const lines = text.split("\n");
    if (start > 0 && lines.length > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed);
        }
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        node_fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function claudeProjectsRoot() {
  return node_path.join(node_os.homedir(), ".claude", "projects");
}
function extractAssistantText(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const it = item;
      if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
    }
  }
  return parts.join("\n");
}
function getTimestampMs$1(line) {
  const raw = line.timestamp;
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}
function entrypointToEnv(entrypoint) {
  if (typeof entrypoint !== "string") return null;
  if (entrypoint === "claude-vscode") return "vscode";
  if (entrypoint === "claude-desktop") return "desktop";
  if (entrypoint === "cli" || entrypoint === "sdk-cli") return "terminal";
  return "terminal";
}
function sessionKeyFor(filePath, line) {
  const sid = line.sessionId;
  if (typeof sid === "string" && sid) return `claude:${sid}`;
  return `claude:${node_path.basename(node_path.dirname(filePath))}/${node_path.basename(filePath)}`;
}
function parseClaudeFile(filePath, nowMs) {
  const lines = readJsonlTail(filePath, AGENT_TAIL_BYTES);
  const events = [];
  let env = "terminal";
  for (const line of lines) {
    const ep = entrypointToEnv(line.entrypoint);
    if (ep) env = ep;
  }
  for (const line of lines) {
    const type = line.type;
    const message = line.message && typeof line.message === "object" ? line.message : {};
    const tsMs = getTimestampMs$1(line) || nowMs;
    const sessionKey = sessionKeyFor(filePath, line);
    let kind = null;
    let text = "";
    let reason;
    let detail;
    if (type === "assistant") {
      const stopReason = message.stop_reason;
      if (stopReason === "tool_use") {
        kind = "working";
        text = "Claude Code 正在处理任务";
      } else if (stopReason === "end_turn") {
        const body = extractAssistantText(message);
        const classified = classifyStopText(body);
        if (classified) {
          kind = classified.kind;
          reason = classified.reason;
          detail = classified.detail;
        } else {
          kind = "done";
          reason = "completed";
        }
        text = body.slice(0, 200);
      }
    } else if (type === "last-prompt" || type === "user") {
      kind = "working";
      text = "Claude Code 正在处理任务";
    }
    if (kind) {
      events.push({
        id: "",
        source: "claude",
        env,
        sessionKey,
        kind,
        message: text,
        timestampMs: tsMs,
        rawPath: filePath,
        reason,
        detail
      });
    }
  }
  return events;
}
function scanClaude(nowMs) {
  const files = findRecentFiles(
    claudeProjectsRoot(),
    [".jsonl"],
    AGENT_MAX_FILES_PER_SOURCE,
    AGENT_SCAN_MAX_DEPTH
  );
  const all = [];
  for (const f of files) {
    all.push(...parseClaudeFile(f, nowMs));
  }
  return all;
}
function codexSessionsRoot() {
  return node_path.join(node_os.homedir(), ".codex", "sessions");
}
function extractOutputText(payload) {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const it = item;
      if ((it.type === "output_text" || it.type === "text") && typeof it.text === "string") {
        parts.push(it.text);
      }
    }
  }
  return parts.join("\n");
}
function payloadReason(payload) {
  for (const key of ["reason", "message", "error", "detail"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim().slice(0, 80);
  }
  return void 0;
}
function codexMetaToEnv(payload) {
  const originator = payload.originator;
  if (typeof originator === "string" && originator) {
    const o = originator.toLowerCase();
    if (o.includes("desktop") || o.includes("app")) return "desktop";
    if (o.includes("vscode") || o.includes("vs code")) return "vscode";
    if (o.includes("cli") || o.includes("terminal") || o.includes("tui")) return "terminal";
  }
  const source = payload.source;
  if (typeof source === "string" && source) {
    const s = source.toLowerCase();
    if (s.includes("desktop") || s.includes("app")) return "desktop";
    if (s.includes("vscode") || s.includes("vs code")) return "vscode";
    if (s.includes("cli") || s.includes("terminal") || s.includes("tui")) return "terminal";
  }
  return null;
}
function getTimestampMs(line) {
  const raw = line.timestamp ?? line.ts;
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return 0;
}
function parseCodexFile(filePath, nowMs) {
  const sessionKey = node_path.basename(filePath);
  const lines = readJsonlTail(filePath, AGENT_TAIL_BYTES);
  const events = [];
  let env = "terminal";
  for (const head of readJsonlHead(filePath)) {
    const payload = head.payload && typeof head.payload === "object" ? head.payload : head;
    const e = codexMetaToEnv(payload);
    if (e) {
      env = e;
      break;
    }
  }
  for (const line of lines) {
    const type = line.type;
    const payload = line.payload && typeof line.payload === "object" ? line.payload : {};
    const payloadType = payload.type;
    const tsMs = getTimestampMs(line) || nowMs;
    let kind = null;
    let message = "";
    let reason;
    let detail;
    if (type === "event_msg") {
      switch (payloadType) {
        case "task_started":
          kind = "working";
          message = "Codex 开始处理任务";
          break;
        case "task_complete":
          kind = "done";
          reason = "completed";
          message = "Codex 完成了任务";
          break;
        case "turn_aborted":
          kind = "failed";
          reason = "interrupted";
          detail = payloadReason(payload);
          message = "Codex 任务被中断";
          break;
      }
    } else if (type === "response_item") {
      if (payloadType === "reasoning" || payloadType === "function_call") {
        kind = "working";
        message = "Codex 正在处理任务";
      } else if (payloadType === "message" && payload.role === "assistant") {
        const text = extractOutputText(payload);
        const classified = classifyStopText(text);
        if (classified) {
          kind = classified.kind;
          reason = classified.reason;
          detail = classified.detail;
          message = text.slice(0, 200);
        }
      }
    }
    if (kind) {
      events.push({
        id: "",
        // 由 monitor 统一生成稳定 id
        source: "codex",
        env,
        sessionKey,
        kind,
        message,
        timestampMs: tsMs,
        rawPath: filePath,
        reason,
        detail
      });
    }
  }
  return events;
}
function scanCodex(nowMs) {
  const files = findRecentFiles(
    codexSessionsRoot(),
    [".jsonl"],
    AGENT_MAX_FILES_PER_SOURCE,
    AGENT_SCAN_MAX_DEPTH
  );
  const all = [];
  for (const f of files) {
    all.push(...parseCodexFile(f, nowMs));
  }
  return all;
}
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = h * 33 ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}
function eventId(e) {
  return `${e.source}:${e.rawPath ?? ""}:${e.timestampMs}:${e.kind}:${hashString(e.message)}`;
}
const TERMINAL_KINDS = /* @__PURE__ */ new Set([
  "done",
  "needs_attention",
  "failed"
]);
class AgentMonitor {
  config;
  deps;
  timer = null;
  primed = false;
  /** 已处理过的事件 id（去重）。用 Set + 插入序数组维护上限 */
  seenIds = /* @__PURE__ */ new Set();
  seenOrder = [];
  /** 每个 session 最近一次出现 working 的时间；终态提醒需先见过 working */
  workingSeenAt = /* @__PURE__ */ new Map();
  /** 活跃会话：sessionKey -> {source, lastSeenAt} */
  activeSessions = /* @__PURE__ */ new Map();
  lastCheckedAt = null;
  lastEvent = null;
  lastError = null;
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
  }
  /** codex 是否真的在监控：开关开 且 至少选了一个环境 */
  codexActive() {
    return this.config.codexEnabled && this.config.codexEnvs.length > 0;
  }
  /** claude 是否真的在监控：开关开 且 至少选了一个环境 */
  claudeActive() {
    return this.config.claudeEnabled && this.config.claudeEnvs.length > 0;
  }
  start() {
    this.stop();
    if (!this.codexActive() && !this.claudeActive()) return;
    this.primed = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), AGENT_POLL_INTERVAL_MS);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** 设置变化时用新配置重启（例如关掉某个来源） */
  updateConfig(config) {
    this.config = config;
    this.start();
  }
  getStatus() {
    const now = this.deps.now();
    const active = [...this.activeSessions.entries()].filter(([, v]) => now - v.lastSeenAt <= AGENT_SESSION_EXPIRE_MS).map(([sessionKey, v]) => ({ source: v.source, sessionKey, lastSeenAt: v.lastSeenAt }));
    return {
      enabled: this.codexActive() || this.claudeActive(),
      lastEvent: this.lastEvent,
      activeSessions: active,
      lastCheckedAt: this.lastCheckedAt,
      error: this.lastError
    };
  }
  /** 事件是否通过「按环境」过滤：看它所属 source 的环境集合是否包含它的 env */
  passesEnvFilter(e) {
    const envs = e.source === "codex" ? this.config.codexEnvs : this.config.claudeEnvs;
    return envs.includes(e.env);
  }
  /**
   * 把一条事件送入统一处理链路。真实扫描和 dev 模拟都走这里。
   * @param fromScan true=来自轮询扫描（受 prime 影响）；false=来自 dev 模拟（总是派发）
   */
  ingest(raw, fromScan) {
    const event = { ...raw, id: raw.id || eventId(raw) };
    const log = this.deps.log;
    if (this.seenIds.has(event.id)) {
      if (log && TERMINAL_KINDS.has(event.kind)) {
        log(`SKIP seen: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`);
      }
      return;
    }
    if (event.kind === "working") {
      this.workingSeenAt.set(event.sessionKey, event.timestampMs);
    }
    this.activeSessions.set(event.sessionKey, {
      source: event.source,
      lastSeenAt: event.timestampMs
    });
    this.markSeen(event.id);
    if (fromScan && !this.primed) {
      if (log && TERMINAL_KINDS.has(event.kind)) {
        log(`SKIP prime: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`);
      }
      return;
    }
    if (fromScan && TERMINAL_KINDS.has(event.kind)) {
      const workingAt = this.workingSeenAt.get(event.sessionKey);
      if (workingAt === void 0) {
        if (log) log(`SKIP no-working: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`);
        return;
      }
    }
    if (log && TERMINAL_KINDS.has(event.kind)) {
      log(`NOTIFY: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`);
    }
    this.lastEvent = event;
    this.deps.onEvent(event);
  }
  markSeen(id) {
    this.seenIds.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > AGENT_SEEN_IDS_MAX) {
      const oldest = this.seenOrder.shift();
      if (oldest !== void 0) this.seenIds.delete(oldest);
    }
  }
  tick() {
    const now = this.deps.now();
    this.lastCheckedAt = now;
    this.lastError = null;
    try {
      const events = [];
      if (this.codexActive()) events.push(...scanCodex(now));
      if (this.claudeActive()) events.push(...scanClaude(now));
      const fresh = events.filter(
        (e) => now - e.timestampMs <= AGENT_EVENT_FRESH_MS && this.passesEnvFilter(e)
      );
      const log = this.deps.log;
      if (log) {
        const terms = events.filter((e) => TERMINAL_KINDS.has(e.kind));
        if (terms.length > 0) {
          const staleN = terms.filter((e) => now - e.timestampMs > AGENT_EVENT_FRESH_MS).length;
          const envCutN = terms.filter((e) => !this.passesEnvFilter(e)).length;
          log(
            `tick: 终态${terms.length}条 [${terms.map((e) => `${e.env}/${e.kind}/${Math.round((now - e.timestampMs) / 1e3)}s`).join(",")}] 过期${staleN} env过滤${envCutN}`
          );
        }
      }
      fresh.sort((a, b) => a.timestampMs - b.timestampMs);
      for (const e of fresh) this.ingest(e, true);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.primed = true;
    }
  }
}
function sanitizeEnvs(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const v of input) {
    if (typeof v === "string" && AGENT_ENVS.includes(v)) {
      const env = v;
      if (!out.includes(env)) out.push(env);
    }
  }
  return out;
}
const store = new Store({ defaults: DEFAULT_SETTINGS });
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...sanitize(store.store) };
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function isValidPosition(value) {
  if (typeof value !== "object" || value === null) return false;
  const pos = value;
  return Number.isFinite(pos.x) && Number.isFinite(pos.y);
}
function sanitizeBubbleAnchor(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const a = value;
  if (!Number.isFinite(a.angleDeg) || !Number.isFinite(a.distance)) return void 0;
  const angleDeg = (a.angleDeg % 360 + 360) % 360;
  const distance = clamp(a.distance, BUBBLE_MIN_DISTANCE, BUBBLE_MAX_DISTANCE);
  return { angleDeg, distance };
}
function isSafePetId(value) {
  return typeof value === "string" && /^[a-z0-9:_-]{2,80}$/.test(value);
}
function sanitize(partial) {
  const next = {};
  if (isSafePetId(partial.selectedPetId)) {
    next.selectedPetId = partial.selectedPetId;
  }
  if (typeof partial.petScale === "number" && Number.isFinite(partial.petScale)) {
    next.petScale = clamp(partial.petScale, PET_SCALE_MIN, PET_SCALE_MAX);
  }
  if (typeof partial.bubblesEnabled === "boolean") {
    next.bubblesEnabled = partial.bubblesEnabled;
  }
  if (typeof partial.bubbleFrequencySeconds === "number" && Number.isFinite(partial.bubbleFrequencySeconds)) {
    next.bubbleFrequencySeconds = clamp(
      Math.round(partial.bubbleFrequencySeconds),
      BUBBLE_FREQ_MIN_SECONDS,
      BUBBLE_FREQ_MAX_SECONDS
    );
  }
  if ("petPosition" in partial) {
    if (partial.petPosition === null) next.petPosition = null;
    else if (isValidPosition(partial.petPosition)) {
      next.petPosition = { x: Math.round(partial.petPosition.x), y: Math.round(partial.petPosition.y) };
    }
  }
  if (typeof partial.petVisible === "boolean") {
    next.petVisible = partial.petVisible;
  }
  if ("bubbleAnchor" in partial) {
    const anchor = sanitizeBubbleAnchor(partial.bubbleAnchor);
    if (anchor) next.bubbleAnchor = anchor;
  }
  if (typeof partial.codexMonitoringEnabled === "boolean") {
    next.codexMonitoringEnabled = partial.codexMonitoringEnabled;
  }
  if (typeof partial.claudeMonitoringEnabled === "boolean") {
    next.claudeMonitoringEnabled = partial.claudeMonitoringEnabled;
  }
  {
    const codexEnvs = sanitizeEnvs(partial.codexMonitoringEnvs);
    if (codexEnvs) next.codexMonitoringEnvs = codexEnvs;
    const claudeEnvs = sanitizeEnvs(partial.claudeMonitoringEnvs);
    if (claudeEnvs) next.claudeMonitoringEnvs = claudeEnvs;
  }
  if (typeof partial.agentProgressBubblesEnabled === "boolean") {
    next.agentProgressBubblesEnabled = partial.agentProgressBubblesEnabled;
  }
  if (typeof partial.agentCompletionSoundEnabled === "boolean") {
    next.agentCompletionSoundEnabled = partial.agentCompletionSoundEnabled;
  }
  if (typeof partial.autoRemoveBackground === "boolean") {
    next.autoRemoveBackground = partial.autoRemoveBackground;
  }
  return next;
}
function patchSettings(partial) {
  const next = { ...getSettings(), ...sanitize(partial) };
  store.set(next);
  return next;
}
const rendererDevUrl$1 = process.env["ELECTRON_RENDERER_URL"];
function loadRoute(win, hash) {
  if (rendererDevUrl$1) {
    void win.loadURL(`${rendererDevUrl$1}#${hash}`);
  } else {
    void win.loadFile(node_path.join(__dirname, "../renderer/index.html"), { hash });
  }
}
function defaultPetPosition() {
  const { workArea } = electron.screen.getPrimaryDisplay();
  const half = PET_BODY_SIZE / 2;
  const petRight = workArea.x + workArea.width - SCREEN_EDGE_MARGIN;
  const petBottom = workArea.y + workArea.height - SCREEN_EDGE_MARGIN;
  const petCenterX = petRight - half;
  const petCenterY = petBottom - half;
  return {
    x: Math.round(petCenterX - PET_CENTER.x),
    y: Math.round(petCenterY - PET_CENTER.y)
  };
}
function clampToWorkArea(pos, petScale = 1) {
  const petCenter = {
    x: pos.x + PET_CENTER.x,
    y: pos.y + PET_CENTER.y
  };
  const display = electron.screen.getDisplayMatching({
    x: Math.round(petCenter.x - 1),
    y: Math.round(petCenter.y - 1),
    width: 2,
    height: 2
  });
  const b = display.bounds;
  const scale = Number.isFinite(petScale) && petScale > 0 ? petScale : 1;
  const half = PET_BODY_SIZE * scale / 2;
  const insetLeft = PET_CENTER.x - half;
  const insetTop = PET_CENTER.y - half;
  const visSize = PET_BODY_SIZE * scale;
  const minX = b.x - insetLeft;
  const maxX = b.x + b.width - insetLeft - visSize;
  const minY = b.y - insetTop;
  const maxY = b.y + b.height - insetTop - visSize;
  const clamp2 = (v, lo, hi) => hi >= lo ? Math.min(Math.max(v, lo), hi) : lo;
  return {
    x: Math.round(clamp2(pos.x, minX, maxX)),
    y: Math.round(clamp2(pos.y, minY, maxY))
  };
}
function createPetWindow(position) {
  const win = new electron.BrowserWindow({
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // 允许窗口位置越过屏幕边缘（含顶部菜单栏区域）。
    // 没有它时 macOS 会把窗口 y 钳制在工作区顶部（菜单栏下方），
    // 宠物往上拖只能到"离顶 1/3"处就卡住——这是宠物无法贴到屏幕最上方的真因。
    enableLargerThanScreen: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // v0.3.1：皮肤包素材用 <img src="file://..."> 渲染；dev 下 renderer 跑在
      // http://localhost 源，浏览器同源策略会拦 file:// 资源，导致导入/官方皮肤包
      // 图片加载失败（naturalWidth=0）。关掉 webSecurity 放行本地素材加载。
      webSecurity: false
    }
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(true, { forward: true });
  loadRoute(win, "pet");
  return win;
}
function createSettingsWindow() {
  const win = new electron.BrowserWindow({
    // v0.3.2：设置台重构为「左侧导航 + 右侧面板」，用更宽的矩形给内容留白
    width: 760,
    height: 620,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "桌宠设置",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 见宠物窗同处注释：放行皮肤包 file:// 素材在 dev 的 http 源下加载。
      // 设置窗要显示皮肤包卡片缩略图，同样需要。
      webSecurity: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  win.once("ready-to-show", () => {
    if (process.platform === "darwin") electron.app.focus({ steal: true });
    win.show();
    win.focus();
  });
  loadRoute(win, "settings");
  return win;
}
const appIcon = path.join(__dirname, "./chunks/icon-C1p1o-NA.png");
let tray = null;
let handlers = null;
function createTray(h) {
  handlers = h;
  const iconPath = electron.app.isPackaged ? node_path.join(process.resourcesPath, "icon.icns") : appIcon;
  const icon = electron.nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new electron.Tray(icon);
  tray.setToolTip("桌宠");
  tray.setTitle("PET");
  tray.on("click", () => tray?.popUpContextMenu(buildTrayMenu()));
  tray.on("right-click", () => tray?.popUpContextMenu(buildTrayMenu()));
  refreshTrayMenu();
}
function refreshTrayMenu() {
  if (!tray || !handlers) return;
  tray.setContextMenu(buildTrayMenu());
}
function buildTrayMenu() {
  if (!handlers) return electron.Menu.buildFromTemplate([]);
  const h = handlers;
  return electron.Menu.buildFromTemplate([
    { label: h.isPetVisible() ? "隐藏桌宠" : "显示桌宠", click: () => h.togglePet() },
    { label: "设置…", click: () => h.openSettings() },
    { label: "重置位置", click: () => h.resetPosition() },
    { type: "separator" },
    { label: "退出", click: () => h.quit() }
  ]);
}
let petWindow = null;
let settingsWindow = null;
let bubbleTimer = null;
let dragOrigin = null;
const rendererDevUrl = process.env["ELECTRON_RENDERER_URL"];
let activationCanOpenSettings = false;
function debugLaunch(message) {
  if (process.env["DESKTOP_PET_DEBUG_LAUNCH"] !== "1") return;
  node_fs.appendFileSync("/tmp/desktoppet-launch.log", `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}
`);
}
debugLaunch(`main loaded argv=${JSON.stringify(process.argv)}`);
process.on("uncaughtException", (err) => {
  debugLaunch(`UNCAUGHT: ${err && err.stack ? err.stack : String(err)}`);
  throw err;
});
function safeSetPetPosition(x, y, from) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    debugLaunch(`SKIP setPosition from ${from}: non-finite (${x},${y})`);
    return;
  }
  const safe = clampToWorkArea({ x, y }, getSettings().petScale);
  const INT32_MAX = 2147483647;
  if (!Number.isInteger(safe.x) || !Number.isInteger(safe.y) || safe.x > INT32_MAX || safe.x < -INT32_MAX || safe.y > INT32_MAX || safe.y < -INT32_MAX) {
    debugLaunch(`SKIP setPosition from ${from}: in=(${x},${y}) safe=(${safe.x},${safe.y})`);
    return;
  }
  try {
    petWindow.setPosition(safe.x, safe.y);
  } catch (err) {
    debugLaunch(`setPosition threw from ${from} safe=(${safe.x},${safe.y}): ${String(err)}`);
  }
}
function isAllowedRendererUrl(url) {
  if (!url) return false;
  try {
    const actual = new URL(url);
    if (rendererDevUrl) {
      return actual.origin === new URL(rendererDevUrl).origin;
    }
    return actual.protocol === "file:" && actual.pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}
function isTrustedSender(event) {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  return isAllowedRendererUrl(url);
}
function requireTrustedSender(event) {
  if (!isTrustedSender(event)) {
    throw new Error("Blocked IPC from an untrusted renderer");
  }
}
function registerNavigationGuards() {
  electron.app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedRendererUrl(url)) event.preventDefault();
    });
  });
}
function buildSnapshot() {
  return {
    settings: getSettings(),
    pets: getPetCatalog(),
    appVersion: electron.app.getVersion(),
    agent: agentStatus(),
    isPackaged: electron.app.isPackaged
  };
}
function broadcastSnapshot() {
  const snapshot = buildSnapshot();
  for (const win of electron.BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.OnSnapshot, snapshot);
  }
}
function pickRandom(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}
function sendBubble(text, state, durationMs = BUBBLE_DURATION_MS, sound = false, interactive = false) {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
  const bounds = petWindow.getBounds();
  const display = electron.screen.getDisplayMatching(bounds);
  const payload = {
    text,
    state,
    durationMs,
    windowRect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    // 用 workArea 而不是整屏 bounds：气泡被收拢到菜单栏/Dock 后面等于没收拢
    displayBounds: display.workArea,
    sound,
    interactive
  };
  petWindow.webContents.send(IPC.OnShowBubble, payload);
}
function sendPetState(state, durationMs) {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
  const payload = { state, durationMs };
  petWindow.webContents.send(IPC.OnSetState, payload);
}
function setPetInteractive(interactive) {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}
function recheckPetInteractivity() {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
  const cursor = electron.screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
  if (!inside) {
    setPetInteractive(false);
    return;
  }
  const point = {
    x: Math.round(cursor.x - bounds.x),
    y: Math.round(cursor.y - bounds.y)
  };
  petWindow.webContents.send(IPC.OnRecheckHover, point);
}
function isCursorOverPetWindow() {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return false;
  const cursor = electron.screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  return cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
}
function scheduleIdleBubble() {
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  const settings = getSettings();
  if (!settings.bubblesEnabled || !settings.petVisible) return;
  const jitter = 1 - BUBBLE_JITTER + Math.random() * BUBBLE_JITTER * 2;
  const delay = Math.max(BUBBLE_MIN_INTERVAL_MS, settings.bubbleFrequencySeconds * 1e3 * jitter);
  bubbleTimer = setTimeout(() => {
    sendBubble(pickRandom(IDLE_BUBBLE_LINES), "attention");
    scheduleIdleBubble();
  }, delay);
}
let agentMonitor = null;
function agentKindToPetState(kind) {
  switch (kind) {
    case "working":
      return "thinking";
    case "done":
      return "happy";
    case "needs_attention":
      return "attention";
    case "failed":
      return "failed";
  }
}
function handleAgentEvent(event) {
  if (event.kind === "working") {
    sendPetState("thinking", AGENT_THINKING_STATE_MS);
    broadcastSnapshot();
    return;
  }
  pendingTerminals.push(event);
  if (!terminalFlushTimer) {
    terminalFlushTimer = setTimeout(flushTerminalBubbles, AGENT_TERMINAL_COALESCE_MS);
  }
  broadcastSnapshot();
}
let pendingTerminals = [];
let terminalFlushTimer = null;
function flushTerminalBubbles() {
  terminalFlushTimer = null;
  const batch = pendingTerminals;
  pendingTerminals = [];
  if (batch.length === 0) return;
  const soundOn = getSettings().agentCompletionSoundEnabled;
  const hasDone = batch.some((e) => e.kind === "done");
  const sound = soundOn && hasDone;
  if (batch.length === 1) {
    const e = batch[0];
    sendBubble(buildAgentBubbleText(e), agentKindToPetState(e.kind), AGENT_TERMINAL_BUBBLE_MS, sound);
    return;
  }
  const kinds = new Set(batch.map((e) => e.kind));
  const worst = kinds.has("failed") ? "failed" : kinds.has("needs_attention") ? "needs_attention" : "done";
  const doneN = batch.filter((e) => e.kind === "done").length;
  const needN = batch.filter((e) => e.kind === "needs_attention").length;
  const failN = batch.filter((e) => e.kind === "failed").length;
  const parts = [];
  if (doneN) parts.push(`${doneN} 个完成`);
  if (needN) parts.push(`${needN} 个需要你`);
  if (failN) parts.push(`${failN} 个出错/中断`);
  const text = `${batch.length} 个任务停下来了：${parts.join("，")}`;
  sendBubble(text, agentKindToPetState(worst), AGENT_TERMINAL_BUBBLE_MS, sound);
}
function agentStatus() {
  if (agentMonitor) return agentMonitor.getStatus();
  const s = getSettings();
  return {
    enabled: s.codexMonitoringEnabled || s.claudeMonitoringEnabled,
    lastEvent: null,
    activeSessions: [],
    lastCheckedAt: null,
    error: null
  };
}
function syncAgentMonitor() {
  const s = getSettings();
  const config = {
    codexEnabled: s.codexMonitoringEnabled,
    claudeEnabled: s.claudeMonitoringEnabled,
    codexEnvs: s.codexMonitoringEnvs,
    claudeEnvs: s.claudeMonitoringEnvs
  };
  if (!agentMonitor) {
    agentMonitor = new AgentMonitor(config, {
      now: () => Date.now(),
      onEvent: handleAgentEvent,
      log: agentDebugLog
    });
  } else {
    agentMonitor.updateConfig(config);
  }
}
function agentDebugLog(message) {
  try {
    node_fs.appendFileSync("/tmp/desktoppet-agent.log", `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}
`);
  } catch {
  }
}
function applySettings(partial) {
  const before = getSettings();
  const next = patchSettings(partial);
  if (petWindow && !petWindow.isDestroyed() && before.petVisible !== next.petVisible) {
    if (next.petVisible) {
      petWindow.showInactive();
      recheckPetInteractivity();
    } else {
      setPetInteractive(false);
      petWindow.hide();
      petWindow.webContents.send(IPC.OnHideBubble);
    }
  }
  if (before.bubblesEnabled !== next.bubblesEnabled || before.bubbleFrequencySeconds !== next.bubbleFrequencySeconds || before.petVisible !== next.petVisible) {
    scheduleIdleBubble();
  }
  if (before.petVisible !== next.petVisible) {
    refreshTrayMenu();
    refreshDockMenu();
    installApplicationMenu();
  }
  if (before.petScale !== next.petScale && petWindow && !petWindow.isDestroyed()) {
    const [x, y] = petWindow.getPosition();
    const clamped = clampToWorkArea({ x, y }, next.petScale);
    if (clamped.x !== x || clamped.y !== y) {
      safeSetPetPosition(clamped.x, clamped.y, "scaleChanged");
      patchSettings({ petPosition: clamped });
    }
  }
  if (before.codexMonitoringEnabled !== next.codexMonitoringEnabled || before.claudeMonitoringEnabled !== next.claudeMonitoringEnabled || JSON.stringify(before.codexMonitoringEnvs) !== JSON.stringify(next.codexMonitoringEnvs) || JSON.stringify(before.claudeMonitoringEnvs) !== JSON.stringify(next.claudeMonitoringEnvs)) {
    syncAgentMonitor();
  }
  broadcastSnapshot();
  return buildSnapshot();
}
function savePetPosition(recheckInteractive = true) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [x, y] = petWindow.getPosition();
  const clamped = clampToWorkArea({ x, y }, getSettings().petScale);
  if (clamped.x !== x || clamped.y !== y) safeSetPetPosition(clamped.x, clamped.y, "savePetPosition");
  patchSettings({ petPosition: clamped });
  if (recheckInteractive) recheckPetInteractivity();
}
function resetPetPosition() {
  const pos = defaultPetPosition();
  safeSetPetPosition(pos.x, pos.y, "resetPetPosition");
  patchSettings({ petPosition: pos });
  recheckPetInteractivity();
}
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    revealSettingsWindow(settingsWindow);
    return;
  }
  settingsWindow = createSettingsWindow();
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  revealSettingsWindow(settingsWindow);
  settingsWindow.webContents.once("did-finish-load", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) revealSettingsWindow(settingsWindow);
  });
}
function revealSettingsWindow(win) {
  if (win.isDestroyed()) return;
  if (process.platform === "darwin") electron.app.focus({ steal: true });
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
}
function quit() {
  electron.app.quit();
}
function buildQuickAccessMenu() {
  return electron.Menu.buildFromTemplate([
    { label: "设置…", click: openSettings },
    { label: getSettings().petVisible ? "隐藏桌宠" : "显示桌宠", click: () => applySettings({ petVisible: !getSettings().petVisible }) },
    { label: "重置位置", click: resetPetPosition },
    { type: "separator" },
    { label: "退出", click: quit }
  ]);
}
function refreshDockMenu() {
  if (process.platform === "darwin") {
    electron.app.dock?.setMenu(buildQuickAccessMenu());
  }
}
function installApplicationMenu() {
  const menu = electron.Menu.buildFromTemplate([
    {
      label: electron.app.name,
      submenu: [
        { label: "设置…", accelerator: "Command+,", click: openSettings },
        { label: getSettings().petVisible ? "隐藏桌宠" : "显示桌宠", click: () => applySettings({ petVisible: !getSettings().petVisible }) },
        { label: "重置位置", click: resetPetPosition },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    { role: "editMenu", label: "编辑" },
    { role: "windowMenu", label: "窗口" }
  ]);
  electron.Menu.setApplicationMenu(menu);
}
function openSettingsFromAppActivation() {
  if (!activationCanOpenSettings || !electron.app.isReady()) return;
  if (isCursorOverPetWindow()) return;
  openSettings();
}
function registerIpc() {
  electron.ipcMain.handle(IPC.GetSnapshot, (event) => {
    requireTrustedSender(event);
    return buildSnapshot();
  });
  electron.ipcMain.handle(IPC.UpdateSettings, (event, partial) => {
    requireTrustedSender(event);
    return applySettings(typeof partial === "object" && partial !== null ? partial : {});
  });
  electron.ipcMain.handle(IPC.SelectPet, (event, petId) => {
    requireTrustedSender(event);
    return applySettings(typeof petId === "string" ? { selectedPetId: petId } : {});
  });
  electron.ipcMain.handle(IPC.ResetPetPosition, (event) => {
    requireTrustedSender(event);
    resetPetPosition();
  });
  electron.ipcMain.handle(IPC.ShowPet, (event) => {
    requireTrustedSender(event);
    applySettings({ petVisible: true });
  });
  electron.ipcMain.handle(IPC.HidePet, (event) => {
    requireTrustedSender(event);
    applySettings({ petVisible: false });
  });
  electron.ipcMain.handle(IPC.QuitApp, (event) => {
    requireTrustedSender(event);
    quit();
  });
  electron.ipcMain.handle(IPC.PickSkin, (event) => {
    requireTrustedSender(event);
    const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : void 0;
    const res = pickSkinFromDialog(parent);
    if (res.kind === "pack") {
      applySettings({ selectedPetId: res.petId });
      return { kind: "pack", snapshot: buildSnapshot(), petId: res.petId };
    }
    return res;
  });
  electron.ipcMain.handle(IPC.ImportPetPack, (event) => {
    requireTrustedSender(event);
    const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : void 0;
    const res = importPetPackFromDialog(parent);
    if (!res.ok) {
      return { ok: false, error: res.error, canceled: res.canceled };
    }
    applySettings({ selectedPetId: res.petId });
    return { ok: true, snapshot: buildSnapshot(), petId: res.petId };
  });
  electron.ipcMain.handle(IPC.PickPetImage, (event) => {
    requireTrustedSender(event);
    const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : void 0;
    return pickPetImageFromDialog(parent);
  });
  electron.ipcMain.handle(
    IPC.SavePetImage,
    (event, dataUrl, name) => {
      requireTrustedSender(event);
      if (typeof dataUrl !== "string") {
        return { ok: false, error: "图片数据缺失" };
      }
      const res = savePetImageFromDataUrl(dataUrl, typeof name === "string" ? name : "");
      if (!res.ok) {
        return { ok: false, error: res.error, canceled: res.canceled };
      }
      applySettings({ selectedPetId: res.petId });
      return { ok: true, snapshot: buildSnapshot(), petId: res.petId };
    }
  );
  electron.ipcMain.handle(IPC.DeleteImportedPetPack, (event, petId) => {
    requireTrustedSender(event);
    if (typeof petId !== "string") return buildSnapshot();
    const target = findPetInCatalog(petId);
    if (!target || target.source !== "imported") return buildSnapshot();
    deleteImportedPack(petId);
    if (getSettings().selectedPetId === petId) {
      applySettings({ selectedPetId: FALLBACK_PET_ID });
    } else {
      broadcastSnapshot();
    }
    return buildSnapshot();
  });
  electron.ipcMain.handle(IPC.RenameImportedPetPack, (event, petId, name) => {
    requireTrustedSender(event);
    if (typeof petId !== "string" || typeof name !== "string") return buildSnapshot();
    const target = findPetInCatalog(petId);
    if (!target || target.source !== "imported") return buildSnapshot();
    renameImportedPack(petId, name);
    broadcastSnapshot();
    return buildSnapshot();
  });
  electron.ipcMain.handle(IPC.RevealPetPacksFolder, (event) => {
    requireTrustedSender(event);
    revealImportedPacksFolder();
  });
  electron.ipcMain.on(IPC.PetClicked, (event) => {
    if (!isTrustedSender(event)) return;
    sendBubble(pickRandom(CLICK_BUBBLE_LINES), "happy", BUBBLE_DURATION_MS, false, true);
    scheduleIdleBubble();
  });
  electron.ipcMain.on(IPC.DragStart, (event) => {
    if (!isTrustedSender(event)) return;
    if (!petWindow || petWindow.isDestroyed()) return;
    const [winX, winY] = petWindow.getPosition();
    const cursor = electron.screen.getCursorScreenPoint();
    dragOrigin = { winX, winY, cursorX: cursor.x, cursorY: cursor.y };
  });
  electron.ipcMain.on(IPC.DragMove, (event) => {
    if (!isTrustedSender(event)) return;
    if (!petWindow || petWindow.isDestroyed() || !dragOrigin) return;
    const cursor = electron.screen.getCursorScreenPoint();
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return;
    const nextX = Math.round(dragOrigin.winX + (cursor.x - dragOrigin.cursorX));
    const nextY = Math.round(dragOrigin.winY + (cursor.y - dragOrigin.cursorY));
    safeSetPetPosition(nextX, nextY, "dragMove");
  });
  electron.ipcMain.on(IPC.DragStop, (event) => {
    if (!isTrustedSender(event)) return;
    dragOrigin = null;
    savePetPosition();
  });
  electron.ipcMain.on(IPC.SetInteractive, (event, interactive) => {
    if (!isTrustedSender(event)) return;
    setPetInteractive(interactive === true);
  });
  electron.ipcMain.on(IPC.AgentSimulate, (event, source, kind) => {
    if (!isTrustedSender(event)) return;
    if (electron.app.isPackaged) return;
    const validSources = ["codex", "claude"];
    const validKinds = ["working", "done", "needs_attention", "failed"];
    if (!validSources.includes(source)) return;
    if (!validKinds.includes(kind)) return;
    if (!agentMonitor) syncAgentMonitor();
    const k = kind;
    const simReason = k === "failed" ? "error" : k === "needs_attention" ? "needs_input" : void 0;
    const simDetail = k === "failed" ? "示例：TypeError: cannot read property x of undefined" : k === "needs_attention" ? "示例：是否允许写入 /etc/hosts？" : void 0;
    agentMonitor?.ingest(
      {
        id: "",
        source,
        env: "terminal",
        sessionKey: `sim:${source}`,
        kind: k,
        message: `模拟 ${source} ${kind}`,
        timestampMs: Date.now(),
        rawPath: void 0,
        reason: simReason,
        detail: simDetail
      },
      false
    );
  });
}
if (!electron.app.requestSingleInstanceLock()) {
  debugLaunch("single instance lock failed; quitting");
  electron.app.quit();
} else {
  debugLaunch("single instance lock acquired");
  registerNavigationGuards();
  electron.app.on("second-instance", () => {
    if (electron.app.isReady()) openSettings();
    else electron.app.once("ready", openSettings);
  });
  electron.app.on("activate", () => {
    openSettingsFromAppActivation();
  });
  electron.app.on("did-become-active", () => {
    openSettingsFromAppActivation();
  });
  void electron.app.whenReady().then(() => {
    debugLaunch("app ready");
    registerIpc();
    const saved = getSettings().petPosition;
    const position = saved ? clampToWorkArea(saved, getSettings().petScale) : defaultPetPosition();
    petWindow = createPetWindow(position);
    debugLaunch("pet window created");
    petWindow.once("ready-to-show", () => {
      if (getSettings().petVisible && petWindow && !petWindow.isDestroyed()) {
        petWindow.showInactive();
        recheckPetInteractivity();
      }
    });
    petWindow.on("closed", () => {
      petWindow = null;
    });
    createTray({
      isPetVisible: () => getSettings().petVisible,
      togglePet: () => {
        applySettings({ petVisible: !getSettings().petVisible });
      },
      openSettings,
      resetPosition: resetPetPosition,
      quit
    });
    debugLaunch("tray created");
    installApplicationMenu();
    refreshDockMenu();
    activationCanOpenSettings = true;
    openSettings();
    debugLaunch("openSettings requested on startup");
    scheduleIdleBubble();
    syncAgentMonitor();
    agentMonitor?.start();
    debugLaunch("agent monitor started");
  });
  electron.app.on("window-all-closed", () => {
  });
  electron.app.on("before-quit", () => {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    agentMonitor?.stop();
    if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
      savePetPosition(false);
    }
  });
}
