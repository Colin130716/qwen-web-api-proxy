// browser-extension/src/lib/qwen_api.ts
// Direct Qwen v2 API client — replaces fetch interception with direct API calls.
// Called from content_script.ts on chat.qwen.ai origin with credentials: "include".

/** Single slide page data from Qwen slides phase */
export interface QwenSlidePage {
  page: number;
  image_url: string;
  title?: string;
  content?: string;
}

/** Structured slide generation result from Qwen's slides mode */
export interface QwenSlideData {
  slide_pages: QwenSlidePage[];
  pdf_url?: string;
  slides_count?: number;
  slides_milestone?: string;
  result?: string;
}

/** Pre-upload file reference extracted from OpenAI message content */
export interface QwenFile {
  id: string;
  type: "image";
  url: string;
  upload_status?: "pending" | "uploaded" | "failed";
}

/** Rich file metadata after STS + OSS upload, matching Qwen API expectations */
export interface UploadedFileInfo {
  type: "image";
  id: string; // file_id from STS token
  url: string; // OSS signed URL
  name: string;
  size: number;
  file_type: string;
  status: "uploaded";
  file: {
    id: string;
    filename: string;
    name: string;
    size: number;
    type: string; // MIME type
    meta: { name: string; size: number; content_type: string };
  };
}

export interface QwenSSEEvent {
  type: "reasoning" | "chunk" | "done";
  content?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface QwenDelta {
  kind: "think" | "answer";
  text: string;
  /** True when thinking_summary phase signals status: "finished" */
  thinkFinished?: boolean;
}

/** OpenAI multimodal content part */
interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

const QWEN_SPA_VERSION = "0.2.72";
const BASE_URL = "https://chat.qwen.ai";
const DEFAULT_MODEL = "qwen3.7-plus";

function uuid(): string {
  return crypto.randomUUID();
}

export function getQwenHeaders(): Record<string, string> {
  return {
    source: "web",
    version: QWEN_SPA_VERSION,
    "x-request-id": uuid(),
    "Content-Type": "application/json",
  };
}

/**
 * Extract text string from OpenAI content (string or multimodal array).
 */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text" && !!p.text)
    .map((p) => p.text)
    .join("\n");
}

/**
 * Extract image files from OpenAI multimodal content array.
 */
function extractFiles(content: string | ContentPart[]): QwenFile[] {
  if (typeof content === "string") return [];
  return content
    .filter((p): p is ContentPart & { type: "image_url" } => p.type === "image_url" && !!p.image_url?.url)
    .map((p) => ({
      id: uuid(),
      type: "image" as const,
      url: p.image_url!.url,
    }));
}

// ── STS Token + OSS Upload ──────────────────────────────────
// Qwen does not accept data:// URIs inline. Images must be uploaded to
// Alibaba Cloud OSS first, then referenced by file_id in the chat request.

interface StsTokenData {
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
  file_url: string;
  file_path: string;
  file_id: string;
  bucketname: string;
  region: string;
  endpoint: string;
}

