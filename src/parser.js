import { COUNTRIES, TARGET_FIELDS, canonicalCountryCode, countryConfig } from "./config.js";
import { subtractAbsAmounts } from "./amounts.js";

const FILE_PATTERN = /^(?<quarter>\d{4}Q[1-4])-(?<store>[A-Za-z0-9][A-Za-z0-9_]*?)-(?<country>[A-Za-z]{2})(?:-|_).+\.pdf$/i;
const UNICODE_MINUSES = /[−–—‒﹣－]/g;

export function parseFilename(name, requireSupported = true) {
  const base = String(name).split(/[\\/]/).pop();
  const match = base.match(FILE_PATTERN);
  if (!match?.groups) {
    throw new Error(`PDF 文件名不符合“季度-店铺-国家-其他内容.pdf”：${base}`);
  }
  const filenameCountry = match.groups.country.toUpperCase();
  const parsed = {
    quarter: match.groups.quarter.toUpperCase(),
    store: match.groups.store.toUpperCase(),
    country: canonicalCountryCode(filenameCountry),
  };
  if (requireSupported && !COUNTRIES[parsed.country]) {
    throw new Error(`文件名中的国家 ${filenameCountry} 尚未配置`);
  }
  return parsed;
}

export function parseAmount(text, config) {
  let raw = String(text).normalize("NFKC").replace(UNICODE_MINUSES, "-").replace(/\u00a0/g, " ").trim();
  if (!/\d/.test(raw)) throw new Error(`不是金额：${text}`);
  const negativeParentheses = raw.startsWith("(") && raw.endsWith(")");
  let cleaned = raw.replace(/[^0-9,.'()\-]/g, "").replaceAll("'", "");
  if (negativeParentheses) cleaned = cleaned.slice(1, -1);
  if (cleaned.endsWith("-") && !cleaned.startsWith("-")) cleaned = `-${cleaned.slice(0, -1)}`;
  if ((cleaned.match(/-/g) || []).length > 1 || (cleaned.includes("-") && !cleaned.startsWith("-"))) {
    throw new Error(`金额负号位置异常：${text}`);
  }
  if (config.thousandsSeparator) cleaned = cleaned.split(config.thousandsSeparator).join("");
  if (config.decimalSeparator !== ".") cleaned = cleaned.replace(config.decimalSeparator, ".");
  cleaned = cleaned.replace(/[()]/g, "");
  if (negativeParentheses && !cleaned.startsWith("-")) cleaned = `-${cleaned}`;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) throw new Error(`无法按 ${config.currency} 解析金额：${text}`);
  return value;
}

function tryParseAmount(text, config) {
  try {
    return parseAmount(text, config);
  } catch {
    return null;
  }
}

export function normalizeAnchor(text) {
  return String(text).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function buildLines(words, pageIndex, { yTolerance = 2.5, xMin = null, xMax = null } = {}) {
  const selected = words
    .filter((word) => (xMin == null || word.centerX >= xMin) && (xMax == null || word.centerX < xMax))
    .slice()
    .sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const groups = [];
  for (const word of selected) {
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      const delta = Math.abs(group[0].top - word.top);
      if (delta <= yTolerance && delta < bestDelta) {
        best = group;
        bestDelta = delta;
      }
    }
    if (best) best.push(word);
    else groups.push([word]);
  }
  return groups
    .map((group) => {
      group.sort((a, b) => a.x0 - b.x0);
      return {
        pageIndex,
        words: group,
        text: group.map((word) => word.text).join(" "),
        top: Math.min(...group.map((word) => word.top)),
        bottom: Math.max(...group.map((word) => word.bottom)),
        bbox: {
          pageIndex,
          x0: Math.min(...group.map((word) => word.x0)),
          top: Math.min(...group.map((word) => word.top)),
          x1: Math.max(...group.map((word) => word.x1)),
          bottom: Math.max(...group.map((word) => word.bottom)),
        },
      };
    })
    .sort((a, b) => a.top - b.top || a.bbox.x0 - b.bbox.x0);
}

export function findAliasBbox(line, aliases) {
  const normalizedWords = line.words.map((word) => normalizeAnchor(word.text));
  const joined = normalizedWords.join("");
  if (!joined) return null;
  const offsets = [];
  let cursor = 0;
  for (const token of normalizedWords) {
    offsets.push([cursor, cursor + token.length]);
    cursor += token.length;
  }
  const ordered = aliases.slice().sort((a, b) => normalizeAnchor(b).length - normalizeAnchor(a).length);
  for (const alias of ordered) {
    const needle = normalizeAnchor(alias);
    const start = joined.indexOf(needle);
    if (!needle || start < 0) continue;
    const end = start + needle.length;
    const matched = line.words.filter((_, index) => offsets[index][1] > start && offsets[index][0] < end);
    if (matched.length) {
      return {
        pageIndex: line.pageIndex,
        x0: Math.min(...matched.map((word) => word.x0)),
        top: Math.min(...matched.map((word) => word.top)),
        x1: Math.max(...matched.map((word) => word.x1)),
        bottom: Math.max(...matched.map((word) => word.bottom)),
      };
    }
  }
  return null;
}

function amountCandidates(line, config) {
  return line.words.flatMap((word) => {
    const value = tryParseAmount(word.text, config);
    return value == null ? [] : [[word, value]];
  });
}

function closestAmount(line, targetX, config, maxDistance) {
  if (!line) return null;
  const candidates = amountCandidates(line, config);
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(a[0].centerX - targetX) - Math.abs(b[0].centerX - targetX));
  return Math.abs(candidates[0][0].centerX - targetX) <= maxDistance ? candidates[0] : null;
}

