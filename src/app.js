import "./style.css";
import { FIELD_LABELS, TARGET_FIELDS } from "./config.js";
import { analyzeWorkbook, createSummaryWorkbook, writeWorkbook } from "./excel.js";
import { droppedFiles } from "./file-drop.js";
import { extractPdf, renderEvidence, renderFullReport } from "./parser.js";
import {
  DECISIONS,
  allReviewed,
  countryByKey,
  createReviewSession,
  finalValue,
  firstUnresolved,
  isReachable,
  move,
  reviewItems,
  reviewSummary,
  setDecision,
  undo,
} from "./review.js";

const app = document.querySelector("#app");
const state = {
  pdfFiles: [],
  workbookFile: null,
  session: null,
  cursor: null,
  workbookPlan: null,
  busy: false,
  progress: 0,
  progressText: "",
  previewOpen: false,
  output: null,
  countryScrollTop: 0,
  reviewScrollTop: 0,
  renderedCountryKey: null,
};

const icon = (name, className = "") => {
  const paths = {
    shield: '<path d="M12 3 5 6v5c0 4.8 2.9 8.2 7 10 4.1-1.8 7-5.2 7-10V6l-7-3Z"/><path d="m9.5 12 1.7 1.7 3.8-4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    sheet: '<rect width="18" height="20" x="3" y="2" rx="2"/><path d="M3 8h18M9 8v14M15 8v14M3 14h18"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect width="16" height="12" x="4" y="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    keyboard: '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h10"/>',
  };
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatAmount(value, currency) {
  if (value == null || !Number.isFinite(value)) return "—";
  const decimals = currency === "JPY" ? 0 : 2;
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

function decisionLabel(decision) {
  return { APPROVED: "已确认", CONFIRMED_ZERO: "确认为 0", MANUAL: "人工值", SKIP: "已跳过" }[decision] || "待审核";
}

function setBusy(busy, text = "", progress = state.progress) {
  state.busy = busy;
  state.progressText = text;
  state.progress = progress;
  renderBusy();
}

function renderBusy() {
  document.querySelector("#busyLayer")?.remove();
  if (!state.busy) return;
  const layer = document.createElement("div");
  layer.id = "busyLayer";
  layer.className = "busy-layer";
  layer.innerHTML = `<div class="busy-card"><div class="orbital-loader"><span></span></div><strong>${escapeHtml(state.progressText || "正在处理")}</strong><div class="busy-progress"><i style="width:${Math.max(4, Math.min(100, state.progress))}%"></i></div><small>所有文件仅在这台设备的浏览器中处理</small></div>`;
  document.body.appendChild(layer);
}

function toast(message, type = "info") {
  const root = document.querySelector("#toastRoot") || document.body;
  const node = document.createElement("div");
  node.className = `toast toast-${type}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => node.classList.add("toast-show"), 20);
  setTimeout(() => {
    node.classList.remove("toast-show");
    setTimeout(() => node.remove(), 250);
  }, 3600);
}

function shell(content, step = 1) {
  const reviewMode = step === 2;
  return `
    <header class="topbar">
      <a class="brand" href="./" aria-label="返回首页"><span class="brand-mark">${icon("sheet")}</span><span><b>Amazon 季度数据工具</b><small>提取、审核与工作簿生成</small></span></a>
      <div class="privacy-pill">${icon("lock")}<span>本地处理 · 不上传文件</span></div>
    </header>
    <main class="page-shell ${reviewMode ? "review-page" : ""}">
      <section class="hero">
        <div><span class="eyebrow">AMAZON QUARTERLY REVIEW</span><h1>季度交易数据核验与导出</h1><p>上传 Amazon 季度 PDF 后逐项核对。公司工作簿可选：上传时按国家写入，不上传时直接导出清晰的解析汇总表。</p></div>
        <div class="flow-steps" aria-label="处理步骤">
          ${[[1,"准备文件"],[2,"顺序审核"],[3,"确认生成"]].map(([number,label]) => `<div class="flow-step ${step === number ? "active" : ""} ${step > number ? "done" : ""}"><span>${step > number ? icon("check") : number}</span><b>${label}</b></div>`).join("")}
        </div>
      </section>
      ${content}
    </main>
    <footer><span>纯浏览器运行，不要求安装 Microsoft Excel 或 WPS</span><span class="footer-links"><a href="./local.html" download>下载离线版</a></span></footer>
    <div id="toastRoot" class="toast-root"></div>`;
}

function inputView() {
  const pdfText = state.pdfFiles.length ? `已选择 ${state.pdfFiles.length} 份 PDF` : "拖入整个 PDF 文件夹";
  const pdfHint = state.pdfFiles.length ? state.pdfFiles.map((file) => file.name).join(" · ") : "也可以点击选择文件夹；会自动忽略非 PDF 文件";
  const excelText = state.workbookFile ? state.workbookFile.name : "公司工作簿（可选）";
  const excelHint = state.workbookFile ? `${(state.workbookFile.size / 1024 / 1024).toFixed(2)} MB · 原文件不会被修改` : "不上传也能使用，将生成直观的解析汇总表";
  return shell(`
    <section class="workspace-card input-card">
      <div class="section-heading"><div><span class="section-number">01</span><h2>准备本季度文件</h2><p>PDF 为必选，公司工作簿可按需要上传。</p></div><div class="privacy-note">${icon("shield")}<span><b>文件仅在本机处理</b><small>不会上传到服务器</small></span></div></div>
      <div class="drop-grid">
        <div class="drop-zone ${state.pdfFiles.length ? "has-file" : ""}" id="pdfDrop" tabindex="0" role="button">
          <input id="pdfInput" type="file" accept="application/pdf,.pdf" multiple webkitdirectory hidden />
          <span class="drop-icon pdf">${icon("file")}</span><div><b>${escapeHtml(pdfText)}</b><p>${escapeHtml(pdfHint)}</p></div><button type="button" class="ghost-button" data-pick="pdf">${state.pdfFiles.length ? "重新选择" : "选择文件夹"}</button>
        </div>
        <div class="drop-zone ${state.workbookFile ? "has-file" : ""}" id="excelDrop" tabindex="0" role="button">
          <input id="excelInput" type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12" hidden />
          <span class="drop-icon excel">${icon("sheet")}</span><div><b>${escapeHtml(excelText)}</b><p>${escapeHtml(excelHint)}</p></div><button type="button" class="ghost-button" data-pick="excel">${state.workbookFile ? "重新选择" : "选择工作簿"}</button>
        </div>
      </div>
      <div class="input-footer">
        <div class="requirements"><span class="dot"></span><span>文件名格式：<b>2026Q2-HY-US-…pdf</b></span><span class="divider"></span><span>支持 15 个 Amazon 国家站点</span></div>
        <button id="startButton" class="primary-button" ${!state.pdfFiles.length ? "disabled" : ""}>解析并开始审核 ${icon("arrow")}</button>
      </div>
    </section>
    <section class="feature-strip">
      <article>${icon("eye")}<div><b>上下文证据在上</b><span>保留表头并框出当前数据</span></div></article>
      <article>${icon("keyboard")}<div><b>键盘顺序审核</b><span>Enter 确认后自动前进</span></div></article>
      <article>${icon("sheet")}<div><b>两种导出方式</b><span>写入公司模板，或直接下载汇总表</span></div></article>
    </section>`, 1);
}

function statusForCountry(country) {
  const unresolved = TARGET_FIELDS.filter((name) => !country.fields[name].decision).length;
  if (!unresolved) return ["已完成", "complete"];
  if (country.health === "REVIEW_REQUIRED") return [`${unresolved} 项待处理`, "warning"];
  return [`${unresolved} 项待审核`, "pending"];
}

function currentData() {
  if (!state.session || !state.cursor) return [null, null];
  return [countryByKey(state.session, state.cursor[0]), state.cursor[1]];
}

function reviewView() {
  const [country, fieldName] = currentData();
  const field = country.fields[fieldName];
  const summary = reviewSummary(state.session);
  const itemIndex = reviewItems(state.session).findIndex(([key, name]) => key === country.key && name === fieldName);
  const displayValue = field.suggestedValue ?? field.value;
  const adValue = finalValue(country.fields.advertising) ?? country.fields.advertising.value;
  const calculation = fieldName === "commission_service_fee" ? `<span class="calc-note">计算：ABS(Expenses Debits ${formatAmount(country.expensesSubtotalDebits, country.metadata.currency)}) − 广告 ${formatAmount(adValue, country.metadata.currency)}</span>` : "";
  const evidencePage = field.evidenceRegion?.pageIndex ?? field.sourceBbox?.pageIndex;
  const evidenceMarkCount = field.evidenceMarks?.length || 0;
  const evidenceGuide = evidenceMarkCount
    ? `<span class="mark-key"><i></i>${fieldName === "commission_service_fee" ? "蓝线连接广告与 Expenses 小计" : "蓝线连接字段与当前数据"}</span>`
    : `<span class="mark-key muted">显示所属区域，请人工定位</span>`;
  const countries = state.session.countries.map((item) => {
    const [label, tone] = statusForCountry(item);
    const active = item.key === country.key;
    const firstItem = [item.key, TARGET_FIELDS.find((name) => !item.fields[name].decision) || TARGET_FIELDS.at(-1)];
    const reachable = isReachable(state.session, firstItem);
    return `<button class="country-row ${active ? "active" : ""}" data-country="${escapeHtml(item.key)}" ${reachable ? "" : "disabled"}><span class="country-code">${item.metadata.country}</span><span><b>${item.metadata.countryName}</b><small>${item.metadata.currency}</small></span><i class="status-dot ${tone}"></i><em>${label}</em></button>`;
  }).join("");
  const tableRows = TARGET_FIELDS.map((name) => {
    const item = country.fields[name];
    const selected = name === fieldName;
    const reachable = isReachable(state.session, [country.key, name]);
    const shown = finalValue(item) ?? item.suggestedValue ?? item.value;
    return `<button class="field-row ${selected ? "active" : ""} ${item.decision ? "resolved" : ""}" data-field="${name}" ${reachable ? "" : "disabled"}><span>${item.decision ? icon("check") : `<i>${TARGET_FIELDS.indexOf(name) + 1}</i>`}<b>${FIELD_LABELS[name]}</b></span><strong>${formatAmount(shown, country.metadata.currency)}</strong><em class="status-tag ${item.decision ? "resolved" : item.status.toLowerCase()}">${decisionLabel(item.decision)}</em></button>`;
  }).join("");
  return shell(`
    <section class="review-shell">
      <aside class="country-panel">
        <div class="panel-title"><span class="section-number">02</span><div><h2>国家与进度</h2><p>${summary.fields - summary.unresolved} / ${summary.fields} 项已核对</p></div></div>
        <div class="progress-track"><i style="width:${summary.fields ? ((summary.fields - summary.unresolved) / summary.fields) * 100 : 0}%"></i></div>
        <div class="country-list">${countries}</div>
        <button id="previewButton" class="summary-button" ${allReviewed(state.session) ? "" : "disabled"}>${icon("eye")}预览汇总并生成</button>
        <small class="panel-help">必须按顺序看完证据；已审核项目可随时向上返回。</small>
      </aside>
      <section class="review-main">
        <header class="review-header">
          <div><span class="country-badge">${country.metadata.country}</span><div><h2>${country.metadata.countryName} · ${FIELD_LABELS[fieldName]}</h2><p>${escapeHtml(country.metadata.sourceName)}</p></div></div>
          <div class="validation-pills"><span class="${country.incomeValidation.status === "PASS" ? "pass" : "warn"}">Income ${country.incomeValidation.status}</span><span class="${country.expensesValidation.status === "PASS" ? "pass" : "warn"}">Expenses ${country.expensesValidation.status}</span></div>
        </header>
        <div class="evidence-card">
          <div class="evidence-label"><span>Amazon 原 PDF 上下文证据</span><small>${evidenceGuide}<span>第 ${evidencePage == null ? "—" : evidencePage + 1} 页</span></small></div>
          <div class="canvas-stage" id="canvasStage"><canvas id="evidenceCanvas"></canvas><div id="evidencePlaceholder" class="evidence-placeholder">${icon("eye")}<b>该字段没有可靠的上下文区域</b><span>请参考原始 PDF 并选择人工值、确认为 0 或跳过</span></div></div>
        </div>
        <div class="decision-card">
          <div class="value-line"><div><span>程序提取值</span><strong>${formatAmount(displayValue, country.metadata.currency)} <em>${country.metadata.currency}</em></strong></div><div class="source-status"><span class="status-tag ${field.status.toLowerCase()}">${field.status}</span>${calculation}</div></div>
          <div class="action-line">
            <button class="confirm-button" data-action="approve">${icon("check")}确认并继续 <kbd>Enter</kbd></button>
            <label class="manual-box"><span>人工金额</span><input id="manualInput" inputmode="decimal" placeholder="输入正确金额" /><button data-action="manual">采用 <kbd>M</kbd></button></label>
            <button class="secondary-button" data-action="zero">确认为 0 <kbd>0</kbd></button>
            <button class="secondary-button" data-action="skip">跳过 <kbd>S</kbd></button>
          </div>
          <div class="nav-line">
            <button data-nav="-1" ${itemIndex <= 0 ? "disabled" : ""}>↑ 上一个</button><button data-nav="1" ${move(state.session, state.cursor, 1)?.join("|") === state.cursor.join("|") ? "disabled" : ""}>↓ 下一个</button><button id="undoButton" ${state.session.history.length ? "" : "disabled"}>${icon("rotate")}撤销 <kbd>Ctrl Z</kbd></button><span>方向键上下切换；第一个字段向上即到上一国家最后一个字段</span>
          </div>
        </div>
        <div class="field-list" aria-label="本国六个审核字段">${tableRows}</div>
      </section>
    </section>`, 2);
}

function previewModal() {
  const summary = reviewSummary(state.session);
  const rows = state.session.countries.map((country) => `<tr><td><span class="country-code small">${country.metadata.country}</span>${country.metadata.countryName}</td>${TARGET_FIELDS.map((name) => `<td><b>${formatAmount(finalValue(country.fields[name]), country.metadata.currency)}</b><small>${decisionLabel(country.fields[name].decision)}</small></td>`).join("")}</tr>`).join("");
  const targetDescription = state.workbookFile
    ? `目标工作表：${escapeHtml(state.workbookPlan.targetQuarter)} · ${state.workbookPlan.requiresCreation ? `将复制“${escapeHtml(state.workbookPlan.sourceSheet)}”创建新季度，并清空未上传国家的旧值` : "使用现有季度工作表；缺失国家将自动追加"}`
    : "未上传公司工作簿：将生成与本预览同结构的解析汇总表，并在每个国家右侧嵌入完整报告截图";
  const generateLabel = state.workbookFile ? "确认无误并生成公司工作簿" : "确认无误并下载解析汇总表";
  return `<div class="modal-backdrop" id="previewModal"><div class="preview-modal" role="dialog" aria-modal="true" aria-labelledby="previewTitle">
    <header><div><span class="section-number">03</span><div><h2 id="previewTitle">写入前最终确认</h2><p>${state.session.countries[0].metadata.quarter} · ${state.session.countries[0].metadata.store} · ${summary.countries} 个国家 / ${summary.fields} 个字段</p></div></div><button id="closePreview" aria-label="关闭">×</button></header>
    <div class="preview-alert">${icon("shield")}<div><b>这是下载 Excel 前的最终确认</b><span>${targetDescription}</span></div></div>
    <div class="table-scroll"><table><thead><tr><th>国家</th>${TARGET_FIELDS.map((name) => `<th>${FIELD_LABELS[name]}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="preview-stats"><span><b>${summary.APPROVED}</b>提取值</span><span><b>${summary.MANUAL}</b>人工值</span><span><b>${summary.CONFIRMED_ZERO}</b>确认零</span><span><b>${summary.SKIP}</b>跳过</span></div>
    <footer><button id="backToReview" class="secondary-button">返回修改</button><button id="generateButton" class="primary-button">${icon("download")}${generateLabel}</button></footer>
  </div></div>`;
}

function successView() {
  const summary = reviewSummary(state.session);
  const detail = state.output.summaryOnly
    ? `已导出 ${summary.countries} 个国家、${summary.fields - summary.SKIP} 个有效字段，并嵌入 ${state.output.imageCount} 张完整报告截图。`
    : `已写入 ${summary.countries} 个国家、${summary.fields - summary.SKIP} 个字段，并嵌入每个国家的完整报告截图。源工作簿没有被修改。`;
  const target = state.output.summaryOnly
    ? "解析汇总表 · 无需公司模板"
    : `目标工作表 ${state.output.targetSheet} · ${state.output.createdSheet ? `由 ${state.output.sourceSheet} 复制创建` : "使用现有工作表"}`;
  return shell(`<section class="success-card"><span class="success-mark">${icon("check")}</span><span class="eyebrow">EXPORT READY</span><h2>Excel 已在浏览器中生成</h2><p>${detail}</p><div class="output-file">${icon("sheet")}<div><b>${escapeHtml(state.output.fileName)}</b><span>${target}</span></div><button id="downloadAgain">${icon("download")}再次下载</button></div><div class="success-actions"><button id="newBatch" class="secondary-button">处理另一批文件</button><button id="auditDownload" class="ghost-button">下载审核记录 JSON</button></div></section>`, 3);
}

function render() {
  const pageScrollLeft = window.scrollX;
  const pageScrollTop = window.scrollY;
  const currentList = document.querySelector(".country-list");
  if (currentList) state.countryScrollTop = currentList.scrollTop;
  const currentReview = document.querySelector(".review-main");
  if (currentReview) state.reviewScrollTop = currentReview.scrollTop;
  const nextCountryKey = state.session && state.cursor ? state.cursor[0] : null;
  const countryChanged = nextCountryKey !== state.renderedCountryKey;
  app.innerHTML = state.output ? successView() : state.session ? reviewView() : inputView();
  bindEvents();
  if (state.session && !state.output) {
    restoreCountryListScroll(countryChanged);
    restoreReviewScroll(pageScrollLeft, pageScrollTop);
    updateEvidence();
  }
  state.renderedCountryKey = nextCountryKey;
  if (state.previewOpen && state.session) {
    document.body.insertAdjacentHTML("beforeend", previewModal());
    bindPreviewEvents();
  }
  renderBusy();
}

function restoreReviewScroll(pageScrollLeft, pageScrollTop) {
  requestAnimationFrame(() => {
    const review = document.querySelector(".review-main");
    if (review) review.scrollTop = Math.min(state.reviewScrollTop, Math.max(0, review.scrollHeight - review.clientHeight));
    window.scrollTo({ left: pageScrollLeft, top: pageScrollTop, behavior: "auto" });
  });
}

function restoreCountryListScroll(countryChanged) {
  requestAnimationFrame(() => {
    const list = document.querySelector(".country-list");
    const active = list?.querySelector(".country-row.active");
    if (!list) return;
    list.scrollTop = state.countryScrollTop;
    if (!countryChanged || !active) return;
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const padding = 7;
    if (activeRect.top < listRect.top + padding) {
      list.scrollTop -= listRect.top + padding - activeRect.top;
    } else if (activeRect.bottom > listRect.bottom - padding) {
      list.scrollTop += activeRect.bottom - listRect.bottom + padding;
    }
    state.countryScrollTop = list.scrollTop;
  });
}

function setPdfFiles(files) {
  state.pdfFiles = [...files].filter((file) => file.name.toLowerCase().endsWith(".pdf")).sort((a, b) => a.name.localeCompare(b.name));
  if (!state.pdfFiles.length) toast("没有找到 PDF 文件", "error");
  render();
}

function setWorkbook(files) {
  const file = [...files].find((item) => /\.(xlsx|xlsm)$/i.test(item.name));
  if (!file) return toast("请拖入 .xlsx 或 .xlsm 工作簿", "error");
  state.workbookFile = file;
  render();
}

function bindDropZone(id, kind) {
  const zone = document.querySelector(`#${id}`);
  if (!zone) return;
  for (const eventName of ["dragenter", "dragover"]) zone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
  });
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove("dragging");
    try {
      const files = await droppedFiles(event.dataTransfer);
      if (kind === "pdf") setPdfFiles(files);
      else setWorkbook(files);
    } catch (error) {
      toast(`读取拖入内容失败：${error.message}`, "error");
    }
  });
  zone.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) document.querySelector(`#${kind}Input`)?.click(); });
}