async function getStsToken(
  filename: string,
  filesize: number,
  filetype: string,
): Promise<StsTokenData> {
  // Qwen web sends filesize as a string — match exactly
  const resp = await fetch(`${BASE_URL}/api/v2/files/getstsToken`, {
    method: "POST",
    credentials: "include",
    headers: getQwenHeaders(),
    body: JSON.stringify({ filename, filesize: String(filesize), filetype }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`getstsToken failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const body = await resp.json();
  if (!body.success) {
    throw new Error(`getstsToken rejected: ${JSON.stringify(body)}`);
  }
  return body.data;
}

/**
 * Compute HMAC-SHA256 using the Web Crypto API (available in content scripts).
 */
async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

/**
 * Hex-encode an ArrayBuffer.
 */
function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Upload raw bytes to Alibaba Cloud OSS using V4 HMAC-SHA256 signature.
 *
 * Qwen web uses the official `ali-oss` SDK with `authorizationV4: true`.
 * We replicate the V4 signing algorithm using the Web Crypto API so no
 * external dependency is needed.
 *
 * Builds the PUT URL from bucket + endpoint + filePath (the OSS object key),
 * signs every request with the STS temporary credentials.
 */
async function uploadBytesToOSS(
  sts: StsTokenData,
  blob: Blob,
  filePath: string,
): Promise<void> {
  const { access_key_id, access_key_secret, security_token, bucketname } = sts;

  // The STS response may return region like "oss-ap-southeast-1" (Qwen convention).
  // OSS V4 signing needs the bare region code (e.g. "ap-southeast-1").
  const region = sts.region.replace(/^oss-/i, "");

  // Normalize endpoint — strip protocol, build virtual-hosted-style host
  let rawEndpoint = sts.endpoint;
  if (rawEndpoint.startsWith("http://") || rawEndpoint.startsWith("https://")) {
    rawEndpoint = new URL(rawEndpoint).hostname;
  }
  const host = `${bucketname}.${rawEndpoint}`;
  const objectKey = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const url = `https://${host}/${objectKey}`;

  // UTC timestamps for x-oss-date and credential scope
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const datetime =
    yyyymmdd + "T" + now.toISOString().slice(11, 19).replace(/:/g, "") + "Z";

  // Content-Type — must be set explicitly. The SDK auto-includes
  // it in signed headers. If we omit it, the browser auto-sets it
  // from blob.type on send(), and OSS will include it in signing,
  // causing SignatureDoesNotMatch.
  const contentType = blob.type || "application/octet-stream";

  // ── Canonical Request ───────────────────────────────────────
  const canonicalURI = `/${bucketname}/${objectKey}`;
  // CanonicalHeaders sorted lexicographically per OSS V4 spec
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `x-oss-content-sha256:UNSIGNED-PAYLOAD\n` +
    `x-oss-date:${datetime}\n` +
    `x-oss-security-token:${security_token}\n`;
  const additionalHeaders = "";

  const canonicalRequest =
    `PUT\n${canonicalURI}\n\n${canonicalHeaders}\n${additionalHeaders}\nUNSIGNED-PAYLOAD`;
  const canonicalRequestHash = hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)),
  );

  // ── String to Sign ──────────────────────────────────────────
  const credentialScope = `${yyyymmdd}/${region}/oss/aliyun_v4_request`;
  const stringToSign = `OSS4-HMAC-SHA256\n${datetime}\n${credentialScope}\n${canonicalRequestHash}`;

  // ── Derive Signing Key ──────────────────────────────────────
  let signingKey = await hmacSha256(
    new TextEncoder().encode(`aliyun_v4${access_key_secret}`),
    yyyymmdd,
  );
  signingKey = await hmacSha256(signingKey, region);
  signingKey = await hmacSha256(signingKey, "oss");
  signingKey = await hmacSha256(signingKey, "aliyun_v4_request");

  // ── Signature ───────────────────────────────────────────────
  const signature = hex(await hmacSha256(signingKey, stringToSign));

  // The AdditionalHeaders parameter is OMITTED when there are none.
  const authorization =
    `OSS4-HMAC-SHA256 Credential=${access_key_id}/${credentialScope},` +
    `Signature=${signature}`;

  // ── PUT with XHR ────────────────────────────────────────────────
  // XHR handles `Host` from URL automatically — important since
  // `Host` is a forbidden header for fetch().
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.setRequestHeader("x-oss-content-sha256", "UNSIGNED-PAYLOAD");
    xhr.setRequestHeader("x-oss-date", datetime);
    xhr.setRequestHeader("x-oss-security-token", security_token);
    xhr.setRequestHeader("Authorization", authorization);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        const text =
          xhr.responseText?.slice(0, 500) || `HTTP ${xhr.status}`;
        reject(new Error(`OSS upload failed (${xhr.status}): ${text}`));
      }
    };
    xhr.onerror = () => reject(new Error("OSS upload network error"));
    xhr.send(blob);
  });
}

/**
 * Parse a base64 data:image/... URI into { mime, ext, bytes, blob }.
 */
