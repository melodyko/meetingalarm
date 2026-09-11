import type { Meeting } from "./meeting-store";

export type VoiceMeetingDraft = Pick<
  Meeting,
  "title" | "room" | "date" | "start" | "end" | "owner" | "type" | "reminder"
> & {
  participants?: number;
  transcript?: string;
};

type AgentResponse = {
  meeting?: unknown;
  data?: { meeting?: unknown };
  output?: unknown;
  text?: unknown;
  transcript?: unknown;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export function voiceAgentConfigured() {
  return Boolean(
    process.env.VOICE_AGENT_ENDPOINT?.trim() &&
      process.env.VOICE_AGENT_API_KEY?.trim(),
  );
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function possibleJson(value: unknown) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as unknown;
  } catch {
    return null;
  }
}

function normalizeDraft(value: unknown, transcript = ""): VoiceMeetingDraft {
  const draft = possibleJson(value) as Partial<VoiceMeetingDraft> | null;
  if (!draft) throw new Error("语音 Agent 未返回可识别的会议信息");

  const result: VoiceMeetingDraft = {
    title: String(draft.title || "").trim(),
    room: String(draft.room || "").trim(),
    date: String(draft.date || "").trim(),
    start: String(draft.start || "").trim(),
    end: String(draft.end || "").trim(),
    owner: String(draft.owner || "").trim(),
    type: String(draft.type || "单次").trim() || "单次",
    reminder: draft.reminder !== false,
    transcript: String(draft.transcript || transcript || "").trim(),
  };
  const participants = Number(draft.participants);
  if (Number.isFinite(participants) && participants > 0) {
    result.participants = participants;
  }
  if (
    !result.title ||
    !result.room ||
    !result.owner ||
    !datePattern.test(result.date) ||
    !timePattern.test(result.start) ||
    !timePattern.test(result.end) ||
    result.start >= result.end
  ) {
    throw new Error("语音内容缺少会议名称、会议室、日期、时间或发起人");
  }
  return result;
}

export async function recognizeVoiceMeeting(input: {
  audioBase64: string;
  mimeType: string;
  groupName: string;
  rooms: string[];
  members: Array<{ name: string; email: string }>;
}) {
  const endpoint = process.env.VOICE_AGENT_ENDPOINT?.trim() || "";
  const apiKey = process.env.VOICE_AGENT_API_KEY?.trim() || "";
  if (!endpoint || !apiKey) {
    throw new Error("服务器尚未配置语音 Agent 接口");
  }
  if (!input.audioBase64 || input.audioBase64.length > 16_000_000) {
    throw new Error("录音为空或超过大小限制");
  }

  const audioBytes = decodeBase64(input.audioBase64);
  const extension = input.mimeType.includes("mp4")
    ? "m4a"
    : input.mimeType.includes("ogg")
      ? "ogg"
      : "webm";
  const form = new FormData();
  form.set(
    "audio",
    new Blob([audioBytes], { type: input.mimeType || "audio/webm" }),
    `meeting.${extension}`,
  );
  form.set("model", process.env.VOICE_AGENT_MODEL?.trim() || "meeting-agent");
  form.set("language", "zh-CN");
  form.set(
    "prompt",
    JSON.stringify({
      task: "识别中文语音并生成会议草稿，只返回 JSON。",
      schema: {
        title: "会议名称",
        room: "会议室",
        date: "YYYY-MM-DD",
        start: "HH:mm",
        end: "HH:mm",
        owner: "发起人",
        participants: "可选数字",
        type: "单次",
        reminder: true,
      },
      currentTime: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      groupName: input.groupName,
      availableRooms: input.rooms,
      knownMembers: input.members.map((member) => member.name),
    }),
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`语音 Agent 请求失败（${response.status}）`);
  }

  let payload: AgentResponse;
  try {
    payload = JSON.parse(text) as AgentResponse;
  } catch {
    payload = { text };
  }
  const meeting =
    payload.meeting ??
    payload.data?.meeting ??
    payload.output ??
    payload.text ??
    payload;
  return normalizeDraft(meeting, String(payload.transcript || payload.text || ""));
}
