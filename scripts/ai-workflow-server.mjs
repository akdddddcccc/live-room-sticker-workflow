import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

const PORT = Number(process.env.AI_WORKFLOW_PORT || 8787);
const HOST = process.env.AI_WORKFLOW_HOST || "127.0.0.1";
const API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_PROVIDER_LABEL = process.env.OPENAI_PROVIDER_LABEL || (OPENAI_BASE_URL.includes("api.openai.com") ? "OpenAI official" : "Custom OpenAI-compatible API");

// --- Visitor quota / dual-provider routing (opt-in via QUOTA_ENABLED=1) ---
// When disabled (default) the server behaves exactly as before: single global
// provider read from OPENAI_* env. When enabled, each visitor gets QUOTA_CALLS
// image calls on the official provider, then automatically falls back to the
// relay provider (FALLBACK_OPENAI_*). Channel is decided by deployment env,
// not by sniffing the request host, so the two deployments stay isolated.
const QUOTA_ENABLED = process.env.QUOTA_ENABLED === "1";
const QUOTA_CALLS = Number(process.env.QUOTA_CALLS || 20); // 5 rounds * 4 image calls
const FALLBACK_OPENAI_BASE_URL = (process.env.FALLBACK_OPENAI_BASE_URL || "https://api.ofox.io/v1").replace(/\/+$/, "");
const FALLBACK_OPENAI_API_KEY = process.env.FALLBACK_OPENAI_API_KEY || "";
const FALLBACK_PROVIDER_LABEL = process.env.FALLBACK_PROVIDER_LABEL || "ofox relay";
const QUOTA_STORE_PATH = process.env.QUOTA_STORE_PATH
  ? new URL(`file://${process.env.QUOTA_STORE_PATH}`)
  : new URL("../.data/visitor-quota.json", import.meta.url);

// Per-request context: which provider to use + how many official calls this
// visitor has spent. requestOpenAIImage() and the provider-aware edit helpers
// read it, so the rest of the pipeline is untouched.
const requestContext = new AsyncLocalStorage();

function activeBaseUrl() {
  const ctx = requestContext.getStore();
  if (ctx && ctx.provider) return ctx.provider.baseUrl;
  return openAIBaseUrl();
}

function activeProvider() {
  const ctx = requestContext.getStore();
  if (ctx && ctx.provider) return ctx.provider;
  return { baseUrl: openAIBaseUrl(), apiKey: openAIKey(), label: openAIProviderLabel(), tier: "default" };
}
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "low";
const IMAGE_OUTPUT_FORMAT = process.env.OPENAI_IMAGE_OUTPUT_FORMAT || "jpeg";
const TEXT_LAYER_OUTPUT_FORMAT = process.env.OPENAI_TEXT_LAYER_OUTPUT_FORMAT || "png";
const DEFAULT_IMAGE_USE_EDITS = process.env.OPENAI_IMAGE_USE_EDITS !== "0";
const IMAGE_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || 90000);
const IMAGE_EDIT_FIELD = process.env.OPENAI_IMAGE_EDIT_FIELD || "";
const IMAGE_EDIT_SIZE = process.env.OPENAI_IMAGE_EDIT_SIZE || "";
const IMAGE_EDIT_FALLBACK_SIZE = process.env.OPENAI_IMAGE_EDIT_FALLBACK_SIZE || (OPENAI_BASE_URL.includes("api.ofox.io") ? "1024x1024" : "");
const IMAGE_EDIT_INCLUDE_EXTRAS = process.env.OPENAI_IMAGE_EDIT_INCLUDE_EXTRAS === "1";
const TEXT_LAYER_SIZE = process.env.OPENAI_TEXT_LAYER_SIZE || "1536x1024";
const TEXT_LAYER_USE_API = process.env.OPENAI_TEXT_LAYER_USE_API !== "0";
const TEXT_LAYER_USE_FONT_REFERENCE = process.env.OPENAI_TEXT_LAYER_USE_FONT_REFERENCE !== "0";
const TEXT_LAYER_USE_SOURCE_REFERENCE = process.env.OPENAI_TEXT_LAYER_USE_SOURCE_REFERENCE === "1";
const GENERATION_MODE = process.env.AI_WORKFLOW_GENERATION_MODE || "sequential";
const WORKFLOW_DOC_PATH = process.env.AI_WORKFLOW_DOC_PATH || new URL("../docs/workflow-source.md", import.meta.url);
const WORKFLOW_DOC_MAX_CHARS = Number(process.env.AI_WORKFLOW_DOC_MAX_CHARS || 12000);
const WORKFLOW_DOC_CACHE = process.env.AI_WORKFLOW_DOC_CACHE === "1";
const RUNTIME_BUILD = "2026-06-14-doc-grounded-desktop-v1";
const LOCAL_ENV_PATH = process.env.AI_WORKFLOW_ENV_PATH || new URL("../.env.local", import.meta.url);

function openAIKey() {
  return process.env.OPENAI_API_KEY || API_KEY;
}

function openAIBaseUrl() {
  return (process.env.OPENAI_BASE_URL || OPENAI_BASE_URL).replace(/\/+$/, "");
}

function openAIProviderLabel() {
  const baseUrl = openAIBaseUrl();
  return process.env.OPENAI_PROVIDER_LABEL || (baseUrl.includes("api.openai.com") ? "OpenAI official" : "Custom OpenAI-compatible API");
}

function imageOutputFormat() {
  return normalizeOutputFormat(process.env.OPENAI_IMAGE_OUTPUT_FORMAT || IMAGE_OUTPUT_FORMAT, "png");
}

function textLayerOutputFormat() {
  return normalizeOutputFormat(process.env.OPENAI_TEXT_LAYER_OUTPUT_FORMAT || TEXT_LAYER_OUTPUT_FORMAT, "png");
}

function useImageEdits() {
  if (activeBaseUrl().includes("api.openai.com")) return true;
  return process.env.OPENAI_IMAGE_USE_EDITS === undefined
    ? DEFAULT_IMAGE_USE_EDITS
    : process.env.OPENAI_IMAGE_USE_EDITS !== "0";
}

function imageEditField() {
  if (activeBaseUrl().includes("api.openai.com")) return "image[]";
  return process.env.OPENAI_IMAGE_EDIT_FIELD || IMAGE_EDIT_FIELD || "image";
}

function officialProvider() {
  return { baseUrl: openAIBaseUrl(), apiKey: openAIKey(), label: openAIProviderLabel(), tier: "official" };
}

function fallbackProvider() {
  return { baseUrl: FALLBACK_OPENAI_BASE_URL, apiKey: FALLBACK_OPENAI_API_KEY, label: FALLBACK_PROVIDER_LABEL, tier: "fallback" };
}

// --- Visitor quota store: a single JSON file guarded by a write queue. ---
// Shape: { "<token>": { used: <number> } }. In-memory cache + serialized writes
// via quotaWriteChain so concurrent image calls in one round cannot clobber each
// other (single process). Swapping for SQLite later only touches these helpers.
let quotaCache = null;
let quotaWriteChain = Promise.resolve();

function loadQuotaStore() {
  if (quotaCache) return quotaCache;
  try {
    quotaCache = JSON.parse(readFileSync(QUOTA_STORE_PATH, "utf8")) || {};
  } catch {
    quotaCache = {};
  }
  return quotaCache;
}