function detailHeaders(page, config) {
  const lines = buildLines(page.words, page.pageIndex);
  const candidates = [];
  for (const line of lines) {
    const income = findAliasBbox(line, config.aliases.income_section);
    const expenses = findAliasBbox(line, config.aliases.expenses_section);
    if (income && expenses && income.x0 < expenses.x0 && expenses.x0 - income.x0 >= page.width * 0.25) {
      candidates.push([line, income, expenses]);
    }
  }
  if (!candidates.length) throw new Error("未找到同一行的 Income/Expenses 明细区标题");
  return candidates.sort((a, b) => b[0].top - a[0].top)[0];
}

function columnCenters(lines, headerTop, config) {
  for (const line of lines) {
    if (line.top <= headerTop || line.top > headerTop + 55) continue;
    const debit = findAliasBbox(line, config.aliases.debits);
    const credit = findAliasBbox(line, config.aliases.credits);
    if (debit && credit && debit.x0 < credit.x0) {
      return [(debit.x0 + debit.x1) / 2, (credit.x0 + credit.x1) / 2];
    }
  }
  throw new Error("未找到 Debits/Credits 金额列标题");
}

function subtotalLine(lines, headerTop, aliases) {
  return lines.find((line) => line.top > headerTop + 5 && findAliasBbox(line, aliases)) || null;
}

function wordBbox(word, pageIndex) {
  if (!word) return null;
  return { pageIndex, x0: word.x0, top: word.top, x1: word.x1, bottom: word.bottom };
}

function fieldFromAmount(name, value, line, message = "", amountWord = null) {
  if (!line || value == null) return { name, status: "NOT_FOUND", value: null, rawText: "", message: message || "未找到目标字段或金额", sourceBbox: null };
  const normalized = Math.abs(value);
  const amountBbox = wordBbox(amountWord, line.pageIndex);
  return {
    name,
    status: normalized === 0 ? "VERIFIED_ZERO" : "FOUND",
    value: normalized,
    rawText: line.text,
    message,
    sourceBbox: line.bbox,
    evidenceMarks: amountBbox ? [{ bbox: amountBbox, rowBbox: line.bbox, label: "当前数据" }] : [],
  };
}

function targetField(name, lines, aliases, targetX, config, headerTop, subtotalTop, maxDistance) {
  const matching = lines.filter((line) => line.top > headerTop + 5 && (subtotalTop == null || line.top < subtotalTop + 1) && findAliasBbox(line, aliases));
  if (!matching.length) return { name, status: "NOT_FOUND", value: null, rawText: "", message: "目标字段标签未找到；未自动按 0 处理", sourceBbox: null };
  if (matching.length > 1) return { name, status: "AMBIGUOUS", value: null, rawText: matching.map((line) => line.text).join(" | "), message: `找到 ${matching.length} 个候选标签，无法可靠选择`, sourceBbox: matching[0].bbox };
  const line = matching[0];
  const amount = closestAmount(line, targetX, config, maxDistance);
  if (!amount) return { name, status: "PARSE_ERROR", value: null, rawText: line.text, message: "找到标签，但同一行目标金额列无法解析", sourceBbox: line.bbox };
  return fieldFromAmount(name, amount[1], line, "", amount[0]);
}