function bindEvents() {
  document.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); document.querySelector(`#${button.dataset.pick}Input`)?.click(); }));
  document.querySelector("#pdfDrop")?.addEventListener("click", (event) => { if (!event.target.closest("button")) document.querySelector("#pdfInput")?.click(); });
  document.querySelector("#excelDrop")?.addEventListener("click", (event) => { if (!event.target.closest("button")) document.querySelector("#excelInput")?.click(); });
  document.querySelector("#pdfInput")?.addEventListener("change", (event) => setPdfFiles(event.target.files));
  document.querySelector("#excelInput")?.addEventListener("change", (event) => setWorkbook(event.target.files));
  bindDropZone("pdfDrop", "pdf");
  bindDropZone("excelDrop", "excel");
  document.querySelector("#startButton")?.addEventListener("click", startExtraction);
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => applyDecision(button.dataset.action)));
  document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => navigate(Number(button.dataset.nav))));
  document.querySelectorAll("[data-field]").forEach((button) => button.addEventListener("click", () => selectCursor([currentData()[0].key, button.dataset.field])));
  document.querySelectorAll("[data-country]").forEach((button) => button.addEventListener("click", () => {
    const country = countryByKey(state.session, button.dataset.country);
    selectCursor([country.key, TARGET_FIELDS.find((name) => !country.fields[name].decision) || TARGET_FIELDS.at(-1)]);
  }));
  document.querySelector("#undoButton")?.addEventListener("click", doUndo);
  document.querySelector("#previewButton")?.addEventListener("click", openPreview);
  document.querySelector("#downloadAgain")?.addEventListener("click", downloadOutput);
  document.querySelector("#newBatch")?.addEventListener("click", () => { Object.assign(state, { pdfFiles: [], workbookFile: null, session: null, cursor: null, workbookPlan: null, output: null, previewOpen: false, countryScrollTop: 0, reviewScrollTop: 0, renderedCountryKey: null }); render(); });
  document.querySelector("#auditDownload")?.addEventListener("click", downloadAudit);
}

