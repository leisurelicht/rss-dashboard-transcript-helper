"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { Plugin, Notice, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
  saveFolder: "RSS articles"
};

class TranscriptHelperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Save folder")
      .setDesc("Folder used to save transcript notes for shadowing.")
      .addText((text) =>
        text
          .setPlaceholder("RSS articles")
          .setValue(this.plugin.settings.saveFolder)
          .onChange(async (value) => {
            this.plugin.settings.saveFolder = value.trim() || DEFAULT_SETTINGS.saveFolder;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = class RssDashboardTranscriptHelperPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "extract-current-youtube-transcript",
      name: "提取当前 YouTube 视频字幕并保存",
      callback: async () => {
        await this.extractFromCurrentReader();
      }
    });

    this.addSettingTab(new TranscriptHelperSettingTab(this.app, this));
    this.installReaderIntegration();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  installReaderIntegration() {
    const refreshViews = () => {
      this.patchReaderViewPrototype();
      this.refreshReaderViews();
    };

    refreshViews();
    this.registerEvent(this.app.workspace.on("layout-change", refreshViews));
    this.registerInterval(window.setInterval(refreshViews, 1500));
  }

  patchReaderViewPrototype() {
    const view = this.getReaderView();
    if (!view) return;

    const proto = Object.getPrototypeOf(view);
    if (!proto || proto.__transcriptHelperPatched) return;
    proto.__transcriptHelperPatched = true;

    const originalOnOpen = proto.onOpen;
    const originalDisplayItem = proto.displayItem;

    proto.onOpen = function(...args) {
      const result = originalOnOpen ? originalOnOpen.apply(this, args) : undefined;
      const refresh = () => {
        const plugin = globalThis.__rssDashboardTranscriptHelperPlugin;
        plugin?.attachTranscriptActions(this);
      };
      if (result && typeof result.then === "function") {
        return result.then((value) => {
          refresh();
          return value;
        });
      }
      refresh();
      return result;
    };

    proto.displayItem = async function(...args) {
      const result = originalDisplayItem ? await originalDisplayItem.apply(this, args) : undefined;
      const plugin = globalThis.__rssDashboardTranscriptHelperPlugin;
      plugin?.attachTranscriptActions(this);
      return result;
    };
  }

  refreshReaderViews() {
    globalThis.__rssDashboardTranscriptHelperPlugin = this;
    const leaves = this.app.workspace.getLeavesOfType("rss-reader-view");
    for (const leaf of leaves) {
      if (leaf?.view) {
        this.attachTranscriptActions(leaf.view);
      }
    }
  }

  attachTranscriptActions(view) {
    if (!view || !view.contentEl || !view.contentEl.isConnected) return;

    view.saveYouTubeTranscriptForShadowing = async (item) => {
      await this.extractItemTranscript(item, view);
    };

    view.ensureTranscriptButton = () => {
      this.dedupeTranscriptButtons(view);

      let button = (view.containerEl || view.contentEl).querySelector(".rss-reader-transcript-button");
      if (button) {
        view.transcriptButton = button;
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "rss-reader-transcript-button-wrap";
      wrap.style.display = "inline-flex";
      wrap.style.alignItems = "center";
      wrap.style.marginRight = "8px";

      button = wrap.createEl("button", {
        cls: "mod-cta rss-reader-transcript-button",
        text: "提取字幕",
        attr: { type: "button", title: "提取字幕并保存为跟读文档" }
      });
      button.style.display = "inline-flex";
      button.style.alignItems = "center";
      button.style.gap = "6px";
      button.style.whiteSpace = "nowrap";
      button.style.padding = "6px 12px";
      button.style.borderRadius = "999px";

      const obsidian = require("obsidian");
      obsidian.setIcon(button, "captions");
      this.insertTranscriptButtonWrap(view, wrap);

      button.addEventListener("click", () => {
        if (view.currentItem) {
          void this.extractItemTranscript(view.currentItem, view);
        }
      });

      view.transcriptButton = button;
    };

    view.updateTranscriptButtonState = () => {
      view.ensureTranscriptButton();
      if (!view.transcriptButton) return;

      if (this.isSupportedItem(view.currentItem)) {
        view.transcriptButton.style.display = "inline-flex";
        view.transcriptButton.disabled = false;
        view.transcriptButton.removeClass?.("is-disabled");
      } else {
        view.transcriptButton.style.display = "none";
        view.transcriptButton.disabled = true;
        view.transcriptButton.addClass?.("is-disabled");
      }
    };

    view.ensureTranscriptButton();
    view.updateTranscriptButtonState();
  }

  dedupeTranscriptButtons(view) {
    const root = view.containerEl || view.contentEl;
    const wraps = Array.from(root.querySelectorAll(".rss-reader-transcript-button-wrap"));
    if (wraps.length <= 1) return;

    const [first, ...rest] = wraps;
    for (const extra of rest) {
      extra.remove();
    }

    const button = first.querySelector(".rss-reader-transcript-button");
    if (button) {
      view.transcriptButton = button;
    }
  }

  insertTranscriptButtonWrap(view, wrap) {
    const browserButton = this.findOpenInBrowserButton(view);
    if (browserButton?.parentElement) {
      const parent = browserButton.parentElement;
      parent.style.display = "flex";
      parent.style.alignItems = "center";
      if (browserButton.nextSibling) {
        parent.insertBefore(wrap, browserButton.nextSibling);
      } else {
        parent.appendChild(wrap);
      }
      return;
    }

    const saveButton = this.findSaveArticleButton(view);
    if (saveButton?.parentElement) {
      const parent = saveButton.parentElement;
      parent.style.display = "flex";
      parent.style.alignItems = "center";
      if (saveButton.nextSibling) {
        parent.insertBefore(wrap, saveButton.nextSibling);
      } else {
        parent.appendChild(wrap);
      }
      return;
    }

    const actionBar = this.findActionBar(view);
    if (actionBar) {
      actionBar.style.display = "flex";
      actionBar.style.alignItems = "center";
      actionBar.appendChild(wrap);
      return;
    }

    wrap.style.display = "flex";
    wrap.style.margin = "12px 0";
    view.contentEl.appendChild(wrap);
  }

  findOpenInBrowserButton(view) {
    const root = view.containerEl || view.contentEl;
    const directMatch = root?.querySelector?.('.rss-reader-action-button[title="Open in Browser"]');
    if (directMatch) return directMatch;

    const buttons = Array.from(root?.querySelectorAll?.("button, a, div[role='button'], .rss-reader-action-button") || []);
    return buttons.find((element) => {
      const text = (element.textContent || "").trim().toLowerCase();
      const title = (element.getAttribute("title") || "").trim().toLowerCase();
      const aria = (element.getAttribute("aria-label") || "").trim().toLowerCase();
      const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
      return (
        text.includes("open in browser") ||
        title.includes("open in browser") ||
        aria.includes("open in browser") ||
        className.includes("browser") ||
        className.includes("external-link")
      );
    });
  }

  findSaveArticleButton(view) {
    const root = view.containerEl || view.contentEl;
    const directMatch = root?.querySelector?.(".rss-dashboard-save-toggle");
    if (directMatch) return directMatch;

    const buttons = Array.from(root?.querySelectorAll?.("button, a, div[role='button']") || []);
    return buttons.find((element) => {
      const text = (element.textContent || "").trim().toLowerCase();
      const title = (element.getAttribute("title") || "").trim().toLowerCase();
      const aria = (element.getAttribute("aria-label") || "").trim().toLowerCase();
      const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
      return (
        text.includes("save article") ||
        title.includes("save article") ||
        aria.includes("save article") ||
        className.includes("save") ||
        className.includes("article-saver")
      );
    });
  }

  findActionBar(view) {
    const root = view.containerEl || view.contentEl;
    const candidates = [
      ".view-header-actions",
      ".view-actions",
      ".rss-dashboard-action-toolbar",
      ".rss-reader-header",
      ".rss-reader-content",
      ".rss-reader-toolbar"
    ];

    for (const selector of candidates) {
      const element = root.querySelector(selector);
      if (element) return element;
    }

    return null;
  }

  isSupportedItem(item) {
    return this.isYouTubeItem(item) || this.isTedItem(item);
  }

  getReaderView() {
    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    const activeView = activeLeaf && activeLeaf.view;
    if (activeView && activeView.getViewType && activeView.getViewType() === "rss-reader-view") {
      return activeView;
    }

    const leaves = this.app.workspace.getLeavesOfType("rss-reader-view");
    for (const leaf of leaves) {
      if (leaf && leaf.view && leaf.view.currentItem) {
        return leaf.view;
      }
    }

    return null;
  }

  isYouTubeItem(item) {
    if (!item) return false;
    const haystack = [
      item.link,
      item.guid,
      item.feedUrl,
      item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : ""
    ]
      .filter(Boolean)
      .join(" ");
    return /(youtube\.com|youtu\.be)/i.test(haystack);
  }

  isTedItem(item) {
    if (!item) return false;
    const haystack = [item.link, item.guid, item.feedUrl, item.url, item.id]
      .filter(Boolean)
      .join(" ");
    return /ted\.com\/talks\//i.test(haystack);
  }

  getYouTubeVideoIdFromItem(item) {
    if (item.videoId) return item.videoId;
    const candidates = [item.link, item.guid, item.feedUrl, item.url, item.id];
    for (const value of candidates) {
      if (!value) continue;
      const parsed = this.extractYouTubeVideoId(String(value));
      if (parsed) return parsed;
    }
    return "";
  }

  extractYouTubeVideoId(value) {
    const text = String(value || "").trim();
    if (!text) return "";

    try {
      const url = new URL(text);
      const host = url.hostname.replace(/^www\./i, "").toLowerCase();

      if (host === "youtu.be") {
        const idFromPath = url.pathname.split("/").filter(Boolean)[0] || "";
        if (/^[A-Za-z0-9_-]{11}$/.test(idFromPath)) return idFromPath;
      }

      if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        const v = url.searchParams.get("v");
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;

        const parts = url.pathname.split("/").filter(Boolean);
        for (let index = 0; index < parts.length - 1; index += 1) {
          if (["embed", "shorts", "live", "v"].includes(parts[index])) {
            const candidate = parts[index + 1];
            if (/^[A-Za-z0-9_-]{11}$/.test(candidate)) return candidate;
          }
        }
      }
    } catch (_error) {
      // Not a URL, continue with regex fallback.
    }

    const fallback = text.match(/(?:v=|\/embed\/|\/shorts\/|\/live\/|youtu\.be\/|\/v\/)([A-Za-z0-9_-]{11})/i);
    return fallback?.[1] || "";
  }

  async extractFromCurrentReader() {
    const view = this.getReaderView();
    if (!view || !view.currentItem) {
      new Notice("没有找到当前打开的 RSS Dashboard 视频页面。");
      return;
    }

    await this.extractItemTranscript(view.currentItem, view);
  }

  async extractItemTranscript(item, view) {
    if (!item) {
      new Notice("没有找到可提取字幕的当前条目。");
      return;
    }

    const loadingNotice = new Notice("正在提取字幕...", 0);
    try {
      let transcript = [];
      let markdown = "";

      if (this.isYouTubeItem(item)) {
        const videoId = this.getYouTubeVideoIdFromItem(item);
        if (!videoId) {
          throw new Error("无法识别当前视频的 YouTube ID。");
        }
        transcript = await this.fetchYouTubeTranscript(videoId);
        markdown = this.buildShadowingMarkdown(item, `https://www.youtube.com/watch?v=${videoId}`, transcript, { videoId });
      } else if (this.isTedItem(item)) {
        const tedUrl = this.getTedTalkUrlFromItem(item);
        if (!tedUrl) {
          throw new Error("无法识别当前 TED Talk 链接。");
        }
        transcript = await this.fetchTedTranscript(tedUrl);
        markdown = this.buildShadowingMarkdown(item, tedUrl, transcript);
      } else {
        throw new Error("当前页面既不是 YouTube 也不是 TED Talk。");
      }

      const file = await this.saveTranscriptNote(item, markdown);
      loadingNotice.hide();
      new Notice(`字幕已保存: ${file.path}`);
      await (view?.app || this.app).workspace.getLeaf("tab").openFile(file);
    } catch (error) {
      loadingNotice.hide();
      new Notice(`字幕提取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async fetchYouTubeTranscript(videoId) {
    try {
      const ytDlpEntries = await this.fetchYouTubeTranscriptWithYtDlp(videoId);
      if (ytDlpEntries.length > 0) {
        return ytDlpEntries;
      }
    } catch (error) {
      console.warn("[Transcript Helper] yt-dlp fallback failed:", error);
    }

    const watchResponse = await requestUrl({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    const watchHtml = watchResponse.text || "";

    let tracks = null;
    try {
      const playerResponse = this.extractJsonAssignment(watchHtml, "ytInitialPlayerResponse");
      if (playerResponse) {
        tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      }
    } catch (e) {
      console.warn("Failed to parse ytInitialPlayerResponse:", e);
    }

    // Fallback: try old captionTracks regex with greedy matching
    if (!tracks || tracks.length === 0) {
      const match = watchHtml.match(/"captionTracks":\s*(\[[\s\S]*?\])\s*[,}]/);
      if (match) {
        try {
          tracks = JSON.parse(match[1]);
        } catch (_error) {
          // ignore
        }
      }
    }

    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      throw new Error("这个视频没有可用字幕或页面结构已变化。");
    }

    const track = this.pickBestCaptionTrack(tracks);
    const transcriptUrl = this.buildTranscriptRequestUrl((track.baseUrl || "").replace(/\\u0026/g, "&"));
    if (!transcriptUrl) {
      throw new Error("字幕下载地址缺失。");
    }

    const transcriptResponse = await requestUrl({
      url: transcriptUrl,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const entries = this.parseTranscriptResponse(transcriptResponse.text || "");
    if (entries.length === 0) {
      throw new Error("字幕文件为空。");
    }

    return entries;
  }

  async fetchYouTubeTranscriptWithYtDlp(videoId) {
    const ytDlpPath = this.resolveYtDlpPath();
    if (!ytDlpPath) {
      throw new Error("yt-dlp not found");
    }
    const jsRuntime = this.resolveYtDlpJsRuntime();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-yt-transcript-"));
    const outputTemplate = path.join(tempDir, "%(id)s.%(ext)s");
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    try {
      const args = [
        "--ignore-errors",
        "--no-warnings",
        "--skip-download",
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs",
        "en,en-en,en-orig,-en-ar",
        "--sub-format",
        "json3",
        "--output",
        outputTemplate
      ];

      if (jsRuntime) {
        args.push("--js-runtimes", jsRuntime);
      }

      args.push(videoUrl);

      try {
        await this.execFileAsync(ytDlpPath, args);
      } catch (error) {
        const existing = this.findTranscriptJson3Files(tempDir, videoId);
        if (existing.length === 0) {
          throw error;
        }
        console.warn("[Transcript Helper] yt-dlp reported partial failure, using downloaded subtitles:", error);
      }

      const subtitleFile = this.findTranscriptJson3Files(tempDir, videoId)[0];
      if (!subtitleFile) {
        return [];
      }

      const raw = fs.readFileSync(path.join(tempDir, subtitleFile), "utf8");
      return this.parseTranscriptResponse(raw);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  findTranscriptJson3Files(tempDir, videoId) {
    return fs.readdirSync(tempDir)
      .filter((file) => file.startsWith(`${videoId}.`) && file.endsWith(".json3"))
      .sort((left, right) => {
        const leftScore = this.scoreTranscriptFilename(left);
        const rightScore = this.scoreTranscriptFilename(right);
        if (leftScore !== rightScore) return leftScore - rightScore;
        return left.localeCompare(right);
      });
  }

  scoreTranscriptFilename(file) {
    if (/\.en\.json3$/i.test(file)) return 0;
    if (/\.en-en\.json3$/i.test(file)) return 1;
    if (/\.en-orig\.json3$/i.test(file)) return 2;
    return 10;
  }

  resolveYtDlpPath() {
    const candidates = [
      process.env.YT_DLP_PATH,
      "/opt/homebrew/bin/yt-dlp",
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      "yt-dlp"
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate === "yt-dlp") {
        return candidate;
      }
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  resolveYtDlpJsRuntime() {
    const denoCandidates = [
      process.env.DENO_PATH,
      "/opt/homebrew/bin/deno",
      "/usr/local/bin/deno"
    ].filter(Boolean);
    for (const candidate of denoCandidates) {
      if (fs.existsSync(candidate)) {
        return `deno:${candidate}`;
      }
    }

    const nodeCandidates = [
      process.env.NODE_PATH,
      process.execPath,
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/Users/Licht/.nvm/versions/node/v17.5.0/bin/node"
    ].filter(Boolean);
    for (const candidate of nodeCandidates) {
      if (candidate && fs.existsSync(candidate)) {
        return `node:${candidate}`;
      }
    }

    return "";
  }

  execFileAsync(command, args) {
    return new Promise((resolve, reject) => {
      execFile(command, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  extractJsonAssignment(source, variableName) {
    const assignment = `${variableName} = `;
    const start = source.indexOf(assignment);
    if (start === -1) return null;

    const jsonStart = source.indexOf("{", start + assignment.length);
    if (jsonStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = jsonStart; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const jsonText = source.slice(jsonStart, index + 1);
          return JSON.parse(jsonText);
        }
      }
    }

    return null;
  }

  pickBestCaptionTrack(tracks) {
    const englishHuman = tracks.filter((track) => {
      const code = (track.languageCode || "").toLowerCase();
      return code.startsWith("en") && !track.kind;
    });
    const englishAsr = tracks.filter((track) => {
      const code = (track.languageCode || "").toLowerCase();
      return code.startsWith("en") && track.kind === "asr";
    });
    return englishHuman[0] || englishAsr[0] || tracks.find((track) => !track.kind) || tracks[0];
  }

  buildTranscriptRequestUrl(baseUrl) {
    if (!baseUrl) return "";
    try {
      const url = new URL(baseUrl);
      if (!url.searchParams.has("fmt")) {
        url.searchParams.set("fmt", "json3");
      }
      return url.toString();
    } catch (_error) {
      return baseUrl;
    }
  }

  parseTranscriptResponse(rawText) {
    const text = (rawText || "").trim();
    if (!text) return [];

    if (text.startsWith("<")) {
      return this.parseTranscriptXml(text);
    }

    try {
      return this.parseTranscriptJson(JSON.parse(text));
    } catch (_error) {
      return this.parseTranscriptXml(text);
    }
  }

  parseTranscriptXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    return Array.from(doc.querySelectorAll("text"))
      .map((node) => {
        const startSec = parseFloat(node.getAttribute("start") || "0");
        const durationSec = parseFloat(node.getAttribute("dur") || "0");
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        return {
          startSec: Number.isFinite(startSec) ? startSec : 0,
          durationSec: Number.isFinite(durationSec) ? durationSec : 0,
          text
        };
      })
      .filter((entry) => entry.text.length > 0);
  }

  parseTranscriptJson(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    return events
      .map((event) => {
        const startSec = Number(event?.tStartMs || 0) / 1000;
        const durationSec = Number(event?.dDurationMs || 0) / 1000;
        const text = Array.isArray(event?.segs)
          ? event.segs.map((seg) => seg?.utf8 || "").join("").replace(/\s+/g, " ").trim()
          : "";
        return {
          startSec: Number.isFinite(startSec) ? startSec : 0,
          durationSec: Number.isFinite(durationSec) ? durationSec : 0,
          text
        };
      })
      .filter((entry) => entry.text.length > 0);
  }

  getTedTalkUrlFromItem(item) {
    const candidates = [item.link, item.guid, item.feedUrl, item.url, item.id];
    for (const value of candidates) {
      if (!value) continue;
      try {
        const url = new URL(String(value));
        if (/ted\.com$/i.test(url.hostname) && /\/talks\//i.test(url.pathname)) {
          return `${url.origin}${url.pathname}`;
        }
      } catch (_error) {
        const match = String(value).match(/https?:\/\/(?:www\.)?ted\.com\/talks\/[A-Za-z0-9_-]+/i);
        if (match?.[0]) return match[0];
      }
    }
    return "";
  }

  async fetchTedTranscript(talkUrl) {
    const response = await requestUrl({
      url: talkUrl,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    const html = response.text || "";
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    if (!nextDataMatch?.[1]) {
      throw new Error("TED transcript metadata not found.");
    }

    const nextData = JSON.parse(nextDataMatch[1]);
    const pageProps = nextData?.props?.pageProps;
    const paragraphs =
      pageProps?.transcriptData?.translation?.paragraphs ||
      pageProps?.videoData?.playerData?.resources?.transcript ||
      pageProps?.videoData?.playerData?.transcript ||
      pageProps?.videoData?.transcript;

    if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
      throw new Error("No TED transcript found for this talk.");
    }

    return paragraphs.flatMap((paragraph) =>
      Array.isArray(paragraph?.cues)
        ? paragraph.cues
            .map((cue) => {
              const startSec = Number(cue?.time || 0) / 1000;
              const text = String(cue?.text || "").replace(/\s+/g, " ").trim();
              return {
                startSec: Number.isFinite(startSec) ? startSec : 0,
                durationSec: 0,
                text
              };
            })
            .filter((entry) => entry.text.length > 0)
        : []
    );
  }

  buildShadowingMarkdown(item, sourceUrl, entries, options = {}) {
    const lines = [
      "---",
      `title: "${(item.title || "Untitled").replace(/"/g, '\\"')}"`,
      `date: ${new Date().toISOString()}`,
      `source: "${(item.feedTitle || "YouTube").replace(/"/g, '\\"')}"`,
      `link: ${sourceUrl}`,
      `guid: "${(item.guid || sourceUrl).replace(/"/g, '\\"')}"`,
      `mediaType: ${this.isTedItem(item) ? "talk" : "video"}`,
      "---",
      "",
      `# ${item.title || "Untitled"}`,
      "",
      `![](${sourceUrl})`,
      ""
    ];

    if (options.videoId) {
      lines.splice(7, 0, `videoId: "${options.videoId}"`);
    }

    for (const entry of entries) {
      lines.push(`[${this.formatTranscriptTimestamp(entry.startSec)}] ${entry.text}`);
    }

    lines.push("");
    return lines.join("\n");
  }

  formatTranscriptTimestamp(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  sanitizeFilename(name) {
    return name.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").slice(0, 100);
  }

  normalizeFolder(folder) {
    return (folder || "").trim().replace(/^\/+|\/+$/g, "");
  }

  async ensureFolderExists(folder) {
    if (!folder) return;
    const parts = folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async saveTranscriptNote(item, markdown) {
    const folder = this.normalizeFolder(this.settings.saveFolder || DEFAULT_SETTINGS.saveFolder);
    if (folder) {
      await this.ensureFolderExists(folder);
    }

    const baseName = this.sanitizeFilename(`${item.title || "Untitled"} transcript`);
    let path = folder ? `${folder}/${baseName}.md` : `${baseName}.md`;
    let index = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = folder ? `${folder}/${baseName}_${index}.md` : `${baseName}_${index}.md`;
      index += 1;
    }

    return await this.app.vault.create(path, markdown);
  }
};
