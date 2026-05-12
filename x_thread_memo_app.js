(function () {
  "use strict";

  const DEFAULT_STATE = {
    sourceText: [
      "このページは、Xに投稿したい長文を、手元で分割しながら整えるための作業台です。勢いで長く書いたメモをそのまま貼り付けて、どこで区切るかを見直す使い方を想定しています。",
      "",
      "",
      "基本の流れは、左の入力欄に原稿を入れ、区切りたい場所へ区切り文字を自分で打ち込むだけです。アプリが勝手に本文を書き換えることはなく、区切りの主導権は常にユーザー側にあります。",
      "",
      "",
      "区切り文字を本文に残したまま編集できるので、あとで見返したときも『どこで切るつもりだったか』が分かりやすく、外部のメモ帳やテキストエディタとの往復もしやすくなっています。",
      "",
      "",
      "自動アシストを使うと、長すぎる塊に対してだけ区切り文字をまとめて差し込めます。最初に大ざっぱに区切ってから、細かいところだけ手で直したいときに使う補助機能です。",
      "",
      "",
      "右側には、区切り文字を除去し、インデックスを反映した投稿単位の完成形が並びます。各投稿ごとの X 換算文字数と超過の有無を見ながら、必要なものだけそのままコピーして使えます。",
    ].join("\n"),
    delimiterText: "\n\n\n",
    ignoreBlankLinesAroundDelimiter: false,
    assistTargetChars: 140,
    indexMode: "suffix",
    indexLineBreaks: 1,
  };

  const X_WEIGHT_CONFIG = {
    maxWeightedLength: 280,
    transformedUrlLength: 23,
    lightWeightRanges: [
      [0, 4351],
      [8192, 8205],
      [8208, 8223],
      [8242, 8247],
    ],
  };

  const ASSIST_CANDIDATE_CHARS = new Set([
    "。",
    "．",
    ".",
    "、",
    "，",
    ",",
    "?",
    "？",
    "!",
    "！",
    "\n",
  ]);

  const URL_REGEX =
    /(?:https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?)/giu;

  const EMOJI_CLUSTER_REGEX =
    /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}|\uFE0F|\u20E3)/u;

  const graphemeSegmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("ja", { granularity: "grapheme" })
      : null;

  function normalizeInput(text) {
    return String(text ?? "").replace(/\r\n?/g, "\n");
  }

  function clampInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function escapeVisibleText(text) {
    if (text === "") {
      return "未設定";
    }

    return text.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  }

  function describeDelimiter(text) {
    if (text === "") {
      return "未設定";
    }

    if (/^\n+$/.test(text)) {
      return `改行${text.length}回連続`;
    }

    return escapeVisibleText(text);
  }

  function getAssistCharUnits(char) {
    if (char === "\n") {
      return 2;
    }

    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      return 0;
    }

    if (codePoint <= 0x007f || (codePoint >= 0xff61 && codePoint <= 0xff9f)) {
      return 1;
    }

    return 2;
  }

  function getAssistLengthUnits(text) {
    let units = 0;

    for (const char of normalizeInput(text)) {
      units += getAssistCharUnits(char);
    }

    return units;
  }

  function getAssistLengthDisplay(text) {
    return getAssistLengthUnits(text) / 2;
  }

  function isLightWeightCodePoint(codePoint) {
    return X_WEIGHT_CONFIG.lightWeightRanges.some(([start, end]) => {
      return codePoint >= start && codePoint <= end;
    });
  }

  function splitIntoGraphemes(text) {
    if (!text) {
      return [];
    }

    if (!graphemeSegmenter) {
      return Array.from(text);
    }

    return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
  }

  function trimUrlCandidate(candidate) {
    let trimmed = candidate;

    while (/[.,!?;:]+$/u.test(trimmed)) {
      trimmed = trimmed.slice(0, -1);
    }

    while (trimmed.endsWith(")") && countChar(trimmed, "(") < countChar(trimmed, ")")) {
      trimmed = trimmed.slice(0, -1);
    }

    while (trimmed.endsWith("]") && countChar(trimmed, "[") < countChar(trimmed, "]")) {
      trimmed = trimmed.slice(0, -1);
    }

    return trimmed;
  }

  function countChar(text, target) {
    let count = 0;
    for (const char of text) {
      if (char === target) {
        count += 1;
      }
    }
    return count;
  }

  function extractUrlSpans(text) {
    const spans = [];
    let match;

    while ((match = URL_REGEX.exec(text)) !== null) {
      const rawUrl = match[0];
      const trimmedUrl = trimUrlCandidate(rawUrl);

      if (!trimmedUrl) {
        continue;
      }

      const start = match.index;
      const end = start + trimmedUrl.length;

      spans.push({ start, end });
    }

    return spans;
  }

  function countNonUrlXWeightedLength(text) {
    let weightedLength = 0;
    const normalized = text.normalize("NFC");

    for (const cluster of splitIntoGraphemes(normalized)) {
      if (EMOJI_CLUSTER_REGEX.test(cluster)) {
        weightedLength += 2;
        continue;
      }

      for (const char of cluster) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) {
          continue;
        }

        weightedLength += isLightWeightCodePoint(codePoint) ? 1 : 2;
      }
    }

    return weightedLength;
  }

  function countXWeightedLength(text) {
    const normalized = normalizeInput(text).normalize("NFC");
    const spans = extractUrlSpans(normalized);

    if (spans.length === 0) {
      return countNonUrlXWeightedLength(normalized);
    }

    let cursor = 0;
    let weightedLength = 0;

    for (const span of spans) {
      if (span.start > cursor) {
        weightedLength += countNonUrlXWeightedLength(normalized.slice(cursor, span.start));
      }

      weightedLength += X_WEIGHT_CONFIG.transformedUrlLength;
      cursor = span.end;
    }

    if (cursor < normalized.length) {
      weightedLength += countNonUrlXWeightedLength(normalized.slice(cursor));
    }

    return weightedLength;
  }

  function isDelimiterBlankLineTrimEnabled(delimiterText, ignoreBlankLinesAroundDelimiter) {
    return ignoreBlankLinesAroundDelimiter && delimiterText.includes("\n");
  }

  function extractLeadingBoundaryBlankLines(text) {
    const match = text.match(/^\n+/u);
    return match ? match[0] : "";
  }

  function extractTrailingBoundaryBlankLines(text) {
    const match = text.match(/\n+$/u);
    return match ? match[0] : "";
  }

  function splitSourceWithMetadata(sourceText, delimiterText, ignoreBlankLinesAroundDelimiter) {
    const source = normalizeInput(sourceText);
    const delimiter = normalizeInput(delimiterText);

    if (delimiter === "") {
      if (source === "") {
        return [];
      }

      return [
        {
          rawText: source,
          displayText: source,
          leadingIgnored: "",
          trailingIgnored: "",
        },
      ];
    }

    const rawParts = source.split(delimiter);
    const trimBlankLines = isDelimiterBlankLineTrimEnabled(
      delimiter,
      ignoreBlankLinesAroundDelimiter,
    );

    return rawParts.map((rawText, index) => {
      let displayText = rawText;
      let leadingIgnored = "";
      let trailingIgnored = "";

      if (trimBlankLines && index > 0) {
        leadingIgnored = extractLeadingBoundaryBlankLines(displayText);
        displayText = displayText.slice(leadingIgnored.length);
      }

      if (trimBlankLines && index < rawParts.length - 1) {
        trailingIgnored = extractTrailingBoundaryBlankLines(displayText);
        displayText = displayText.slice(0, displayText.length - trailingIgnored.length);
      }

      return {
        rawText,
        displayText,
        leadingIgnored,
        trailingIgnored,
      };
    });
  }

  function buildIndexedText(content, index, total, indexMode, indexLineBreaks) {
    const label = `(${index}/${total})`;
    const breaks = "\n".repeat(Math.max(0, indexLineBreaks));

    if (indexMode === "prefix") {
      return content ? `${label}${breaks}${content}` : label;
    }

    if (indexMode === "suffix") {
      return content ? `${content}${breaks}${label}` : label;
    }

    return content;
  }

  function buildPreviewModel(state) {
    const segments = splitSourceWithMetadata(
      state.sourceText,
      state.delimiterText,
      state.ignoreBlankLinesAroundDelimiter,
    ).filter((segment) => segment.displayText !== "");

    const posts = segments.map((segment, index) => {
      const postNumber = index + 1;
      const finalText = buildIndexedText(
        segment.displayText,
        postNumber,
        segments.length,
        state.indexMode,
        state.indexLineBreaks,
      );
      const weightedLength = countXWeightedLength(finalText);

      return {
        index: postNumber,
        total: segments.length,
        rawText: segment.displayText,
        finalText,
        weightedLength,
        isOverflow: weightedLength > X_WEIGHT_CONFIG.maxWeightedLength,
      };
    });

    return {
      posts,
      overflowCount: posts.filter((post) => post.isOverflow).length,
    };
  }

  function getAssistTokens(text) {
    const tokens = [];
    let offset = 0;

    for (const char of normalizeInput(text)) {
      tokens.push({
        char,
        start: offset,
        end: offset + char.length,
        units: getAssistCharUnits(char),
      });
      offset += char.length;
    }

    return tokens;
  }

  function findAssistSplitOffset(text, targetUnits) {
    const tokens = getAssistTokens(text);
    let consumedUnits = 0;
    let lastCandidateOffset = 0;
    let lastSafeOffset = 0;

    for (const token of tokens) {
      const nextUnits = consumedUnits + token.units;
      if (nextUnits > targetUnits) {
        break;
      }

      consumedUnits = nextUnits;
      lastSafeOffset = token.end;

      if (ASSIST_CANDIDATE_CHARS.has(token.char)) {
        lastCandidateOffset = token.end;
      }
    }

    if (lastCandidateOffset > 0) {
      return lastCandidateOffset;
    }

    if (lastSafeOffset > 0) {
      return lastSafeOffset;
    }

    return tokens[0] ? tokens[0].end : text.length;
  }

  function splitChunkForAssist(text, assistTargetChars) {
    const targetUnits = Math.max(2, assistTargetChars * 2);
    const pieces = [];
    let remaining = text;

    while (getAssistLengthUnits(remaining) > targetUnits) {
      const splitOffset = findAssistSplitOffset(remaining, targetUnits);
      if (splitOffset <= 0 || splitOffset >= remaining.length) {
        break;
      }

      pieces.push(remaining.slice(0, splitOffset));
      remaining = remaining.slice(splitOffset);
    }

    pieces.push(remaining);
    return pieces.filter((piece) => piece !== "");
  }

  function runAssistInsertion(sourceText, options) {
    const delimiterText = normalizeInput(options.delimiterText);

    if (delimiterText === "") {
      return {
        ok: false,
        error: "区切り文字列が未設定です。",
      };
    }

    const assistTargetChars = clampInteger(options.assistTargetChars, 140, 1, 10000);
    const parts = splitSourceWithMetadata(
      sourceText,
      delimiterText,
      options.ignoreBlankLinesAroundDelimiter,
    );

    let insertedCount = 0;

    const rebuiltText = parts
      .map((part) => {
        if (part.displayText === "") {
          return part.rawText;
        }

        if (getAssistLengthUnits(part.displayText) <= assistTargetChars * 2) {
          return part.rawText;
        }

        const pieces = splitChunkForAssist(part.displayText, assistTargetChars);
        if (pieces.length <= 1) {
          return part.rawText;
        }

        insertedCount += pieces.length - 1;
        return `${part.leadingIgnored}${pieces.join(delimiterText)}${part.trailingIgnored}`;
      })
      .join(delimiterText);

    return {
      ok: true,
      text: rebuiltText,
      insertedCount,
    };
  }

  async function copyTextToClipboard(text) {
    if (!text) {
      return false;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      console.warn("Clipboard API failed.", error);
    }

    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.focus();
    fallback.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      console.warn("execCommand copy failed.", error);
    }

    document.body.removeChild(fallback);
    return copied;
  }

  function initApp() {
    const sourceText = document.querySelector("#sourceText");
    const clearSource = document.querySelector("#clearSource");
    const delimiterText = document.querySelector("#delimiterText");
    const delimiterPreview = document.querySelector("#delimiterPreview");
    const resetDelimiter = document.querySelector("#resetDelimiter");
    const ignoreBlankLinesAroundDelimiter = document.querySelector(
      "#ignoreBlankLinesAroundDelimiter",
    );
    const assistTargetChars = document.querySelector("#assistTargetChars");
    const assistTargetDisplay = document.querySelector("#assistTargetDisplay");
    const runAssist = document.querySelector("#runAssist");
    const indexModeInputs = document.querySelectorAll('input[name="indexMode"]');
    const indexLineBreaks = document.querySelector("#indexLineBreaks");
    const previewCount = document.querySelector("#previewCount");
    const previewOverflow = document.querySelector("#previewOverflow");
    const previewList = document.querySelector("#previewList");
    const previewEmpty = document.querySelector("#previewEmpty");
    const toast = document.querySelector("#toast");

    if (
      !sourceText ||
      !clearSource ||
      !delimiterText ||
      !delimiterPreview ||
      !resetDelimiter ||
      !ignoreBlankLinesAroundDelimiter ||
      !assistTargetChars ||
      !assistTargetDisplay ||
      !runAssist ||
      indexModeInputs.length === 0 ||
      !indexLineBreaks ||
      !previewCount ||
      !previewOverflow ||
      !previewList ||
      !previewEmpty ||
      !toast
    ) {
      return;
    }

    const state = { ...DEFAULT_STATE };
    let isComposing = false;
    let delimiterPristine = true;
    let toastTimer = null;

    function showToast(message) {
      toast.textContent = message;
      toast.dataset.visible = "true";

      if (toastTimer) {
        window.clearTimeout(toastTimer);
      }

      toastTimer = window.setTimeout(() => {
        toast.dataset.visible = "false";
      }, 2200);
    }

    function readIndexMode() {
      const checked = Array.from(indexModeInputs).find((input) => input.checked);
      return checked ? checked.value : DEFAULT_STATE.indexMode;
    }

    function syncFormFromState() {
      sourceText.value = state.sourceText;
      delimiterText.value = state.delimiterText;
      delimiterPreview.textContent = describeDelimiter(state.delimiterText);
      ignoreBlankLinesAroundDelimiter.checked = state.ignoreBlankLinesAroundDelimiter;
      assistTargetChars.value = String(state.assistTargetChars);
      assistTargetDisplay.textContent = `全角${state.assistTargetChars}字相当`;
      indexLineBreaks.value = String(state.indexLineBreaks);

      Array.from(indexModeInputs).forEach((input) => {
        input.checked = input.value === state.indexMode;
      });
    }

    function syncStateFromForm() {
      state.sourceText = normalizeInput(sourceText.value);
      state.delimiterText = normalizeInput(delimiterText.value);
      state.ignoreBlankLinesAroundDelimiter = ignoreBlankLinesAroundDelimiter.checked;
      state.assistTargetChars = clampInteger(
        assistTargetChars.value,
        state.assistTargetChars,
        1,
        10000,
      );
      state.indexMode = readIndexMode();
      state.indexLineBreaks = clampInteger(indexLineBreaks.value, state.indexLineBreaks, 0, 10);
      delimiterPreview.textContent = describeDelimiter(state.delimiterText);
      assistTargetDisplay.textContent = `全角${state.assistTargetChars}字相当`;
      indexLineBreaks.value = String(state.indexLineBreaks);
    }

    function replaceDelimiterWithDefault() {
      delimiterPristine = true;
      state.delimiterText = DEFAULT_STATE.delimiterText;
      delimiterText.value = state.delimiterText;
      delimiterPreview.textContent = describeDelimiter(state.delimiterText);
    }

    function renderPreview() {
      const model = buildPreviewModel(state);

      previewCount.textContent = `${model.posts.length}件`;
      previewOverflow.textContent = `${model.overflowCount}件`;
      previewList.innerHTML = "";

      if (model.posts.length === 0) {
        previewEmpty.hidden = false;
        return;
      }

      previewEmpty.hidden = true;

       model.posts.forEach((post) => {
        const card = document.createElement("article");
        card.className = "post-card";
        if (post.isOverflow) {
          card.dataset.overflow = "true";
        }

        const badge = document.createElement("span");
        badge.className = "post-card__badge";
        badge.textContent = `POST ${post.index}`;

        const main = document.createElement("div");
        main.className = "post-card__main";

        const mainHeader = document.createElement("div");
        mainHeader.className = "post-card__main-header";
        mainHeader.append(badge);

        const body = document.createElement("pre");
        body.className = "post-card__body";
        body.textContent = post.finalText;

        main.append(mainHeader, body);

        const side = document.createElement("div");
        side.className = "post-card__side";

        const metaLabel = document.createElement("span");
        metaLabel.className = "post-card__side-label";
        metaLabel.textContent = "X換算";

        const metaValue = document.createElement("strong");
        metaValue.className = "post-card__side-value";
        metaValue.textContent = `${post.weightedLength} / ${X_WEIGHT_CONFIG.maxWeightedLength}`;

        const status = document.createElement("span");
        status.className = "post-card__status";
        status.dataset.kind = post.isOverflow ? "overflow" : "ok";
        status.textContent = post.isOverflow ? "超過" : "収まる";

        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "copy-button";
        copyButton.textContent = "コピー";
        copyButton.dataset.copyText = post.finalText;

        side.append(metaLabel, metaValue, status, copyButton);

        card.append(main, side);
        previewList.append(card);
      });
    }

    function refresh() {
      syncStateFromForm();
      renderPreview();
    }

    sourceText.addEventListener("compositionstart", () => {
      isComposing = true;
    });

    sourceText.addEventListener("compositionend", () => {
      isComposing = false;
      refresh();
    });

    sourceText.addEventListener("input", () => {
      if (!isComposing) {
        refresh();
      }
    });

    delimiterText.addEventListener("compositionstart", () => {
      isComposing = true;
    });

    delimiterText.addEventListener("focus", () => {
      if (!delimiterPristine) {
        return;
      }

      if (delimiterText.value !== DEFAULT_STATE.delimiterText) {
        return;
      }

      delimiterText.setSelectionRange(0, delimiterText.value.length);
    });

    delimiterText.addEventListener("compositionend", () => {
      isComposing = false;
      delimiterPristine = delimiterText.value === DEFAULT_STATE.delimiterText;
      refresh();
    });

    delimiterText.addEventListener("input", () => {
      delimiterPristine = delimiterText.value === DEFAULT_STATE.delimiterText;
      if (!isComposing) {
        refresh();
      }
    });

    ignoreBlankLinesAroundDelimiter.addEventListener("change", refresh);
    assistTargetChars.addEventListener("change", refresh);
    indexLineBreaks.addEventListener("change", refresh);
    Array.from(indexModeInputs).forEach((input) => {
      input.addEventListener("change", refresh);
    });

    resetDelimiter.addEventListener("click", () => {
      replaceDelimiterWithDefault();
      renderPreview();
      showToast("区切り文字列をデフォルトに戻しました。");
    });

    clearSource.addEventListener("click", () => {
      state.sourceText = "";
      sourceText.value = "";
      renderPreview();
      showToast("入力欄をクリアしました。");
    });

    runAssist.addEventListener("click", () => {
      syncStateFromForm();

      if (state.delimiterText === "") {
        showToast("区切り文字列を設定してください。");
        return;
      }

      const result = runAssistInsertion(state.sourceText, state);
      if (!result.ok) {
        showToast(result.error);
        return;
      }

      state.sourceText = result.text;
      sourceText.value = state.sourceText;
      renderPreview();

      if (result.insertedCount === 0) {
        showToast("自動アシストで追加された区切りはありませんでした。");
        return;
      }

      showToast(`自動アシストで区切りを${result.insertedCount}個追加しました。`);
    });

    previewList.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy-text]");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      const copied = await copyTextToClipboard(button.dataset.copyText || "");
      showToast(copied ? "コピーしました。" : "コピーに失敗しました。");
    });

    syncFormFromState();
    renderPreview();
  }

  const exported = {
    DEFAULT_STATE,
    normalizeInput,
    describeDelimiter,
    getAssistLengthUnits,
    getAssistLengthDisplay,
    countXWeightedLength,
    splitSourceWithMetadata,
    buildPreviewModel,
    runAssistInsertion,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.ThreadMemoApp = exported;
    window.addEventListener("DOMContentLoaded", initApp);
  }
})();