function sectionEvidenceRegion(page, detailLine, subtotal, x0, x1) {
  const verticalFallback = Math.max(page.height * 0.34, 180);
  return {
    pageIndex: page.pageIndex,
    x0: Math.max(0, x0),
    top: Math.max(0, detailLine.top - 18),
    x1: Math.min(page.width, x1),
    bottom: Math.min(page.height, subtotal ? subtotal.bottom + 18 : detailLine.top + verticalFallback),
  };
}

function expandEvidenceRegion(region, fields, page) {
  const boxes = fields.flatMap((field) => [field?.sourceBbox, ...(field?.evidenceMarks || []).map((mark) => mark?.bbox)]).filter((box) => box?.pageIndex === region.pageIndex);
  if (!boxes.length) return region;
  return {
    ...region,
    top: Math.max(0, Math.min(region.top, ...boxes.map((box) => box.top - 18))),
    bottom: Math.min(page.height, Math.max(region.bottom, ...boxes.map((box) => box.bottom + 18))),
  };
}

function summaryAmount(lines, aliases, beforeTop, pageWidth, config) {
  const matching = lines.filter((line) => line.top < beforeTop - 4 && findAliasBbox(line, aliases)).sort((a, b) => b.top - a.top);
  for (const line of matching) {
    const candidates = amountCandidates(line, config).sort((a, b) => Math.abs(a[0].centerX - pageWidth) - Math.abs(b[0].centerX - pageWidth));
    if (candidates[0]?.[0].centerX > pageWidth * 0.7) return candidates[0][1];
  }
  return null;
}

function unionBbox(first, second) {
  if (!first) return second;
  if (!second) return first;
  return { pageIndex: first.pageIndex, x0: Math.min(first.x0, second.x0), top: Math.min(first.top, second.top), x1: Math.max(first.x1, second.x1), bottom: Math.max(first.bottom, second.bottom) };
}

function validateNet(name, debit, credit, reported, tolerance) {
  if ([debit, credit, reported].some((value) => value == null)) return { status: "UNAVAILABLE", message: "小计或 Summary 净额不可用" };
  const calculated = name === "expenses" ? Math.abs(debit) - Math.abs(credit) : Math.abs(credit) - Math.abs(debit);
  const difference = Math.abs(calculated - Math.abs(reported));
  return { status: difference <= tolerance ? "PASS" : "VALIDATION_FAILED", calculated, reported, difference, message: difference <= tolerance ? "数学一致性验证通过" : `数学一致性验证不一致，差额 ${difference}` };
}