function quotaUsed(token) {
  if (!token) return 0;
  const store = loadQuotaStore();
  return store[token]?.used || 0;
}

function quotaRemaining(token) {
  return Math.max(0, QUOTA_CALLS - quotaUsed(token));
}

function persistQuotaStore() {
  const snapshot = JSON.stringify(quotaCache || {});
  quotaWriteChain = quotaWriteChain.then(async () => {
    const dir = dirname(fileURLToPath(QUOTA_STORE_PATH));
    await mkdir(dir, { recursive: true });
    const tmp = new URL(`${QUOTA_STORE_PATH.href}.tmp`);
    await writeFile(tmp, snapshot, "utf8");
    await rename(fileURLToPath(tmp), fileURLToPath(QUOTA_STORE_PATH));
  }).catch(() => {});
  return quotaWriteChain;
}

function incrementQuota(token) {
  if (!token) return;
  const store = loadQuotaStore();
  const entry = store[token] || { used: 0 };
  entry.used += 1;
  store[token] = entry;
  persistQuotaStore();
}

function anyImageProviderAvailable() {
  if (openAIKey()) return true;
  return QUOTA_ENABLED && Boolean(FALLBACK_OPENAI_API_KEY);
}

// Runs one logical image generation (fn may retry internally) under the right
// provider. Official is used while the visitor has quota; on official error or
// exhausted quota it transparently retries the same fn on the relay provider.
// Quota is charged once per successful official logical image. Passthrough when
// QUOTA_ENABLED is off so existing single-provider deployments are unchanged.
async function generateWithQuota(token, fn) {
  if (!QUOTA_ENABLED) return fn();

  const hasOfficial = Boolean(openAIKey());
  const hasFallback = Boolean(FALLBACK_OPENAI_API_KEY);
  const canUseOfficial = hasOfficial && Boolean(token) && quotaRemaining(token) > 0;

  if (canUseOfficial) {
    try {
      const result = await requestContext.run({ provider: officialProvider(), token }, fn);
      incrementQuota(token);
      return result;
    } catch (error) {
      if (!hasFallback) throw error;
      return requestContext.run({ provider: fallbackProvider(), token }, fn);
    }
  }

  if (hasFallback) return requestContext.run({ provider: fallbackProvider(), token }, fn);
  return requestContext.run({ provider: officialProvider(), token }, fn);
}

const stickerSpecs = {
  top: {
    zhName: "上贴背景",
    enName: "Top background",
    size: "1536x1024",
    width: 1536,
    height: 1024,
    instruction: "生成直播间顶部横向贴片。顶部和左右边缘可有装饰、材质和光效，底边必须自然过渡到中性纯白或近白背景。若存在聚焦感，视觉轻微向下汇聚，但不要形成明确主体或海报中心。"
  },
  side: {
    zhName: "侧贴背景",
    enName: "Side background",
    size: "1024x1536",
    width: 1024,
    height: 1536,
    instruction: "生成直播间侧边竖向窄幅贴片。装饰集中在左上角、上沿或外侧边缘，大部分区域保持素净、透气，不抢直播主体和商品。不要强纵深、不要中心主体、不要密集信息排版。严禁密铺、平铺、网格式重复、花纹重复、连续小图案、壁纸纹样或满版装饰；侧贴必须像一条留白充足的边缘贴片，而不是 pattern tile。"
  },
  bottom: {
    zhName: "下贴背景",
    enName: "Bottom background",
    size: "1536x1024",
    width: 1536,
    height: 1024,
    instruction: "生成直播间底部横向贴片。下沿可承载主要装饰、材质和光效，顶边必须自然过渡到中性纯白或近白背景。若存在聚焦感，视觉轻微向上汇聚，但不要形成明确主体或促销海报感。"
  }
};

const basePrompt = `根据当前唯一参考图生成直播间贴片背景底图。
只继承当前参考图的构图气质、色彩关系、材质、光效、边缘装饰密度和留白方式。
不要继承或生成文字、logo、二维码、价格标签、促销信息、人物、具体商品、海报排版、信息图结构。
将参考图中的主体转译为抽象背景语言，使画面适合叠加直播间内容。
整体干净、透气、浅色过渡自然，不抢直播主体。`;

const negativePrompt = `禁止生成：文字、logo、二维码、人物、具体商品、价格、优惠券、促销标签、按钮、信息图、海报模板、广告版式、月亮、天体、球体、强中心主体、强边框、深色压迫背景、过密装饰、脏灰底色。`;

let workflowDocCache = null;

async function readWorkflowDoc() {
  if (WORKFLOW_DOC_CACHE && workflowDocCache !== null) return workflowDocCache;
  try {
    workflowDocCache = await readFile(WORKFLOW_DOC_PATH, "utf8");
  } catch {
    workflowDocCache = "";
  }
  return workflowDocCache;
}

function workflowDocPromptBlock(workflowDoc) {
  const trimmed = String(workflowDoc || "").trim();
  if (!trimmed) return "";
  return [
    "Original workflow document, use as the highest-priority production brief:",
    trimmed.slice(0, WORKFLOW_DOC_MAX_CHARS),
    "Follow this document's visual goals, sequencing, constraints, and quality criteria unless the current user request explicitly overrides them."
  ].join("\n");
}

function sendJson(response, statusCode, data, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Visitor-Token",
    "Access-Control-Expose-Headers": "X-Visitor-Token",
    ...extraHeaders
  });
  response.end(JSON.stringify(data));
}

// Visitor token identifies a quota bucket. Read it from the request header; if
// absent (first visit) and quota is on, mint a new one. Returned to the client
// via response body + header so the frontend can persist it in localStorage.
function resolveVisitorToken(request) {
  const raw = String(request.headers["x-visitor-token"] || "").trim();
  if (/^[A-Za-z0-9_-]{8,64}$/.test(raw)) return raw;
  return QUOTA_ENABLED ? randomUUID() : "";
}

function workflowConfig() {
  return {
    ok: true,
    baseUrl: openAIBaseUrl(),
    provider: openAIProviderLabel(),
    hasOpenAIKey: Boolean(openAIKey()),
    outputFormat: imageOutputFormat(),
    textLayerOutputFormat: textLayerOutputFormat()
  };
}

function normalizeOutputFormat(value, fallback = "png") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["png", "jpeg", "webp"].includes(normalized) ? normalized : fallback;
}