function parseDataUri(uri: string): { mime: string; ext: string; blob: Blob; size: number } | null {
  const match = uri.match(/^data:(image\/(\w+));base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const rawExt = match[2];
  const ext = rawExt === "jpeg" ? "jpg" : rawExt;
  const b64 = match[3];
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return { mime, ext, blob: new Blob([bytes], { type: mime }), size: bytes.length };
}

/**
 * Upload a single image from a data: URI to Qwen's OSS.
 * Returns the rich UploadedFileInfo ready to embed in a chat request.
 */
export async function uploadImageFromDataUri(
  dataUri: string,
  index: number,
): Promise<UploadedFileInfo> {
  const parsed = parseDataUri(dataUri);
  if (!parsed) throw new Error(`Invalid image data URI at index ${index}`);

  const fileCategory = parsed.mime.split("/")[0];
  const filename = `image_${index}.${parsed.ext}`;
  const sts = await getStsToken(filename, parsed.size, fileCategory);
  await uploadBytesToOSS(sts, parsed.blob, sts.file_path);

  return {
    type: "image" as const,
    id: sts.file_id,
    url: sts.file_url,
    name: filename,
    size: parsed.size,
    file_type: parsed.mime,
    status: "uploaded" as const,
    file: {
      id: sts.file_id,
      filename,
      name: filename,
      size: parsed.size,
      type: parsed.mime,
      meta: { name: filename, size: parsed.size, content_type: parsed.mime },
    },
  };
}

/**
 * Upload all images from a QwenFile list (only those with data: URIs).
 * Non-data URIs are kept as-is (URL references).
 */
export async function uploadAllImages(
  files: QwenFile[],
  signal?: AbortSignal,
): Promise<UploadedFileInfo[]> {
  const results: UploadedFileInfo[] = [];
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const f = files[i];
    if (f.url.startsWith("data:image/")) {
      results.push(await uploadImageFromDataUri(f.url, i));
    } else {
      // Pass through — treat as already-uploaded URL reference
      results.push({
        type: "image",
        id: f.id,
        url: f.url,
        name: `file_${i}`,
        size: 0,
        file_type: "image/png",
        status: "uploaded",
        file: {
          id: f.id,
          filename: `file_${i}`,
          name: `file_${i}`,
          size: 0,
          type: "image/png",
          meta: { name: `file_${i}`, size: 0, content_type: "image/png" },
        },
      });
    }
  }
  return results;
}

/**
 * Process OpenAI-format messages, extracting text prompt and image files.
 * Handles both string content and multimodal content arrays.
 *
 * Files are extracted only from the LAST user message — previous messages
 * in the conversation history already had their images uploaded in prior
 * requests, so re-uploading them would be wasteful and incorrect.
 */
export function processOpenAIMessages(
  messages: { role: string; content: string | ContentPart[] }[],
  cachedSystem?: string | null,
): { text: string; files: QwenFile[] } {
  let systemParts: string[] = [];
  let userContent = "";
  let allFiles: QwenFile[] = [];
  let lastUserIdx = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      systemParts.push(extractText(m.content));
    } else if (m.role === "user") {
      userContent = extractText(m.content);
      if (i === lastUserIdx) {
        allFiles = allFiles.concat(extractFiles(m.content));
      }
    }
  }

  if (cachedSystem) {
    systemParts.unshift(cachedSystem);
  }

  const systemText = systemParts.join("\n\n");
  const text = systemText
    ? `System instructions:\n${systemText}\n\nUser: ${userContent}`
    : userContent;

  return { text, files: allFiles };
}

/**
 * Fold an OpenAI-format messages array into a single prompt string.
 * System instructions are prepended as "System instructions:\n...\n\nUser: ..."
 *
 * cachedSystem — when Cherry Studio splits system+user into two HTTP requests,
 * the system prompt from a prior system-only call is injected here.
 *
 * Note: For multimodal messages (content arrays), use processOpenAIMessages() instead.
 */
export function foldMessages(
  messages: { role: string; content: string | ContentPart[] }[],
  cachedSystem?: string | null,
): string {
  return processOpenAIMessages(messages, cachedSystem).text;
}

/**
 * Parse a single SSE line from Qwen's chat/completions stream.
 * Returns { kind: "think" | "answer", text } or null for non-data / unparseable lines.
 */