export function extractPageSnapshot(page, config) {
  const [detailLine, , expensesHeader] = detailHeaders(page, config);
  const splitX = expensesHeader.x0 - Math.min(12, page.width * 0.015);
  const leftLines = buildLines(page.words, page.pageIndex, { xMax: splitX });
  const rightLines = buildLines(page.words, page.pageIndex, { xMin: splitX });
  const fullLines = buildLines(page.words, page.pageIndex);
  const [leftDebitX, leftCreditX] = columnCenters(leftLines, detailLine.top, config);
  const [rightDebitX, rightCreditX] = columnCenters(rightLines, detailLine.top, config);
  const incomeSubtotal = subtotalLine(leftLines, detailLine.top, config.aliases.subtotal);
  const expensesSubtotal = subtotalLine(rightLines, detailLine.top, config.aliases.subtotal);
  const maxDistance = page.width * 0.12;
  const incomeDebitMatch = closestAmount(incomeSubtotal, leftDebitX, config, maxDistance);
  const incomeCreditMatch = closestAmount(incomeSubtotal, leftCreditX, config, maxDistance);
  const expensesDebitMatch = closestAmount(expensesSubtotal, rightDebitX, config, maxDistance);
  const expensesCreditMatch = closestAmount(expensesSubtotal, rightCreditX, config, maxDistance);
  const incomeDebit = incomeDebitMatch?.[1] ?? null;
  const incomeCredit = incomeCreditMatch?.[1] ?? null;
  const expensesDebit = expensesDebitMatch?.[1] ?? null;
  const expensesCredit = expensesCreditMatch?.[1] ?? null;
  const fields = {
    income: fieldFromAmount("income", incomeCredit, incomeSubtotal, "来自 Income subtotal Credits", incomeCreditMatch?.[0]),
    refund: fieldFromAmount("refund", incomeDebit, incomeSubtotal, "来自 Income subtotal Debits 的绝对值", incomeDebitMatch?.[0]),
  };
  const expensesSubtotalTop = expensesSubtotal?.top ?? null;
  fields.selling_fee_refund = targetField("selling_fee_refund", rightLines, config.aliases.selling_fee_refund, rightCreditX, config, detailLine.top, expensesSubtotalTop, maxDistance);
  fields.fba_transaction_fee_refund = targetField("fba_transaction_fee_refund", rightLines, config.aliases.fba_transaction_fee_refund, rightCreditX, config, detailLine.top, expensesSubtotalTop, maxDistance);
  fields.advertising = targetField("advertising", rightLines, config.aliases.advertising, rightDebitX, config, detailLine.top, expensesSubtotalTop, maxDistance);
  const ad = fields.advertising;
  if (expensesDebit == null) {
    fields.commission_service_fee = { name: "commission_service_fee", status: "NOT_FOUND", value: null, rawText: "", message: "Expenses subtotal Debits 未找到，无法计算", sourceBbox: null };
  } else if (ad.value == null) {
    fields.commission_service_fee = { name: "commission_service_fee", status: ad.status, value: null, rawText: ad.rawText, message: "广告字段不可用，无法按 Expenses Debit subtotal - Advertising 计算", sourceBbox: ad.sourceBbox };
  } else {
    const value = subtractAbsAmounts(expensesDebit, ad.value);
    fields.commission_service_fee = value < 0
      ? { name: "commission_service_fee", status: "PARSE_ERROR", value: null, rawText: "", message: "佣金服务费计算结果为负数，请人工核对", sourceBbox: null }
      : {
          ...fieldFromAmount("commission_service_fee", value, expensesSubtotal, "ABS(Expenses subtotal Debits) - Advertising"),
          sourceBbox: unionBbox(ad.sourceBbox, expensesSubtotal?.bbox),
          evidenceMarks: [
            expensesDebitMatch?.[0] ? { bbox: wordBbox(expensesDebitMatch[0], page.pageIndex), rowBbox: expensesSubtotal?.bbox, label: "Expenses 小计" } : null,
            ad.evidenceMarks?.[0] ? { bbox: ad.evidenceMarks[0].bbox, rowBbox: ad.evidenceMarks[0].rowBbox, label: "广告" } : null,
          ].filter(Boolean),
        };
  }
  const leftRegion = expandEvidenceRegion(sectionEvidenceRegion(page, detailLine, incomeSubtotal, 0, splitX), [fields.income, fields.refund], page);
  const rightRegion = expandEvidenceRegion(
    sectionEvidenceRegion(page, detailLine, expensesSubtotal, splitX, page.width),
    [fields.selling_fee_refund, fields.fba_transaction_fee_refund, fields.advertising, fields.commission_service_fee],
    page,
  );
  for (const name of ["income", "refund"]) fields[name].evidenceRegion = leftRegion;
  for (const name of ["selling_fee_refund", "fba_transaction_fee_refund", "advertising", "commission_service_fee"]) fields[name].evidenceRegion = rightRegion;
  const summaryIncome = summaryAmount(fullLines, config.aliases.income_section, detailLine.top, page.width, config);
  const summaryExpenses = summaryAmount(fullLines, config.aliases.expenses_section, detailLine.top, page.width, config);
  const tolerance = config.currency === "JPY" ? 1 : 0.01;
  return {
    fields,
    summaryIncome,
    summaryExpenses,
    incomeSubtotalDebits: incomeDebit,
    incomeSubtotalCredits: incomeCredit,
    expensesSubtotalDebits: expensesDebit,
    expensesSubtotalCredits: expensesCredit,
    incomeValidation: validateNet("income", incomeDebit, incomeCredit, summaryIncome, tolerance),
    expensesValidation: validateNet("expenses", expensesDebit, expensesCredit, summaryExpenses, tolerance),
    score: TARGET_FIELDS.filter((name) => ["FOUND", "VERIFIED_ZERO"].includes(fields[name].status)).length,
  };
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function textWords(content, viewport) {
  return content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const first = viewport.transform;
    const second = item.transform;
    const transform = [
      first[0] * second[0] + first[2] * second[1],
      first[1] * second[0] + first[3] * second[1],
      first[0] * second[2] + first[2] * second[3],
      first[1] * second[2] + first[3] * second[3],
      first[0] * second[4] + first[2] * second[5] + first[4],
      first[1] * second[4] + first[3] * second[5] + first[5],
    ];
    const height = Math.max(Math.hypot(transform[2], transform[3]), item.height || 0, 1);
    const width = Math.max(item.width || 0, 1);
    const x0 = transform[4];
    const top = transform[5] - height;
    return [{ text: item.str, x0, x1: x0 + width, top, bottom: top + height, centerX: x0 + width / 2 }];
  });
}