async function saveWorkflowConfig(body = {}) {
  if (typeof body.apiKey === "string" && body.apiKey.trim()) process.env.OPENAI_API_KEY = body.apiKey.trim();
  if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
    process.env.OPENAI_BASE_URL = body.baseUrl.trim().replace(/\/+$/, "");
  }
  if (typeof body.provider === "string" && body.provider.trim()) process.env.OPENAI_PROVIDER_LABEL = body.provider.trim();
  if (typeof body.outputFormat === "string") process.env.OPENAI_IMAGE_OUTPUT_FORMAT = normalizeOutputFormat(body.outputFormat, IMAGE_OUTPUT_FORMAT);
  if (typeof body.textLayerOutputFormat === "string") process.env.OPENAI_TEXT_LAYER_OUTPUT_FORMAT = normalizeOutputFormat(body.textLayerOutputFormat, TEXT_LAYER_OUTPUT_FORMAT);

  const lines = [
    `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ""}`,
    `OPENAI_BASE_URL=${openAIBaseUrl()}`,
    `OPENAI_PROVIDER_LABEL=${openAIProviderLabel()}`,
    `OPENAI_IMAGE_MODEL=${IMAGE_MODEL}`,
    `OPENAI_IMAGE_QUALITY=${IMAGE_QUALITY}`,
    `OPENAI_IMAGE_OUTPUT_FORMAT=${process.env.OPENAI_IMAGE_OUTPUT_FORMAT || IMAGE_OUTPUT_FORMAT}`,
    `OPENAI_TEXT_LAYER_OUTPUT_FORMAT=${process.env.OPENAI_TEXT_LAYER_OUTPUT_FORMAT || TEXT_LAYER_OUTPUT_FORMAT}`,
    `OPENAI_IMAGE_USE_EDITS=${useImageEdits() ? "1" : "0"}`,
    `OPENAI_IMAGE_EDIT_FIELD=${imageEditField()}`,
    `OPENAI_IMAGE_EDIT_INCLUDE_EXTRAS=${IMAGE_EDIT_INCLUDE_EXTRAS ? "1" : "0"}`,
    `OPENAI_IMAGE_TIMEOUT_MS=${IMAGE_TIMEOUT_MS}`,
    `AI_WORKFLOW_GENERATION_MODE=${GENERATION_MODE}`,
    `OPENAI_TEXT_LAYER_USE_API=${TEXT_LAYER_USE_API ? "1" : "0"}`,
    `OPENAI_TEXT_LAYER_USE_FONT_REFERENCE=${TEXT_LAYER_USE_FONT_REFERENCE ? "1" : "0"}`,
    `OPENAI_TEXT_LAYER_USE_SOURCE_REFERENCE=${TEXT_LAYER_USE_SOURCE_REFERENCE ? "1" : "0"}`,
    `AI_WORKFLOW_DOC_PATH=${process.env.AI_WORKFLOW_DOC_PATH || "docs/workflow-source.md"}`,
    `AI_WORKFLOW_DOC_MAX_CHARS=${WORKFLOW_DOC_MAX_CHARS}`,
    `AI_WORKFLOW_DOC_CACHE=${WORKFLOW_DOC_CACHE ? "1" : "0"}`
  ];
  await writeFile(LOCAL_ENV_PATH, `${lines.join("\n")}\n`, "utf8");
  return workflowConfig();
}

function isLocalRequest(request) {
  const host = String(request.headers.host || "").split(":")[0];
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function buildStickerPrompt(kind, userPrompt, workflowDoc) {
  const spec = stickerSpecs[kind];
  const seriesStyleLock = [
    "Series consistency lock: top, side, and bottom must feel like one coordinated sticker set from the same reference image. Keep the same palette family, material language, lighting temperature, ornament vocabulary, line quality, and softness level across all three outputs.",
    "Role variation only: change placement and crop for top/side/bottom, but do not invent a different visual genre for one piece. The three pieces should look like siblings, not separate campaigns."
  ].join("\n");
  const fadeZone = kind === "top"
    ? "For the top sticker, only the lower 20-30% may fade toward white for compositing. The upper and side decoration areas must keep the reference image's strongest saturation, contrast, texture depth, and highlight intensity. Match the current reference image's dimensionality: if it is flat 2D, keep it flat and graphic; if it is 3D-rendered, keep the same 3D/rendered language."
    : kind === "bottom"
      ? "For the bottom sticker, only the upper 20-30% may fade toward white for compositing. The lower decoration area must keep the reference image's strongest saturation, contrast, texture depth, and highlight intensity."
      : "For the side sticker, only the inner edge may become airy and pale for compositing. The outer decorative edge must keep the reference image's strongest saturation, contrast, texture depth, and highlight intensity.";
  return [
    basePrompt,
    workflowDocPromptBlock(workflowDoc),
    "",
    spec.instruction,
    "",
    seriesStyleLock,
    "",
    "Color fidelity lock: do not wash out the whole image. Preserve the reference image's vivid accent colors, material richness, local dark-light contrast, and decorative density in the active ornament area.",
    "Dimensionality lock: match only the current reference image's dimensional style. Do not inherit 3D, bevel, plastic, metallic, volumetric, cinematic, or flat poster traits from any previous generation. If the current reference is flat, stay flat; if the current reference is 3D-rendered, keep a coherent 3D-rendered style across all three stickers.",
    "Fade control: the pale/white transition is only a compositing edge treatment, not a global color grade. Avoid pastelizing, desaturating, flattening, or turning the entire sticker into a single pale color.",
    fadeZone,
    "",
    userPrompt ? `本轮用户补充要求：${userPrompt}` : "",
    "",
    "输出要求：只输出可叠加的背景素材，风格统一但构图不要三张完全重复。禁止把参考图做成平铺纹样或重复贴图。",
    negativePrompt
  ].filter(Boolean).join("\n");
}

function extensionForMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function isSupportedReferenceMime(mime) {
  return ["image/png", "image/jpeg", "image/webp"].includes(String(mime || "").toLowerCase());
}

function isSupportedReferenceDataUrl(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:")) return false;
  const match = dataUrl.match(/^data:([^;,]+);base64,/);
  return Boolean(match && isSupportedReferenceMime(match[1]));
}

function dataUrlToUploadFile(dataUrl, index) {
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1] || "image/png";
  if (!isSupportedReferenceMime(mime)) return null;
  const buffer = Buffer.from(match[2], "base64");
  const filename = `reference-${index + 1}.${extensionForMime(mime)}`;
  if (typeof File !== "undefined") {
    return new File([buffer], filename, { type: mime });
  }
  const blob = new Blob([buffer], { type: mime });
  blob.name = filename;
  return blob;
}

async function requestOpenAIImage({ prompt, size, referenceImage, referenceImages, editSize, outputFormat = imageOutputFormat() }) {
  const provider = activeProvider();
  const baseUrl = provider.baseUrl;
  const headers = { Authorization: `Bearer ${provider.apiKey}` };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  const inputImages = Array.isArray(referenceImages) && referenceImages.length
    ? referenceImages
    : (referenceImage ? [referenceImage] : []);

  try {
    if (useImageEdits() && inputImages.length) {
      const imageFiles = inputImages.map((image, index) => dataUrlToUploadFile(image, index)).filter(Boolean);
      if (imageFiles.length) {
        const body = new FormData();
        body.append("model", IMAGE_MODEL);
        body.append("prompt", prompt);
        body.append("size", editSize || IMAGE_EDIT_SIZE || size);
        body.append("output_format", outputFormat);
        if (IMAGE_EDIT_INCLUDE_EXTRAS) {
          body.append("quality", IMAGE_QUALITY);
        }
        imageFiles.forEach((imageFile, index) => {
          body.append(imageEditField(), imageFile, imageFile.name || `reference-${index + 1}.png`);
        });
        const response = await fetch(`${baseUrl}/images/edits`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal
        });
        return parseOpenAIImageResponse(response);
      }
    }

    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        size,
        quality: IMAGE_QUALITY,
        output_format: outputFormat
      }),
      signal: controller.signal
    });
    return parseOpenAIImageResponse(response);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Image request timed out after ${Math.round(IMAGE_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseOpenAIImageResponse(response) {
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { message: text } };
  }
  if (!response.ok) {
    const requestId = response.headers.get("x-request-id");
    const message = data?.error?.message || `OpenAI request failed with ${response.status}`;
    throw new Error(requestId ? `${message} (request ${requestId})` : message);
  }
  const imageBase64 = data?.data?.[0]?.b64_json;
  const imageUrl = data?.data?.[0]?.url;
  if (imageUrl) return imageUrl;
  if (!imageBase64) throw new Error("OpenAI did not return image data.");
  const mime = sniffImageMime(Buffer.from(imageBase64.slice(0, 24), "base64")) || "image/png";
  return `data:${mime};base64,${imageBase64}`;
}