async function startExtraction() {
  if (!state.pdfFiles.length || state.busy) return;
  setBusy(true, "准备解析文件", 3);
  const results = [];
  const failures = [];
  try {
    for (let index = 0; index < state.pdfFiles.length; index += 1) {
      const file = state.pdfFiles[index];
      setBusy(true, `正在解析 ${file.name}`, (index / state.pdfFiles.length) * 80 + 5);
      try {
        results.push(await extractPdf(file, (message) => { state.progressText = `${file.name} · ${message}`; renderBusy(); }));
      } catch (error) {
        failures.push({ sourcePdf: file.name, error: error.message });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!results.length) throw new Error(`没有 PDF 解析成功。${failures.map((item) => `${item.sourcePdf}: ${item.error}`).join("；")}`);
    const quarters = new Set(results.map((item) => item.metadata.quarter));
    const stores = new Set(results.map((item) => item.metadata.store));
    if (quarters.size !== 1 || stores.size !== 1) throw new Error("一次处理的 PDF 必须属于同一个季度和店铺");
    const codes = results.map((item) => item.metadata.country);
    if (new Set(codes).size !== codes.length) throw new Error("同一批文件中存在重复国家");
    if (state.workbookFile) {
      setBusy(true, "检查工作簿结构", 90);
      state.workbookPlan = await analyzeWorkbook(state.workbookFile, [...quarters][0]);
    } else {
      state.workbookPlan = { targetQuarter: [...quarters][0], requiresCreation: true, sourceSheet: null, summaryOnly: true };
    }
    state.session = createReviewSession(results, failures);
    state.cursor = firstUnresolved(state.session);
    state.countryScrollTop = 0;
    state.reviewScrollTop = 0;
    state.renderedCountryKey = null;
    toast(`解析完成：成功 ${results.length}，失败 ${failures.length}`, failures.length ? "warning" : "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
    render();
  }
}

let evidenceToken = 0;
async function updateEvidence() {
  const token = ++evidenceToken;
  const canvas = document.querySelector("#evidenceCanvas");
  const placeholder = document.querySelector("#evidencePlaceholder");
  if (!canvas) return;
  const [country, fieldName] = currentData();
  try {
    const shown = await renderEvidence(country, fieldName, canvas);
    if (token !== evidenceToken) return;
    canvas.hidden = !shown;
    placeholder.hidden = shown;
    if (shown) focusEvidenceMark(canvas);
  } catch (error) {
    canvas.hidden = true;
    placeholder.hidden = false;
    toast(`证据截图渲染失败：${error.message}`, "error");
  }
}

function focusEvidenceMark(canvas) {
  requestAnimationFrame(() => {
    const stage = document.querySelector("#canvasStage");
    if (!stage || stage.scrollHeight <= stage.clientHeight + 1) return;
    const focusRatio = Number(canvas.dataset.focusRatio || 0.5);
    const target = canvas.offsetTop + canvas.clientHeight * focusRatio - stage.clientHeight / 2;
    stage.scrollTop = Math.max(0, Math.min(target, stage.scrollHeight - stage.clientHeight));
  });
}

function selectCursor(target) {
  if (!isReachable(state.session, target)) return toast("请先审核当前字段，再继续向下", "warning");
  state.cursor = target;
  render();
}

function navigate(direction) {
  const target = move(state.session, state.cursor, direction);
  if (target && target.join("|") !== state.cursor.join("|")) selectCursor(target);
  else if (direction > 0) toast("请先审核当前字段", "warning");
}

function applyDecision(action) {
  const [country, fieldName] = currentData();
  const mapping = { approve: DECISIONS.APPROVED, manual: DECISIONS.MANUAL, zero: DECISIONS.CONFIRMED_ZERO, skip: DECISIONS.SKIP };
  const manual = document.querySelector("#manualInput")?.value;
  try {
    setDecision(state.session, country.key, fieldName, mapping[action], manual);
    const target = move(state.session, state.cursor, 1);
    if (target) state.cursor = target;
    if (allReviewed(state.session)) {
      state.previewOpen = true;
      toast("全部字段已核对，请完成写入前确认", "success");
    }
    render();
  } catch (error) {
    toast(error.message, "error");
    if (action === "manual") document.querySelector("#manualInput")?.focus();
  }
}

function doUndo() {
  const target = undo(state.session);
  if (target) {
    state.cursor = target;
    render();
    toast("已撤销上一次审核决定");
  }
}

function openPreview() {
  if (!allReviewed(state.session)) return toast("请先完成全部字段审核", "warning");
  state.previewOpen = true;
  render();
}

function closePreview() {
  state.previewOpen = false;
  document.querySelector("#previewModal")?.remove();
}

function bindPreviewEvents() {
  document.querySelector("#closePreview")?.addEventListener("click", closePreview);
  document.querySelector("#backToReview")?.addEventListener("click", closePreview);
  document.querySelector("#generateButton")?.addEventListener("click", generateWorkbook);
  document.querySelector("#previewModal")?.addEventListener("click", (event) => { if (event.target.id === "previewModal") closePreview(); });
}

async function generateWorkbook() {
  if (state.busy) return;
  closePreview();
  setBusy(true, "生成完整报告截图", 2);
  try {
    const images = new Map();
    for (let index = 0; index < state.session.countries.length; index += 1) {
      const country = state.session.countries[index];
      setBusy(true, `生成 ${country.metadata.countryName} 完整报告截图`, (index / state.session.countries.length) * 40 + 3);
      images.set(country.key, await renderFullReport(country));
    }
    if (state.workbookFile) {
      state.output = await writeWorkbook(state.workbookFile, state.session, images, (message, value, total) => setBusy(true, message, 45 + (Number(value) / Math.max(Number(total), 1)) * 52));
    } else {
      state.output = await createSummaryWorkbook(state.session, images, (message, value, total) => setBusy(true, message, 45 + (Number(value) / Math.max(Number(total), 1)) * 52));
    }
    downloadOutput();
    toast("Excel 已生成并开始下载", "success");
  } catch (error) {
    toast(`生成失败：${error.message}`, "error");
    state.previewOpen = true;
  } finally {
    setBusy(false);
    render();
  }
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadOutput() {
  if (state.output) saveBlob(state.output.blob, state.output.fileName);
}

function downloadAudit() {
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workbook: state.output.fileName,
    targetSheet: state.output.targetSheet,
    countries: state.session.countries.map((country) => ({
      metadata: country.metadata,
      validations: { income: country.incomeValidation, expenses: country.expensesValidation },
      expensesSubtotalDebits: country.expensesSubtotalDebits,
      fields: Object.fromEntries(TARGET_FIELDS.map((name) => [name, { extractedValue: country.fields[name].value, decision: country.fields[name].decision, finalValue: finalValue(country.fields[name]) }])),
      writeStatus: state.output.statuses[country.key],
    })),
    failures: state.session.failures,
  };
  saveBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${state.output.targetSheet}_审核记录.json`);
}

document.addEventListener("keydown", (event) => {
  if (!state.session || state.output || state.busy) return;
  if (event.key === "Escape" && state.previewOpen) return closePreview();
  if (state.previewOpen) return;
  const inputFocused = document.activeElement?.id === "manualInput";
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); return doUndo(); }
  if (event.key === "ArrowUp") { event.preventDefault(); return navigate(-1); }
  if (event.key === "ArrowDown") { event.preventDefault(); return navigate(1); }
  if (event.key.toLowerCase() === "m" && !inputFocused) { event.preventDefault(); return document.querySelector("#manualInput")?.focus(); }
  if (event.key === "0" && !inputFocused) { event.preventDefault(); return applyDecision("zero"); }
  if (event.key.toLowerCase() === "s" && !inputFocused) { event.preventDefault(); return applyDecision("skip"); }
  if (event.key === "Enter") { event.preventDefault(); return applyDecision(inputFocused && document.querySelector("#manualInput")?.value ? "manual" : "approve"); }
});

render();