let browserPdfWorker = null;
let browserPdfWorkerUrl = null;

async function promiseWithTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function configuredBrowserWorker(PDFWorker, GlobalWorkerOptions) {
  if (!browserPdfWorkerUrl) {
    const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
    browserPdfWorkerUrl = URL.createObjectURL(new Blob([workerModule.default], { type: "text/javascript" }));
  }
  GlobalWorkerOptions.workerPort = null;
  GlobalWorkerOptions.workerSrc = browserPdfWorkerUrl;
  if (window.location.protocol === "file:" && !globalThis.pdfjsWorker?.WorkerMessageHandler) {
    try {
      globalThis.pdfjsWorker = await import(/* @vite-ignore */ browserPdfWorkerUrl);
    } catch (error) {
      throw new Error(`离线 PDF 解析引擎启动失败：${error.message}`);
    }
  }
  if (!browserPdfWorker) browserPdfWorker = new PDFWorker({ name: "amazon-pdf-parser" });
  await promiseWithTimeout(browserPdfWorker.promise, 20000, "PDF 解析引擎启动超时，请重新打开页面后再试");
  return browserPdfWorker;
}

export async function extractPdf(file, onProgress = () => {}) {
  const { getDocument, GlobalWorkerOptions, PDFWorker } = typeof window === "undefined"
    ? await import("pdfjs-dist/legacy/build/pdf.mjs")
    : await import("pdfjs-dist");
  const worker = typeof window === "undefined" ? null : await configuredBrowserWorker(PDFWorker, GlobalWorkerOptions);
  const parsed = parseFilename(file.name);
  const config = countryConfig(parsed.country);
  const buffer = await file.arrayBuffer();
  const sourceSha256 = await sha256(buffer);
  const loadingTask = getDocument({ data: new Uint8Array(buffer.slice(0)), useSystemFonts: true, ...(worker ? { worker } : {}) });
  const pdf = await loadingTask.promise;
  const snapshots = [];
  const errors = [];
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
    onProgress(`读取第 ${pageIndex + 1}/${pdf.numPages} 页`);
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    snapshots.push({ pageIndex, width: viewport.width, height: viewport.height, words: textWords(content, viewport) });
  }
  const candidates = [];
  for (const snapshot of snapshots) {
    try {
      candidates.push(extractPageSnapshot(snapshot, config));
    } catch (error) {
      errors.push(`第 ${snapshot.pageIndex + 1} 页：${error.message}`);
    }
  }
  if (!candidates.length) throw new Error(errors.join("；") || "PDF 没有可解析页面");
  candidates.sort((a, b) => b.score - a.score);
  const extracted = candidates[0];
  const good = TARGET_FIELDS.every((name) => ["FOUND", "VERIFIED_ZERO"].includes(extracted.fields[name].status));
  const validationFailed = [extracted.incomeValidation, extracted.expensesValidation].some((item) => item.status === "VALIDATION_FAILED");
  return {
    key: `${parsed.quarter}-${parsed.store}-${parsed.country}`,
    file,
    pdf,
    metadata: {
      ...parsed,
      sourceName: file.name,
      sourceSha256,
      countryName: config.displayName,
      currency: config.currency,
      pageCount: pdf.numPages,
    },
    ...extracted,
    health: good && !validationFailed ? "GOOD" : "REVIEW_REQUIRED",
    warnings: errors,
  };
}

const evidencePageCache = new WeakMap();