export function parseQwenSSEDelta(line: string): QwenDelta | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  let parsed: {
    choices?: Array<{ delta?: { phase?: string | null; content?: unknown } }>;
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return null;
  const phase = delta.phase;
  let content = "";
  if (typeof delta.content === "string") {
    content = delta.content;
  } else if (Array.isArray(delta.content)) {
    // t2i (image generation) may return content as array of image/text parts
    content = delta.content
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (item?.text) return item.text;
        if (item?.type === "image" && item?.url) return `![Generated Image](${item.url})`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // thinking_summary phase: thinking text lives in extra.summary_thought.content, not delta.content
  if (!content && phase === "thinking_summary") {
    const thoughtContent = (delta as any).extra?.summary_thought?.content;
    if (Array.isArray(thoughtContent)) {
      content = thoughtContent.join("\n");
    } else if (typeof thoughtContent === "string") {
      content = thoughtContent;
    }
  }

  if (phase === "think" || phase === "thinking_summary") {
    if (!content) {
      // Signal-only event (status: "finished") — mark thinking as done
      const status = (delta as any).status;
      if (status === "finished") {
        return { kind: "think", text: "", thinkFinished: true };
      }
      return null;
    }
    return { kind: "think", text: content };
  }
  if (phase === "answer" || phase === null || phase === undefined) {
    if (!content) {
      // Skip empty answer chunks
      const status = (delta as any).status;
      if (status === "finished") {
        // Final answer-done signal — no text content, just a marker
        return { kind: "answer", text: "", thinkFinished: false };
      }
      return null;
    }
    return { kind: "answer", text: content };
  }
  // image_gen phase: delta.content is the generated image URL
  if (phase === "image_gen") {
    if (!content) return null;         // skip status: "finished" empty chunk
    const imageMd = `![Generated Image](${content})`;
    return { kind: "answer", text: imageMd };
  }
  // slides phase: delta.content is an array of image/text parts (slide images)
  if (phase === "slides") {
    if (!content) {
      const status = (delta as any).status;
      if (status === "finished") {
        return { kind: "answer", text: "", thinkFinished: false };
      }
      return null;
    }
    return { kind: "answer", text: content };
  }
  return null;
}

/**
 * Create a new chat on Qwen and return its chatId.
 * POST /api/v2/chats/new with cookie-based auth.
 * @param mode "t2t" (text, default), "t2i" (image generation), or "slides" (presentation)
 */
export async function createQwenChat(
  modelId: string = DEFAULT_MODEL,
  mode: "t2t" | "t2i" | "slides" = "t2t",
): Promise<string> {
  console.log("[QwenAPI] createQwenChat() called, modelId:", modelId, "mode:", mode);
  const isT2i = mode === "t2i";
  const isSlides = mode === "slides";
  const resp = await fetch(`${BASE_URL}/api/v2/chats/new`, {
    method: "POST",
    credentials: "include",
    headers: getQwenHeaders(),
    body: JSON.stringify({
      title: isT2i ? "Image Generation" : isSlides ? "Presentation" : "New Chat",
      models: [modelId],
      chat_mode: isT2i ? "t2i" : "normal",
      chat_type: mode,
      timestamp: Date.now(),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Qwen create-chat failed (${resp.status}): ${text.slice(0, 200)}`,
    );
  }
  const body = await resp.json();
  const chatId: string | undefined = body?.data?.id;
  console.log("[QwenAPI] createQwenChat() response chatId:", chatId);
  if (!chatId) throw new Error("Qwen create-chat returned no chat id");
  return chatId;
}

/**
 * Extract `response_id` from a `response.created` SSE event.
 * `response_id` is the AI's response message ID — use it as the `parent_id`
 * for the next request to continue the conversation linearly instead of branching.
 */
function parseResponseCreatedParentId(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    const created = parsed["response.created"];
    // Use response_id (AI's reply) not parent_id (user's message) — the latter creates branches
    if (created && typeof created.response_id === "string") {
      return created.response_id;
    }
  } catch {
    // ignore non-JSON lines
  }
  return null;
}

/**
 * Send a prompt to an existing Qwen chat and stream the SSE response.
 * Returns accumulated { content, reasoning, parentId, slideData } from the phase-based delta stream.
 * @param mode "t2t" (text, default), "t2i" (image generation), or "slides" (presentation)
 */
export async function sendQwenMessage(
  chatId: string,
  modelId: string = DEFAULT_MODEL,
  prompt: string,
  parentId: string | null = null,
  signal?: AbortSignal,
  thinkingEnabled: boolean = true,
  searchEnabled: boolean = false,
  files: UploadedFileInfo[] = [],
  mode: "t2t" | "t2i" | "slides" = "t2t",
): Promise<{ content: string; reasoning: string; parentId: string | null; slideData?: QwenSlideData }> {
  const fid = uuid();
  const url = `${BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`;
  const hasImages = files.length > 0;
  const isT2i = mode === "t2i";
  const isSlides = mode === "slides";

  // t2i and slides modes use their own chat_mode/chat_type; multimodal overrides otherwise
  let chat_mode = "normal";
  let chat_type = mode;
  if (isT2i) {
    chat_mode = "t2i";
    chat_type = "t2i";
  } else if (hasImages) {
    chat_mode = "multimodal";
  }
  const subChatType = isSlides ? "slides" : mode;

  const body = JSON.stringify({
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode,
    model: modelId,
    parent_id: parentId,
    messages: [
      {
        id: null,
        fid,
        parentId: parentId,
        childrenIds: [uuid()],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: files.map((f) => ({
          type: f.type,
          file: f.file,
          id: f.id,
          url: f.url,
          name: f.name,
          collection_name: "",
          progress: 0,
          status: f.status,
          greenNet: "success",
          size: f.size,
          error: "",
          itemId: uuid(),
          file_type: f.file_type,
        })),
        timestamp: Math.floor(Date.now() / 1000),
        models: [modelId],
        model: "",
        chat_type,
        feature_config: {
          thinking_enabled: isT2i ? false : thinkingEnabled,
          output_schema: "phase",
          research_mode: isSlides ? "advance" : "normal",
          auto_thinking: isT2i ? false : thinkingEnabled,
          thinking_mode: isT2i ? "None" : (thinkingEnabled ? "Auto" : "None"),
          thinking_format: "summary",
          auto_search: isSlides || searchEnabled,
        },
        extra: isSlides ? {
          meta: { subChatType: "slides" },
        } : {
          meta: { subChatType },
        },
        sub_chat_type: "slides",
        parent_id: parentId,
      },
    ],
    timestamp: Math.floor(Date.now() / 1000),
  });

  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: getQwenHeaders(),
    body,
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Qwen completion failed (${resp.status}): ${text.slice(0, 200)}`,
    );
  }

  console.log("[QwenAPI] sendQwenMessage() response ok, reading stream...");

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("Qwen response has no body stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let capturedParentId: string | null = null;
  // Deduplicate web search results by URL — Qwen may emit multiple search rounds
  const searchResults: Map<string, string> = new Map();
  // Accumulate slide data from slides phase SSE events
  const slideData: QwenSlideData = { slide_pages: [] };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const pid = parseResponseCreatedParentId(line);
      if (pid) {
        capturedParentId = pid;
        continue;
      }

      if (line.startsWith("data:") && line.includes('"web_search"') && line.includes('"finished"') && line.includes("tool_result")) {
        try {
          const payload = JSON.parse(line.slice(5).trim());
          const extra = payload?.choices?.[0]?.delta?.extra;
          if (extra?.tool_result?.docs) {
            for (const doc of extra.tool_result.docs) {
              if (doc.url && doc.title && !searchResults.has(doc.url)) {
                searchResults.set(doc.url, doc.title);
              }
            }
          }
        } catch { /* skip unparseable */ }
      }

      // Extract slide data from "slides" phase SSE events
      if (isSlides && line.startsWith("data:") && line.includes('"slides"')) {
        try {
          const payload = JSON.parse(line.slice(5).trim());
          const slidesExtra = payload?.choices?.[0]?.delta?.extra?.slides;
          if (slidesExtra) {
            if (slidesExtra.slides_count != null) slideData.slides_count = slidesExtra.slides_count;
            if (slidesExtra.slides_milestone) slideData.slides_milestone = slidesExtra.slides_milestone;
            if (slidesExtra.pdf_url) slideData.pdf_url = slidesExtra.pdf_url;
            if (slidesExtra.result) slideData.result = slidesExtra.result;
            if (Array.isArray(slidesExtra.slide_pages)) {
              for (const page of slidesExtra.slide_pages) {
                if (page.image_url && !slideData.slide_pages.some(p => p.page === page.page)) {
                  slideData.slide_pages.push({
                    page: page.page,
                    image_url: page.image_url,
                    title: page.title,
                    content: page.content,
                  });
                }
              }
            }
          }
        } catch { /* skip unparseable */ }
      }

      const delta = parseQwenSSEDelta(line);
      if (!delta) continue;
      if (delta.kind === "think") {
        reasoning += delta.text;
      } else if (delta.kind === "answer") {
        content += delta.text;
      }
    }
  }

  // Append web search references if any were collected
  if (searchResults.size > 0) {
    const entries = [...searchResults.entries()];
    content +=
      "\n\n---\n\n**网络搜索结果：**\n" +
      entries.map(([url, title], i) => `[${i + 1}] [${title}](${url})`).join("\n");
  }

  console.log("[QwenAPI] sendQwenMessage() complete, content len:", content.length, "reasoning len:", reasoning.length, "parentId:", capturedParentId, "searchResults:", searchResults.size, "slidePages:", slideData.slide_pages.length, "pdfUrl:", slideData.pdf_url ? "yes" : "no");
  return { content, reasoning, parentId: capturedParentId, slideData: slideData.slide_pages.length > 0 || slideData.pdf_url ? slideData : undefined };
}