async function imageUrlToDataUrl(imageUrl) {
  if (!imageUrl || imageUrl.startsWith("data:")) return imageUrl;
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Generated image URL could not be read: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const headerType = (response.headers.get("content-type") || "").split(";")[0].trim();
  const contentType = sniffImageMime(buffer) || headerType || "image/png";
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function sniffImageMime(buffer) {
  if (buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function parsedImageBuffer(dataUrl) {
  const parsed = dataUrlToBuffer(dataUrl);
  if (!parsed) return null;
  return {
    ...parsed,
    mime: sniffImageMime(parsed.buffer) || parsed.mime
  };
}

function analyzePngSticker(dataUrl) {
  const parsed = parsedImageBuffer(dataUrl);
  if (!parsed || parsed.mime !== "image/png") return null;
  const { width, height, rgba } = decodePngToRgba(parsed.buffer);
  const total = width * height;
  let visible = 0;
  let meaningful = 0;
  let channelSpreadTotal = 0;

  for (let pixel = 0; pixel < total; pixel += 1) {
    const index = pixel * 4;
    const alpha = rgba[index + 3];
    if (alpha <= 12) continue;
    visible += 1;
    const red = rgba[index];
    const green = rgba[index + 1];
    const blue = rgba[index + 2];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    channelSpreadTotal += max - min;
    if (min < 238 || max - min > 18) meaningful += 1;
  }

  const meaningfulRatio = visible ? meaningful / visible : 0;
  const averageSpread = visible ? channelSpreadTotal / visible : 0;
  return {
    width,
    height,
    mime: parsed.mime,
    visibleRatio: total ? visible / total : 0,
    meaningfulRatio,
    averageSpread
  };
}

function assertStickerImageNotBlank(dataUrl, kind) {
  const stats = analyzePngSticker(dataUrl);
  if (!stats) return;
  if (stats.visibleRatio < 0.08 || (stats.meaningfulRatio < 0.006 && stats.averageSpread < 2.2)) {
    throw new Error([
      `${stickerSpecs[kind]?.zhName || kind} returned a near-blank white image from the image gateway`,
      `size=${stats.width}x${stats.height}`,
      `meaningful=${stats.meaningfulRatio.toFixed(4)}`,
      `spread=${stats.averageSpread.toFixed(2)}`
    ].join(" "));
  }
}

function resizeCoverRgba(source, targetWidth, targetHeight) {
  const { width: sourceWidth, height: sourceHeight, rgba: sourceRgba } = source;
  const targetRgba = Buffer.alloc(targetWidth * targetHeight * 4);
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const scaledWidth = sourceWidth * scale;
  const scaledHeight = sourceHeight * scale;
  const offsetX = (scaledWidth - targetWidth) / 2;
  const offsetY = (scaledHeight - targetHeight) / 2;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.max(0, Math.round((y + offsetY) / scale)));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.max(0, Math.round((x + offsetX) / scale)));
      const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
      const targetIndex = (y * targetWidth + x) * 4;
      targetRgba[targetIndex] = sourceRgba[sourceIndex];
      targetRgba[targetIndex + 1] = sourceRgba[sourceIndex + 1];
      targetRgba[targetIndex + 2] = sourceRgba[sourceIndex + 2];
      targetRgba[targetIndex + 3] = sourceRgba[sourceIndex + 3];
    }
  }

  return {
    width: targetWidth,
    height: targetHeight,
    rgba: targetRgba
  };
}

function normalizeStickerImageSize(dataUrl, kind) {
  const parsed = parsedImageBuffer(dataUrl);
  const spec = stickerSpecs[kind];
  if (!parsed || parsed.mime !== "image/png" || !spec) return dataUrl;

  const png = decodePngToRgba(parsed.buffer);
  if (png.width === spec.width && png.height === spec.height) return dataUrl;

  const normalized = resizeCoverRgba(png, spec.width, spec.height);
  return `data:image/png;base64,${encodeRgbaToPng(normalized).toString("base64")}`;
}

async function requestCheckedStickerImage(kind, prompt, referenceImage, editSize, referenceImages) {
  const image = await requestOpenAIImage({
    prompt,
    size: stickerSpecs[kind].size,
    referenceImage,
    referenceImages,
    editSize,
    outputFormat: imageOutputFormat()
  });
  const dataUrl = await imageUrlToDataUrl(image);
  assertStickerImageNotBlank(dataUrl, kind);
  return normalizeStickerImageSize(dataUrl, kind);
}

async function requestStickerImage(kind, prompt, referenceImage, options = {}) {
  const failedAttempts = [];
  const preferredReferenceImages = Array.isArray(options.referenceImages)
    ? options.referenceImages.filter(Boolean)
    : [];
  const tryAttempt = async (label, options = {}) => {
    try {
      return await requestCheckedStickerImage(
        kind,
        options.prompt || prompt,
        options.referenceImage ?? referenceImage,
        options.editSize,
        options.referenceImages
      );
    } catch (error) {
      failedAttempts.push(`${label}: ${error.message || "failed"}`);
      return "";
    }
  };

  const directResult = await tryAttempt(
    preferredReferenceImages.length > 1 ? "reference edit with series source" : "reference edit",
    preferredReferenceImages.length ? { referenceImages: preferredReferenceImages } : {}
  );
  if (directResult) return { image: directResult, warning: "" };

  if (preferredReferenceImages.length > 1) {
    const originalOnlyResult = await tryAttempt("reference edit original only");
    if (originalOnlyResult) {
      return {
        image: originalOnlyResult,
        warning: `${stickerSpecs[kind].zhName} 的双参考图生图失败，已只用原始参考图重试；套系一致性可能降低。`
      };
    }
  }

  const requestedEditSize = IMAGE_EDIT_SIZE || stickerSpecs[kind].size;
  if (useImageEdits() && referenceImage && IMAGE_EDIT_FALLBACK_SIZE && requestedEditSize !== IMAGE_EDIT_FALLBACK_SIZE) {
    const squareResult = await tryAttempt(`reference edit ${IMAGE_EDIT_FALLBACK_SIZE}`, {
      editSize: IMAGE_EDIT_FALLBACK_SIZE,
      referenceImages: preferredReferenceImages.length ? preferredReferenceImages : undefined
    });
    if (squareResult) {
      return {
        image: squareResult,
        warning: `${stickerSpecs[kind].zhName} 的原比例图生图失败，已用 ${IMAGE_EDIT_FALLBACK_SIZE} 兼容尺寸生成并裁成贴片比例。`
      };
    }
  }

  if (useImageEdits() && referenceImage) {
    throw new Error(failedAttempts.join(" / ") || "Reference image edit failed");
  }

  const generationPrompt = [
    prompt,
    "",
    "The image edit gateway returned blank or unusable output for the reference image. Generate a fresh non-blank sticker background from the written style instructions. The result must contain visible decorative texture, color, and composition; never return a blank or nearly white canvas."
  ].join("\n");
  const generatedResult = await tryAttempt("text-only generation retry", {
    referenceImage: "",
    prompt: generationPrompt
  });
  if (generatedResult) {
    return {
      image: generatedResult,
      warning: `${stickerSpecs[kind].zhName} 的图生图不可用，已改用文字描述生成；参考图相似度会降低。`
    };
  }

  throw new Error(failedAttempts.join(" / ") || "Image generation failed");
}