export function planEvidenceViewport(field, pageWidth, pageHeight) {
  const source = field.evidenceRegion || field.sourceBbox;
  if (!source) return null;
  const x0 = Math.max(0, Math.min(pageWidth - 1, source.x0));
  const top = Math.max(0, Math.min(pageHeight - 1, source.top));
  const x1 = Math.max(x0 + 1, Math.min(pageWidth, source.x1));
  const bottom = Math.max(top + 1, Math.min(pageHeight, source.bottom));
  return { pageIndex: source.pageIndex, x0, top, x1, bottom };
}

async function cachedEvidencePage(result, pageIndex, scale) {
  let pages = evidencePageCache.get(result);
  if (!pages) {
    pages = new Map();
    evidencePageCache.set(result, pages);
  }
  const key = `${pageIndex}:${scale}`;
  if (!pages.has(key)) {
    pages.set(key, (async () => {
      const page = await result.pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
      return { canvas, pageWidth: viewport.width / scale, pageHeight: viewport.height / scale };
    })());
  }
  return pages.get(key);
}

function drawEvidenceMark(context, mark, region, scale) {
  const padding = 4 * scale;
  const x = Math.max(1, (mark.bbox.x0 - region.x0) * scale - padding);
  const y = Math.max(1, (mark.bbox.top - region.top) * scale - padding);
  const right = Math.min(context.canvas.width - 1, (mark.bbox.x1 - region.x0) * scale + padding);
  const bottom = Math.min(context.canvas.height - 1, (mark.bbox.bottom - region.top) * scale + padding);
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  const row = mark.rowBbox || mark.bbox;
  const lineStart = Math.max(1, (row.x0 - region.x0) * scale - padding);
  context.save();
  context.strokeStyle = "rgba(37, 99, 235, 0.92)";
  context.lineWidth = Math.max(2.5, 1.35 * scale);
  context.lineCap = "round";
  context.shadowColor = "rgba(37, 99, 235, 0.3)";
  context.shadowBlur = 3 * scale;
  context.beginPath();
  context.moveTo(lineStart, bottom);
  context.lineTo(right, bottom);
  context.stroke();
  context.fillStyle = "rgba(37, 99, 235, 0.12)";
  context.fillRect(x, y, width, height);
  context.strokeStyle = "#2563eb";
  context.lineWidth = Math.max(3, 2 * scale);
  context.shadowColor = "rgba(37, 99, 235, 0.35)";
  context.shadowBlur = 5 * scale;
  context.strokeRect(x, y, width, height);
  context.restore();
}

export async function renderEvidence(result, fieldName, canvas, scale = 3) {
  const field = result.fields[fieldName];
  const source = field.evidenceRegion || field.sourceBbox;
  if (!source) {
    canvas.width = 0;
    canvas.height = 0;
    return false;
  }
  const rendered = await cachedEvidencePage(result, source.pageIndex, scale);
  const region = planEvidenceViewport(field, rendered.pageWidth, rendered.pageHeight);
  const x = region.x0 * scale;
  const y = region.top * scale;
  const right = region.x1 * scale;
  const bottom = region.bottom * scale;
  canvas.width = Math.max(1, Math.ceil(right - x));
  canvas.height = Math.max(1, Math.ceil(bottom - y));
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(rendered.canvas, x, y, right - x, bottom - y, 0, 0, canvas.width, canvas.height);
  const marks = (field.evidenceMarks || []).filter((mark) => mark?.bbox?.pageIndex === region.pageIndex);
  if (marks.length) {
    context.fillStyle = "rgba(15, 23, 42, 0.055)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const mark of marks) drawEvidenceMark(context, mark, region, scale);
  }
  return true;
}

export async function renderFullReport(result, scale = 1.5) {
  const pages = [];
  let width = 0;
  let height = 0;
  for (let index = 1; index <= result.pdf.numPages; index += 1) {
    const page = await result.pdf.getPage(index);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
    pages.push(canvas);
    width = Math.max(width, canvas.width);
    height += canvas.height;
  }
  const combined = document.createElement("canvas");
  combined.width = width;
  combined.height = height;
  const context = combined.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  let offset = 0;
  for (const page of pages) {
    context.drawImage(page, Math.floor((width - page.width) / 2), offset);
    offset += page.height;
  }
  const blob = await new Promise((resolve, reject) => combined.toBlob((value) => value ? resolve(value) : reject(new Error("截图生成失败")), "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}