function fallbackSticker(kind, userPrompt) {
  const spec = stickerSpecs[kind];
  const accent = kind === "top" ? "#243f32" : kind === "side" ? "#6d7568" : "#40573e";
  const label = spec.zhName;
  const focusY = kind === "bottom" ? spec.height * 0.82 : spec.height * 0.18;
  const fadeStart = kind === "bottom" ? 0 : spec.height * 0.58;
  const fadeEnd = kind === "bottom" ? spec.height * 0.42 : spec.height;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}">
  <defs>
    <linearGradient id="fade" x1="0" y1="${kind === "bottom" ? 0 : 1}" x2="0" y2="${kind === "bottom" ? 1 : 0}">
      <stop offset="0" stop-color="#fbfaf4"/>
      <stop offset="0.55" stop-color="#f1efe4"/>
      <stop offset="1" stop-color="${accent}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="${kind === "bottom" ? "85%" : "15%"}" r="70%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.42"/>
      <stop offset="0.58" stop-color="${accent}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="22"/></filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#fade)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <g opacity="0.42" filter="url(#blur)">
    <path d="M 0 ${focusY} C ${spec.width * 0.24} ${focusY - 90}, ${spec.width * 0.5} ${focusY + 90}, ${spec.width} ${focusY - 20}" fill="none" stroke="${accent}" stroke-width="86"/>
    <path d="M ${spec.width * 0.12} ${kind === "bottom" ? spec.height : 0} C ${spec.width * 0.3} ${focusY}, ${spec.width * 0.74} ${focusY}, ${spec.width * 0.92} ${kind === "bottom" ? spec.height : 0}" fill="none" stroke="#d7dcc7" stroke-width="54"/>
  </g>
  <rect x="0" y="${fadeStart}" width="${spec.width}" height="${Math.abs(fadeEnd - fadeStart)}" fill="#fbfaf4" opacity="0.48"/>
  <text x="42" y="72" fill="#1d2720" font-size="28" font-family="Arial, sans-serif" opacity="0.72">${label} / local draft</text>
  <text x="42" y="116" fill="#1d2720" font-size="18" font-family="Arial, sans-serif" opacity="0.52">${escapeSvg(userPrompt || "等待 OPENAI_API_KEY 后生成真实贴片背景").slice(0, 96)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeSvg(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeTextLayerSvg({ copyText, styleKey, background = "transparent" }) {
  const text = String(copyText || "").replace(/^例如：\n?|^Example:\n?/i, "").replace(/[“”"]/g, "").trim() || "NOBOOK · 618 狂欢季\n重走真理诞生路";
  const lines = text.split(/\n+/).slice(0, 4);
  const expressive = styleKey === "expressive";
  const fill = expressive ? "#f7f3e8" : "#ffffff";
  const stroke = expressive ? "#222719" : "#121212";
  const fontFamily = expressive
    ? "'Kaiti SC', 'STKaiti', 'Songti SC', 'Noto Serif SC', serif"
    : "'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', serif";
  const titleSize = expressive ? 70 : 62;
  const bodySize = expressive ? 44 : 42;
  const lineNodes = lines.map((line, index) => {
    const size = index === 0 ? titleSize : bodySize;
    const y = 126 + index * 62;
    return `<text x="540" y="${y}" text-anchor="middle" font-size="${size}" font-weight="${index === 0 ? 800 : 560}" fill="${fill}" stroke="${stroke}" stroke-width="${expressive ? 2.8 : 1.4}" paint-order="stroke">${escapeSvg(line)}</text>`;
  }).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="320" viewBox="0 0 1080 320">
  <rect width="1080" height="320" fill="${background}"/>
  <g font-family="${fontFamily}" letter-spacing="0">
    ${lineNodes}
  </g>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mime: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function makeCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
}

const crcTable = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

function decodePngToRgba(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Only PNG image data can be locally cut out.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = readUInt32(buffer, offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
    }
    if (type === "IDAT") idatChunks.push(data);
    if (type === "IEND") break;
    offset += length + 12;
  }

  if (bitDepth !== 8 || ![0, 2, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const bytesPerPixel = channels;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const unfiltered = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const source = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const targetStart = y * stride;
    const previousStart = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? unfiltered[targetStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? unfiltered[previousStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? unfiltered[previousStart + x - bytesPerPixel] : 0;
      let value = source[x];
      if (filter === 1) value = (value + left) & 0xff;
      if (filter === 2) value = (value + up) & 0xff;
      if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 0xff;
      if (filter === 4) value = (value + paethPredictor(left, up, upLeft)) & 0xff;
      unfiltered[targetStart + x] = value;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const sourceIndex = index * channels;
    const targetIndex = index * 4;
    if (colorType === 6) {
      rgba[targetIndex] = unfiltered[sourceIndex];
      rgba[targetIndex + 1] = unfiltered[sourceIndex + 1];
      rgba[targetIndex + 2] = unfiltered[sourceIndex + 2];
      rgba[targetIndex + 3] = unfiltered[sourceIndex + 3];
    } else if (colorType === 2) {
      rgba[targetIndex] = unfiltered[sourceIndex];
      rgba[targetIndex + 1] = unfiltered[sourceIndex + 1];
      rgba[targetIndex + 2] = unfiltered[sourceIndex + 2];
      rgba[targetIndex + 3] = 255;
    } else {
      const gray = unfiltered[sourceIndex];
      rgba[targetIndex] = gray;
      rgba[targetIndex + 1] = gray;
      rgba[targetIndex + 2] = gray;
      rgba[targetIndex + 3] = 255;
    }
  }

  return { width, height, rgba };
}

function encodeRgbaToPng({ width, height, rgba }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", deflateSync(raw)),
    makePngChunk("IEND")
  ]);
}

function isNearWhitePixel(rgba, index, threshold = 236) {
  const red = rgba[index];
  const green = rgba[index + 1];
  const blue = rgba[index + 2];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  return min >= threshold && max - min <= 24;
}

function removeConnectedWhiteBackground(dataUrl) {
  const parsed = dataUrlToBuffer(dataUrl);
  if (!parsed || parsed.mime !== "image/png") {
    throw new Error("Local white-background cutout needs a PNG data URL.");
  }

  const png = decodePngToRgba(parsed.buffer);
  const { width, height, rgba } = png;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = [];

  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (visited[pixel]) return;
    const index = pixel * 4;
    if (!isNearWhitePixel(rgba, index)) return;
    visited[pixel] = 1;
    queue.push(pixel);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pixel = queue[cursor];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (!visited[pixel]) continue;
    const index = pixel * 4;
    const minChannel = Math.min(rgba[index], rgba[index + 1], rgba[index + 2]);
    const alpha = Math.max(0, Math.min(255, Math.round((248 - minChannel) * 14)));
    rgba[index + 3] = alpha;
    if (alpha === 0) {
      rgba[index] = 255;
      rgba[index + 1] = 255;
      rgba[index + 2] = 255;
    }
  }

  return `data:image/png;base64,${encodeRgbaToPng(png).toString("base64")}`;
}

async function handleStickerBackgrounds(body, token = "") {
  const kinds = ["top", "side", "bottom"];
  const workflowDoc = await readWorkflowDoc();
  const prompts = Object.fromEntries(kinds.map((kind) => [
    kind,
    buildStickerPrompt(kind, body.promptText || "", workflowDoc)
  ]));
  const singleKind = kinds.includes(body.kind) ? body.kind : "";

  if (!anyImageProviderAvailable()) {
    const fallbackKinds = singleKind ? [singleKind] : kinds;
    return {
      ok: true,
      openAIRequestOk: false,
      generated: false,
      model: IMAGE_MODEL,
      quality: IMAGE_QUALITY,
      baseUrl: openAIBaseUrl(),
      useImageEdits: useImageEdits(),
      timeoutMs: IMAGE_TIMEOUT_MS,
      imageEditField: imageEditField(),
      imageEditSize: IMAGE_EDIT_SIZE || "per-sticker-size",
      imageEditFallbackSize: IMAGE_EDIT_FALLBACK_SIZE || "off",
      imageEditIncludeExtras: IMAGE_EDIT_INCLUDE_EXTRAS,
      generationMode: GENERATION_MODE,
      runtimeBuild: RUNTIME_BUILD,
      assets: Object.fromEntries(fallbackKinds.map((kind) => [kind, fallbackSticker(kind, body.promptText)])),
      prompts,
      errors: {},
      message: "未检测到 OPENAI_API_KEY，已返回本地 SVG 草稿和完整 prompt。"
    };
  }

  const results = {};
  const errors = {};
  const warnings = {};
  const referenceImagesForKind = (kind) => {
    const seriesReferenceImage = body.seriesReferenceImage || "";
    return kind === "top" || !isSupportedReferenceDataUrl(seriesReferenceImage)
      ? [body.referenceImage].filter(Boolean)
      : [body.referenceImage, seriesReferenceImage].filter(Boolean);
  };

  if (singleKind) {
    try {
      const result = await generateWithQuota(token, () => requestStickerImage(singleKind, prompts[singleKind], body.referenceImage, {
        referenceImages: referenceImagesForKind(singleKind)
      }));
      results[singleKind] = result.image;
      if (result.warning) warnings[singleKind] = result.warning;
    } catch (error) {
      errors[singleKind] = error.message || "Image generation failed";
      results[singleKind] = fallbackSticker(singleKind, body.promptText);
    }
  } else if (GENERATION_MODE === "parallel") {
    const settled = await Promise.allSettled(kinds.map(async (kind) => [
      kind,
      await generateWithQuota(token, () => requestStickerImage(kind, prompts[kind], body.referenceImage, {
        referenceImages: referenceImagesForKind(kind)
      }))
    ]));

    settled.forEach((result, index) => {
      const kind = kinds[index];
      if (result.status === "fulfilled") {
        results[result.value[0]] = result.value[1].image;
        if (result.value[1].warning) warnings[result.value[0]] = result.value[1].warning;
      } else {
        errors[kind] = result.reason?.message || "Image generation failed";
        results[kind] = fallbackSticker(kind, body.promptText);
      }
    });
  } else {
    for (const kind of kinds) {
      try {
        const result = await generateWithQuota(token, () => requestStickerImage(kind, prompts[kind], body.referenceImage, {
          referenceImages: referenceImagesForKind(kind)
        }));
        results[kind] = result.image;
        if (result.warning) warnings[kind] = result.warning;
      } catch (error) {
        errors[kind] = error.message || "Image generation failed";
        results[kind] = fallbackSticker(kind, body.promptText);
      }
    }
  }

  return {
    ok: true,
    openAIRequestOk: Object.keys(errors).length === 0,
    generated: anyImageProviderAvailable() && Object.keys(errors).length === 0,
    model: IMAGE_MODEL,
    quality: IMAGE_QUALITY,
    baseUrl: openAIBaseUrl(),
    useImageEdits: useImageEdits(),
    timeoutMs: IMAGE_TIMEOUT_MS,
    imageEditField: imageEditField(),
    imageEditSize: IMAGE_EDIT_SIZE || "per-sticker-size",
    imageEditFallbackSize: IMAGE_EDIT_FALLBACK_SIZE || "off",
    imageEditIncludeExtras: IMAGE_EDIT_INCLUDE_EXTRAS,
    generationMode: GENERATION_MODE,
    runtimeBuild: RUNTIME_BUILD,
    assets: results,
    prompts,
    errors,
    warnings,
    quota: QUOTA_ENABLED ? { enabled: true, limit: QUOTA_CALLS, remaining: quotaRemaining(token) } : undefined,
    message: anyImageProviderAvailable()
      ? (Object.keys(errors).length
        ? "OpenAI 生图失败，已回退成本地草稿。"
        : (Object.keys(warnings).length ? "贴片背景已生成，但部分图片使用了兼容重试路径。" : "贴片背景已生成。"))
      : "未检测到 OPENAI_API_KEY，已返回本地 SVG 草稿和完整 prompt。"
  };
}

async function handleTextLayer(body, token = "") {
  const styleKey = body.styleKey === "expressive" ? "expressive" : "clean";
  const fontPresetKeys = new Set(["elegant-songti", "expressive-calligraphy", "rounded-cute"]);
  const fontPresetKey = fontPresetKeys.has(body.fontPresetKey) ? body.fontPresetKey : "";
  const fontReferenceSource = body.fontReferenceSource === "preset" ? "preset" : "upload";
  const copyText = String(body.copyText || "").replace(/^例如：\n?|^Example:\n?/i, "").replace(/[“”"]/g, "").trim() || "NOBOOK · 618 狂欢季\n重走真理诞生路";
  const topStickerImage = body.topStickerImage || body.referenceImage || "";
  const fontReferenceImage = TEXT_LAYER_USE_FONT_REFERENCE ? (body.fontReferenceImage || "") : "";
  const sourceTypographyReferenceImage = TEXT_LAYER_USE_SOURCE_REFERENCE ? (body.sourceTypographyReferenceImage || "") : "";
  const referenceImages = [topStickerImage, fontReferenceImage, sourceTypographyReferenceImage].filter(Boolean);
  const prompt = [
    "Generate a standalone livestream typography asset on a strict pure white #ffffff background.",
    "The final image must be a clean white-background typography design draft, not a transparent image.",
    "Do not composite onto any reference image or recreate any reference background.",
    topStickerImage
      ? "Reference image 1 is the generated top sticker. It is the primary visual source for material feeling, brightness contrast, and small decorative accents around or attached to letters. Do not blindly copy its main palette into the main letter fill."
      : "",
    fontReferenceImage
      ? (fontReferenceSource === "preset"
        ? "Reference image 2 is the selected built-in font preset. Use it strongly for letterform family, stroke rhythm, weight distribution, terminal shape, title hierarchy, and local face texture. Do not copy its background, scene, color palette, large decorations, logos, non-target text, products, labels, characters, or composition."
        : "Reference image 2 is an optional font reference. Use it only for letterform, stroke rhythm, font structure, calligraphic energy, layout rhythm, and local face texture. Do not copy its background, scene, color palette, large decorations, logos, non-target text, products, labels, characters, or composition.")
      : "No optional font reference is provided; rely on the chosen typography route and the top sticker reference.",
    sourceTypographyReferenceImage
      ? "An additional source reference is the user's original step-1 reference image. If it contains lettering, extract only broad typography cues such as stroke thickness, terminal shape, weight rhythm, spacing, and title hierarchy. Never copy its actual words, slogans, logo marks, background, scene, palette, decorations, products, people, labels, or composition."
      : "",
    body.useReferenceTextStyle
      ? "The user asked to consider text-style cues from the original step-1 reference, but no extra source image is attached for stability. Infer only generic typography qualities that are already visible in the new top sticker and the selected typography route; do not introduce any old palette or scene residue."
      : "",
    "The top sticker reference always wins for material direction and small surrounding decorative elements.",
    "Palette isolation: the original uploaded source image and any typography reference must never affect lettering color. They may not introduce old colors, previous palettes, background tones, product colors, or scene lighting into the new text layer.",
    "Poster-style tonal blending (融字): the lettering must feel painted into the same world as the top sticker, not pasted on as a flat neutral. First read the dominant hue and the light/dark level of the usable top-sticker background/ornament area, ignoring the pure white fade zones.",
    "Same-hue derivation: pull the main lettering fill from that dominant hue family, then shift it strongly along the SAME hue until it reads clearly against the background. If the top sticker is light/pale, deepen and slightly desaturate the hue into a rich dark tone of that same family (e.g. burgundy/red background -> deep wine, oxblood, ink-red lettering; sage/forest green -> deep pine or ink-green; dusty blue -> deep navy-ink). If the top sticker is dark/saturated/heavy, lift the hue into a warm light tone of the same family (e.g. deep green -> warm ivory with a faint green cast; oxblood -> warm pearl with a faint rose cast).",
    "Hard ban on flat neutrals: never use pure black #000000 or pure white #ffffff as the main lettering fill, and avoid dead grey. The fill must always carry a trace of the background hue so the type harmonizes with the scene.",
    "Readability guarantee comes first: keep shifting the derived hue deeper (on light backgrounds) or lighter (on dark backgrounds) until the lettering is unmistakably legible. The text must never be swallowed by the background. If a hue cannot reach enough contrast while staying tasteful, push it to a near-extreme dark or light tone of that hue (still not pure black/white).",
    "This color decision controls only fill color and small decorative elements, not the letterform route, font structure, copy, layout hierarchy, or stroke style.",
    "Use Reference image 1/top sticker accent colors for outlines, shadows, edge glints, sparkles, and small attached ornaments so the type and background share materials. Do not let a low-contrast accent become the dominant main fill.",
    "Color lock: derive the main fill from the same-hue tonal rule above; derive outline, shadow, highlights, edge effects, and small accent strokes from Reference image 1/top sticker only when they help readability and local harmony. Never borrow the color palette from a font reference or typography preset.",
    "Letterform lock: the selected typography route controls silhouette, stroke structure, serif/brush/rounded character, and spacing. The top sticker reference must not collapse different typography routes into the same font style.",
    "The optional font reference never decides the background, global color, large ornaments, or non-text visual content.",
    "Do not recreate large color blocks, ribbons, watercolor backgrounds, geometric networks, poster scenes, people, products, logos, QR codes, labels, captions, slogans, signatures, or watermarks.",
    "Before rendering, explicitly apply the tonal decision: light top sticker -> deep same-hue typography; dark top sticker -> light same-hue typography; never flat black or white. Keep the decorative color details secondary.",
    "必须逐字保留以下原文案，不增删、不翻译、不改写，保留换行结构：",
    copyText,
    styleKey === "expressive"
      ? "Typography route: calligraphy tension style. Use bold brush-script structure, visible stroke direction, energetic thick-thin rhythm, hand-drawn pressure changes, and controlled dry-brush texture only when it helps. It must look clearly different from Songti serif and rounded cute lettering."
      : "Typography route: elegant Songti serif style. Use Chinese Songti / Ming-style serif letterforms with clear horizontal-thin vertical-thick contrast, sharp triangular terminals, refined printed-title rhythm, graceful but stable strokes, and high readability. Do not turn this route into Heiti, sans-serif, rounded poster lettering, inflated sticker lettering, or calligraphic brush script.",
    fontPresetKey === "elegant-songti"
      ? "Built-in preset lock: elegant Songti. Follow the preset's tall refined Ming/Songti serif silhouette, sharp wedge terminals, slim-to-thick contrast, restrained upper brand line, and graceful horizontal flourish energy. Keep it clearly different from expressive brush calligraphy and rounded cute poster lettering. This preset controls letter shape only; do not copy the preset's blue color unless blue already appears in Reference image 1."
      : "",
    fontPresetKey === "expressive-calligraphy"
      ? "Built-in preset lock: expressive calligraphy. Follow the preset's sweeping brush-script silhouette, connected running strokes, bold pressure variation, dry-brush texture, long gestural tails, and dynamic slanted rhythm. Keep it clearly different from Songti serif and rounded cute lettering. This preset controls letter shape only; do not copy the preset's green color unless green already appears in Reference image 1."
      : "",
    fontPresetKey === "rounded-cute"
      ? "Typography preset: rounded cute sticker lettering. Use bubbly, thick, soft-cornered, playful, high-readability title shapes, friendly inflated strokes, round terminals, and compact launch-poster hierarchy. It must look clearly different from Songti serif and brush calligraphy. This preset controls letter shape only; do not use the preset sample's orange, navy, cyan, or red palette unless those colors already appear in Reference image 1."
      : "",
    "If the lettering is light on the white draft, add a darker outline or shadow so the white-background cutout will not erase highlights.",
    "Keep the brand line smaller and clean. Make the main title dominant. The middle dot `·` must stay accurate.",
    "Complex Chinese characters, especially `诞` and `路`, must stay structurally correct and readable.",
    body.promptText ? `用户补充要求：${body.promptText}` : ""
  ].filter(Boolean).join("\n");

  const fallbackTransparent = makeTextLayerSvg({ copyText, styleKey });
  const fallbackWhiteDraft = makeTextLayerSvg({ copyText, styleKey, background: "#ffffff" });

  if ((!anyImageProviderAvailable()) || !TEXT_LAYER_USE_API) {
    return {
      ok: true,
      generated: false,
      openAIRequestOk: false,
      assets: {
        whiteDraft: fallbackWhiteDraft,
        transparent: fallbackTransparent
      },
      styleKey,
      fontPresetKey,
      prompt,
      model: IMAGE_MODEL,
      size: TEXT_LAYER_SIZE,
      message: !anyImageProviderAvailable()
        ? "未检测到 OPENAI_API_KEY，已返回本地 SVG 文字图层草稿。"
        : "文字图层 API 已关闭，已返回本地 SVG 文字图层草稿。"
    };
  }

  try {
    const draftResult = { referenceFallback: "" };
    const whiteDraft = await generateWithQuota(token, async () => {
      try {
        return await requestOpenAIImage({
          prompt,
          size: TEXT_LAYER_SIZE,
          referenceImages,
          outputFormat: textLayerOutputFormat()
        });
      } catch (error) {
        if (referenceImages.length < 2 || !topStickerImage) throw error;
        draftResult.referenceFallback = error.message || "Multi-reference image edit failed";
        return requestOpenAIImage({
          prompt: [
            prompt,
            "",
            "The optional typography reference images could not be sent by the image gateway in this retry. Ignore them and rely on the top sticker plus the selected typography route."
          ].join("\n"),
          size: TEXT_LAYER_SIZE,
          referenceImage: topStickerImage,
          outputFormat: textLayerOutputFormat()
        });
      }
    });
    const referenceFallback = draftResult.referenceFallback;
    let transparent = fallbackTransparent;
    let cutoutOk = false;
    let cutoutError = "";
    try {
      transparent = removeConnectedWhiteBackground(whiteDraft);
      cutoutOk = true;
    } catch (error) {
      cutoutError = error.message || "Local cutout failed";
    }

    return {
      ok: true,
      generated: true,
      openAIRequestOk: true,
      cutoutOk,
      assets: {
        whiteDraft,
        transparent
      },
      styleKey,
      fontPresetKey,
      prompt,
      model: IMAGE_MODEL,
      size: TEXT_LAYER_SIZE,
      referenceFallback,
      quota: QUOTA_ENABLED ? { enabled: true, limit: QUOTA_CALLS, remaining: quotaRemaining(token) } : undefined,
      error: cutoutError || referenceFallback,
      message: cutoutOk
        ? (referenceFallback
          ? "白底字体稿已生成，并已本地扣白底为透明 PNG。可选文字参考图未被网关接受，本次已退回只以上贴图为参考；请检查文字是否完全正确。"
          : "白底字体稿已生成，并已本地扣白底为透明 PNG。请检查文字是否完全正确。")
        : `白底字体稿已生成，但本地扣白底失败，已回退 SVG 透明稿：${cutoutError}`
    };
  } catch (error) {
    return {
      ok: true,
      generated: false,
      openAIRequestOk: false,
      assets: {
        whiteDraft: fallbackWhiteDraft,
        transparent: fallbackTransparent
      },
      styleKey,
      fontPresetKey,
      prompt,
      model: IMAGE_MODEL,
      size: TEXT_LAYER_SIZE,
      error: error.message || "Text layer generation failed",
      message: `文字图层 API 生成失败，已回退本地 SVG 草稿：${error.message || "unknown error"}`
    };
  }

}

async function workflowStatus(token = "") {
  const workflowDoc = await readWorkflowDoc();
  return {
    ok: true,
    hasOpenAIKey: Boolean(openAIKey()) || (QUOTA_ENABLED && Boolean(FALLBACK_OPENAI_API_KEY)),
    provider: openAIProviderLabel(),
    quota: QUOTA_ENABLED
      ? { enabled: true, limit: QUOTA_CALLS, used: quotaUsed(token), remaining: quotaRemaining(token), callsPerRound: 4 }
      : { enabled: false },
    model: IMAGE_MODEL,
    quality: IMAGE_QUALITY,
    outputFormat: imageOutputFormat(),
    baseUrl: openAIBaseUrl(),
    useImageEdits: useImageEdits(),
    timeoutMs: IMAGE_TIMEOUT_MS,
    imageEditField: imageEditField(),
    imageEditSize: IMAGE_EDIT_SIZE || "per-sticker-size",
    imageEditFallbackSize: IMAGE_EDIT_FALLBACK_SIZE || "off",
    imageEditIncludeExtras: IMAGE_EDIT_INCLUDE_EXTRAS,
    textLayerSize: TEXT_LAYER_SIZE,
    textLayerOutputFormat: textLayerOutputFormat(),
    textLayerUseApi: TEXT_LAYER_USE_API,
    textLayerUseFontReference: TEXT_LAYER_USE_FONT_REFERENCE,
    textLayerUseSourceReference: TEXT_LAYER_USE_SOURCE_REFERENCE,
    generationMode: GENERATION_MODE,
    runtimeBuild: RUNTIME_BUILD,
    workflowDocPath: String(WORKFLOW_DOC_PATH),
    workflowDocMaxChars: WORKFLOW_DOC_MAX_CHARS,
    workflowDocCache: WORKFLOW_DOC_CACHE,
    workflowDocLoaded: Boolean(workflowDoc),
    workflowDocChars: workflowDoc.length
  };
}

async function route(request, response) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const visitorToken = resolveVisitorToken(request);
  const tokenHeader = visitorToken ? { "X-Visitor-Token": visitorToken } : {};
  if (request.method === "GET" && url.pathname === "/api/ai-workflow/status") {
    sendJson(response, 200, await workflowStatus(visitorToken), tokenHeader);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/ai-workflow/config") {
    sendJson(response, 200, workflowConfig());
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 404, { ok: false, message: "Not found" });
    return;
  }

  try {
    const body = await readRequestJson(request);
    if (url.pathname === "/api/ai-workflow/sticker-backgrounds") {
      sendJson(response, 200, await handleStickerBackgrounds(body, visitorToken), tokenHeader);
      return;
    }
    if (url.pathname === "/api/ai-workflow/text-layer") {
      sendJson(response, 200, await handleTextLayer(body, visitorToken), tokenHeader);
      return;
    }
    if (url.pathname === "/api/ai-workflow/config") {
      if (!isLocalRequest(request)) {
        sendJson(response, 403, { ok: false, message: "Local configuration is only available on this computer." });
        return;
      }
      sendJson(response, 200, await saveWorkflowConfig(body));
      return;
    }
    sendJson(response, 404, { ok: false, message: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      message: error.message || "Local workflow server error"
    });
  }
}

export { handleStickerBackgrounds, handleTextLayer, route, workflowStatus };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer(route).listen(PORT, HOST, () => {
    console.log(`AI workflow server listening on http://${HOST}:${PORT}`);
    console.log(`OpenAI base URL: ${openAIBaseUrl()}`);
    console.log(`Image model: ${IMAGE_MODEL}`);
    console.log(`Image timeout: ${IMAGE_TIMEOUT_MS}ms`);
    console.log(`Image edit field: ${imageEditField()}`);
    console.log(`Generation mode: ${GENERATION_MODE}`);
    console.log(`OpenAI key: ${openAIKey() ? "configured" : "missing, local SVG fallback enabled"}`);
    if (QUOTA_ENABLED) {
      console.log(`Quota mode: ON — ${QUOTA_CALLS} official calls/visitor, then fallback to ${FALLBACK_PROVIDER_LABEL} (${FALLBACK_OPENAI_BASE_URL})`);
      console.log(`Fallback key: ${FALLBACK_OPENAI_API_KEY ? "configured" : "MISSING — exhausted visitors will fail"}`);
      console.log(`Quota store: ${fileURLToPath(QUOTA_STORE_PATH)}`);
    } else {
      console.log(`Quota mode: OFF — single global provider (legacy behavior)`);
    }
  });
}
