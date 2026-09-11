"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import reminderAudioUrl from "./meeting-reminder.m4a";
import type {
  EmailSettings,
  Meeting,
  MeetingStatus,
  TeamMember,
} from "../lib/meeting-store";

type GroupPayload = {
  slug: string;
  name: string;
  meetings: Meeting[];
  revision: number;
  rooms: string[];
  members?: TeamMember[];
  emailSettings?: EmailSettings;
  voiceAgentConfigured?: boolean;
};

type VoiceMeetingDraft = Pick<
  Meeting,
  "title" | "room" | "date" | "start" | "end" | "owner" | "type" | "reminder"
> & {
  participants?: number;
  transcript?: string;
};

type ToastNotice = {
  tone: "loading" | "success" | "error" | "info";
  message: string;
  key: number;
};

const defaultMeetingRooms = [
  "财险大厦3702",
  "财险大厦3703",
  "财险大厦3704",
];

// The external voice Agent is not ready for production yet. Keep the
// implementation available while removing its entry point from the UI.
const VOICE_ENTRY_VISIBLE = false;

const statusText: Record<MeetingStatus, string> = {
  done: "已结束",
  active: "进行中",
  soon: "10分钟内",
  upcoming: "待开始",
};

function toDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function beijingDateKey(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateFromKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function meetingStatus(meeting: Meeting, now: Date | null): MeetingStatus {
  if (!now) return "upcoming";
  const startsAt = new Date(`${meeting.date}T${meeting.start}:00+08:00`).getTime();
  const endsAt = new Date(`${meeting.date}T${meeting.end}:00+08:00`).getTime();
  const current = now.getTime();
  if (current >= endsAt) return "done";
  if (current >= startsAt) return "active";
  if (startsAt - current <= 10 * 60 * 1000) return "soon";
  return "upcoming";
}

function durationMinutes(start: string, end: string) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return Math.max(0, endHour * 60 + endMinute - startHour * 60 - startMinute);
}

function durationLabel(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function remainingMeetingLabel(meeting: Meeting, now: Date | null) {
  if (!now || meeting.status !== "active") return "";
  const endsAt = new Date(`${meeting.date}T${meeting.end}:00+08:00`).getTime();
  const minutes = Math.max(1, Math.ceil((endsAt - now.getTime()) / 60_000));
  return `进行中 · 剩余 ${durationLabel(minutes)}`;
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseCsvRow(row: string, delimiter: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseRosterCsv(text: string) {
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0) return [];
  const delimiter = rows[0].includes("\t") ? "\t" : ",";
  const parsed = rows.map((row) => parseCsvRow(row, delimiter));
  const first = parsed[0].map((cell) => cell.toLocaleLowerCase());
  const hasHeader = first.some((cell) =>
    ["姓名", "名字", "name", "邮箱", "email", "e-mail"].includes(cell),
  );
  const nameIndex = Math.max(
    0,
    first.findIndex((cell) => ["姓名", "名字", "name"].includes(cell)),
  );
  const foundEmailIndex = first.findIndex((cell) =>
    ["邮箱", "email", "e-mail"].includes(cell),
  );
  const emailIndex = foundEmailIndex >= 0 ? foundEmailIndex : 1;
  return parsed
    .slice(hasHeader ? 1 : 0)
    .map((row) => ({
      name: String(row[nameIndex] || "").trim(),
      email: String(row[emailIndex] || "").trim(),
    }))
    .filter((member) => member.name);
}

function Icon({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "danger";
}) {
  return <span className={`text-icon ${tone}`}>{children}</span>;
}

export default function MeetingBoard({
  group = "haochezhu",
  isAdmin: adminRoute = false,
}: {
  group?: string;
  isAdmin?: boolean;
}) {
  const route = { group, isAdmin: adminRoute };
  const routeResolved = true;
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [teamName, setTeamName] = useState("");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [serverRooms, setServerRooms] = useState<string[]>(defaultMeetingRooms);
  const [dataError, setDataError] = useState("");
  const [actionError, setActionError] = useState("");
  const [query, setQuery] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [dateOffset, setDateOffset] = useState(0);
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  const [clock, setClock] = useState<Date | null>(null);
  const [syncState, setSyncState] = useState<"waiting" | "syncing" | "synced" | "offline">(
    "waiting",
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  // The display screen is an always-on reminder surface. Refreshing the page
  // restores the logical sound switch to on; browsers may still require one
  // user gesture per device before they permit audible autoplay.
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundError, setSoundError] = useState("");
  const reminderAudioRef = useRef<HTMLAudioElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [emailSettingsOpen, setEmailSettingsOpen] = useState(false);
  const [passwordSettingsOpen, setPasswordSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Meeting | null>(null);
  const [viewing, setViewing] = useState<Meeting | null>(null);
  const [deleting, setDeleting] = useState<Meeting | null>(null);
  const [reminderMeetings, setReminderMeetings] = useState<Meeting[]>([]);
  const [reminderVisible, setReminderVisible] = useState(false);
  const [reminderOpenedAt, setReminderOpenedAt] = useState(0);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [memberDraft, setMemberDraft] = useState<TeamMember>({
    id: 0,
    name: "",
    email: "",
  });
  const [draftOwner, setDraftOwner] = useState("");
  const [draftEmailEnabled, setDraftEmailEnabled] = useState(false);
  const [draftCc, setDraftCc] = useState("");
  const [emailSettings, setEmailSettings] = useState<EmailSettings>({
    enabled: false,
    ccEmails: "",
  });
  const [testRecipient, setTestRecipient] = useState("");
  const [emailTestStatus, setEmailTestStatus] = useState("");
  const [emailTestSending, setEmailTestSending] = useState(false);
  const [rosterImporting, setRosterImporting] = useState(false);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const rosterFileRef = useRef<HTMLInputElement | null>(null);
  const meetingFormRef = useRef<HTMLFormElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => setClock(new Date()), 0);
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!toast || toast.tone === "loading") return;
    const timer = window.setTimeout(() => setToast(null), toast.tone === "error" ? 6500 : 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      if (recordingTimerRef.current) window.clearTimeout(recordingTimerRef.current);
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  useEffect(() => {
    const audio = new Audio(reminderAudioUrl);
    audio.preload = "auto";
    audio.volume = 1;
    audio.load();
    reminderAudioRef.current = audio;
    return () => {
      audio.pause();
      reminderAudioRef.current = null;
    };
  }, []);

  function applyGroupPayload(payload: GroupPayload) {
    setTeamName(payload.name);
    setMeetings(
      payload.meetings.map((meeting) => ({
        ...meeting,
        status: meetingStatus(meeting, new Date()),
      })),
    );
    setServerRooms(Array.isArray(payload.rooms) ? payload.rooms : defaultMeetingRooms);
    if (payload.members) setTeamMembers(payload.members);
    if (payload.emailSettings) setEmailSettings(payload.emailSettings);
    if (typeof payload.voiceAgentConfigured === "boolean") {
      setVoiceConfigured(payload.voiceAgentConfigured);
    }
    setDataError("");
  }

  async function loadGroupData(admin = route.isAdmin) {
    const params = new URLSearchParams({ group: route.group });
    if (admin) params.set("admin", "1");
    const response = await fetch(`/api/meeting-board?${params.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401 && admin) {
      setAuthenticated(false);
      return false;
    }
    const payload = (await response.json()) as GroupPayload & { error?: string };
    if (!response.ok) throw new Error(payload.error || "会议数据加载失败");
    applyGroupPayload(payload);
    if (admin) setAuthenticated(true);
    return true;
  }

  async function apiAction(body: Record<string, unknown>) {
    setActionError("");
    const response = await fetch("/api/meeting-board", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, group: route.group }),
    });
    const payload = (await response.json()) as {
      error?: string;
      group?: GroupPayload;
      ok?: boolean;
      message?: string;
      meeting?: VoiceMeetingDraft;
    };
    if (!response.ok) {
      const message = payload.error || "操作失败，请稍后重试";
      setActionError(message);
      throw new Error(message);
    }
    if (payload.group) applyGroupPayload(payload.group);
    return payload;
  }

  useEffect(() => {
    if (!routeResolved) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      loadGroupData(route.isAdmin)
        .then((loaded) => {
          if (!cancelled && loaded && !route.isAdmin) {
            setLastSyncedAt(new Date());
            setSyncState("synced");
          }
        })
        .catch((error: Error) => {
          if (!cancelled) setDataError(error.message);
        })
        .finally(() => {
          if (!cancelled) setAuthChecking(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // The route is fixed for the lifetime of this page instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.group, route.isAdmin, routeResolved]);

  useEffect(() => {
    if (!clock) return;
    const dueMeetings = meetings.filter((meeting) => {
      if (!meeting.reminder) return false;
      const startsAt = new Date(`${meeting.date}T${meeting.start}:00+08:00`);
      const secondsUntilStart = (startsAt.getTime() - clock.getTime()) / 1000;
      return secondsUntilStart > 590 && secondsUntilStart <= 610;
    });
    const freshMeetings = dueMeetings.filter((meeting) => {
      const reminderKey = `reminded-${route.group}-${meeting.id}-${meeting.date}`;
      return !sessionStorage.getItem(reminderKey);
    });
    if (freshMeetings.length === 0) return;
    freshMeetings.forEach((meeting) => {
      const reminderKey = `reminded-${route.group}-${meeting.id}-${meeting.date}`;
      sessionStorage.setItem(reminderKey, "true");
    });
    showReminderPopup(freshMeetings);
    if (soundEnabled) void playReminderSound();
  }, [clock, meetings, route.group, soundEnabled]);

  useEffect(() => {
    if (!routeResolved || route.isAdmin) return;
    let cancelled = false;
    let requestInFlight = false;

    async function syncMeetingChanges() {
      if (requestInFlight) return;
      requestInFlight = true;
      if (!cancelled) setSyncState("syncing");
      try {
        await loadGroupData(false);
        if (!cancelled) {
          setLastSyncedAt(new Date());
          setSyncState("synced");
        }
      } catch {
        if (!cancelled) setSyncState("offline");
      } finally {
        requestInFlight = false;
      }
    }

    const pollTimer = window.setInterval(syncMeetingChanges, 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
    // The polling callback deliberately reads the current page's fixed route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.group, route.isAdmin, routeResolved]);

  useEffect(() => {
    function handleReminderBroadcast(event: StorageEvent) {
      if (
        route.isAdmin ||
        event.key !== `meeting-reminder-preview-${route.group}` ||
        !event.newValue
      ) {
        return;
      }
      try {
        const payload = JSON.parse(event.newValue) as { ids: number[] };
        const previewMeetings = meetings.filter((meeting) => payload.ids.includes(meeting.id));
        if (previewMeetings.length === 0) return;
        showReminderPopup(previewMeetings);
        if (soundEnabled) void playReminderSound();
      } catch {
        // Ignore invalid cross-tab preview messages.
      }
    }
    window.addEventListener("storage", handleReminderBroadcast);
    return () => window.removeEventListener("storage", handleReminderBroadcast);
  }, [meetings, route.group, route.isAdmin, soundEnabled]);

  useEffect(() => {
    if (!reminderVisible || reminderOpenedAt === 0) return;
    const closeTimer = window.setTimeout(() => {
      setReminderVisible(false);
      setReminderMeetings([]);
    }, 30 * 60 * 1000);
    return () => window.clearTimeout(closeTimer);
  }, [reminderOpenedAt, reminderVisible]);

  const adminUrl = `/tools/work/meeting-alarm/group/${route.group}/admin`;
  const displayUrl = `/tools/work/meeting-alarm/group/${route.group}`;
  const todayKey = clock ? beijingDateKey(clock) : "";

  const date = useMemo(() => {
    const value = todayKey ? dateFromKey(todayKey) : new Date(2000, 0, 1);
    value.setDate(value.getDate() + dateOffset);
    return value;
  }, [dateOffset, todayKey]);

  const weekDates = useMemo(() => {
    const monday = new Date(date);
    const day = monday.getDay() || 7;
    monday.setDate(monday.getDate() - day + 1);
    return Array.from({ length: 7 }, (_, index) => {
      const value = new Date(monday);
      value.setDate(monday.getDate() + index);
      return value;
    });
  }, [date]);

  const dateLabel =
    viewMode === "day"
      ? new Intl.DateTimeFormat("zh-CN", {
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(date)
      : `${weekDates[0].getMonth() + 1}月${weekDates[0].getDate()}日 — ${
          weekDates[6].getMonth() + 1
        }月${weekDates[6].getDate()}日`;

  const liveMeetings = useMemo(
    () =>
      meetings.map((meeting) => ({
        ...meeting,
        status: meetingStatus(meeting, clock),
      })),
    [clock, meetings],
  );

  const searchedMeetings = liveMeetings.filter((meeting) => {
    const matchesQuery =
      meeting.title.toLowerCase().includes(query.toLowerCase()) ||
      meeting.owner.toLowerCase().includes(query.toLowerCase());
    const matchesRoom = !roomFilter || meeting.room === roomFilter;
    return matchesQuery && matchesRoom;
  });

  const filteredMeetings = searchedMeetings.filter(
    (meeting) => meeting.date === toDateKey(date),
  );

  const visibleWeekMeetings = searchedMeetings.filter((meeting) =>
    weekDates.some((weekDate) => toDateKey(weekDate) === meeting.date),
  );

  const roomOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...serverRooms,
          ...meetings.map((meeting) => meeting.room.trim()).filter(Boolean),
        ]),
      ).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [meetings, serverRooms],
  );

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoginError("");
    try {
      const payload = await apiAction({ action: "login", password });
      if (payload.group) applyGroupPayload(payload.group);
      setAuthenticated(true);
      setPassword("");
    } catch (error) {
      setLoginError((error as Error).message);
    }
  }

  function openCreate() {
    setActionError("");
    setEditing(null);
    setDraftOwner("");
    setDraftEmailEnabled(false);
    setDraftCc(emailSettings.ccEmails);
    setVoiceTranscript("");
    setDrawerOpen(true);
  }

  function openEdit(meeting: Meeting) {
    setActionError("");
    setEditing(meeting);
    setDraftOwner(meeting.owner);
    const organizer = teamMembers.find((member) => member.name === meeting.owner);
    setDraftEmailEnabled(
      Boolean(emailSettings.enabled && meeting.emailReminder && organizer?.email),
    );
    setDraftCc(meeting.ccEmails?.join(", ") || emailSettings.ccEmails);
    setVoiceTranscript("");
    setDrawerOpen(true);
  }

  async function saveMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next: Meeting = {
      id: editing?.id ?? Date.now(),
      date: String(data.get("date")),
      title: String(data.get("title")),
      room: String(data.get("room")),
      start: String(data.get("start")),
      end: String(data.get("end")),
      owner: String(data.get("owner")),
      participants: String(data.get("participants")).trim()
        ? Number(data.get("participants"))
        : undefined,
      type: String(data.get("type")),
      status: editing?.status ?? "upcoming",
      reminder: data.get("reminder") === "on",
      emailReminder: data.get("emailReminder") === "on",
      ccEmails: String(data.get("ccEmails") || "")
        .split(/[,，;\s]+/)
        .map((email) => email.trim())
        .filter(Boolean),
    };

    try {
      await apiAction({ action: "saveMeeting", meeting: next });
      setDrawerOpen(false);
    } catch {
      // The shared action error is shown in the editor.
    }
  }

  async function saveTeamMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = memberDraft.name.trim();
    const email = memberDraft.email.trim();
    if (!name) return;

    try {
      await apiAction({
        action: "saveMember",
        member: { id: memberDraft.id || Date.now(), name, email },
      });
      setMemberDraft({ id: 0, name: "", email: "" });
    } catch {
      // The shared action error is shown in the drawer.
    }
  }

  function showToast(tone: ToastNotice["tone"], message: string) {
    setToast({ tone, message, key: Date.now() });
  }

  async function importRosterFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setRosterImporting(true);
    showToast("loading", "正在读取并导入人员名单…");
    try {
      const members = parseRosterCsv(await file.text());
      if (members.length === 0) throw new Error("文件中没有识别到人员，请检查姓名、邮箱两列");
      const result = await apiAction({ action: "importMembers", members });
      showToast("success", result.message || `已导入 ${members.length} 位成员`);
    } catch (error) {
      showToast("error", (error as Error).message);
    } finally {
      setRosterImporting(false);
      input.value = "";
    }
  }

  function exportRoster() {
    const lines = [
      ["姓名", "邮箱"],
      ...teamMembers.map((member) => [member.name, member.email]),
    ].map((row) => row.map(csvCell).join(","));
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${teamName || route.group}-人员名单.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("success", `已导出 ${teamMembers.length} 位成员`);
  }

  function applyVoiceDraft(draft: VoiceMeetingDraft) {
    const form = meetingFormRef.current;
    if (!form) return;
    const setValue = (name: string, value: string | number | undefined) => {
      const field = form.elements.namedItem(name);
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement
      ) {
        field.value = value === undefined ? "" : String(value);
      }
    };
    setValue("title", draft.title);
    setValue("room", draft.room);
    setValue("date", draft.date);
    setValue("start", draft.start);
    setValue("end", draft.end);
    setValue("participants", draft.participants);
    setValue("type", draft.type || "单次");
    const reminder = form.elements.namedItem("reminder");
    if (reminder instanceof HTMLInputElement) reminder.checked = draft.reminder !== false;
    setDraftOwner(draft.owner);
    setDraftEmailEnabled(false);
    setVoiceTranscript(draft.transcript || "");
  }

  function blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("无法读取录音"));
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.readAsDataURL(blob);
    });
  }

  async function submitVoiceRecording(blob: Blob) {
    setVoiceProcessing(true);
    showToast("loading", "正在识别语音并生成会议草稿…");
    try {
      const result = await apiAction({
        action: "recognizeVoiceMeeting",
        audioBase64: await blobToBase64(blob),
        mimeType: blob.type || "audio/webm",
      });
      if (!result.meeting) throw new Error("语音 Agent 没有返回会议草稿");
      applyVoiceDraft(result.meeting);
      showToast("success", "语音识别完成，请确认会议内容后再创建");
    } catch (error) {
      showToast("error", (error as Error).message);
    } finally {
      setVoiceProcessing(false);
    }
  }

  function stopVoiceRecording() {
    if (recordingTimerRef.current) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }

  async function toggleVoiceRecording() {
    if (voiceRecording) {
      stopVoiceRecording();
      return;
    }
    if (!voiceConfigured) {
      showToast("info", "语音 Agent 接口尚未配置");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      showToast("error", "当前浏览器不支持录音，请使用新版 Safari、Edge 或 Chrome");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        setVoiceRecording(false);
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        recordingChunksRef.current = [];
        if (blob.size > 0) void submitVoiceRecording(blob);
      };
      recorder.start();
      setVoiceRecording(true);
      showToast("info", "正在录音，请说出会议名称、会议室、日期、时间和发起人");
      recordingTimerRef.current = window.setTimeout(stopVoiceRecording, 45_000);
    } catch {
      showToast("error", "无法使用麦克风，请检查浏览器权限；iPad 需通过 HTTPS 访问");
    }
  }

  function editTeamMember(member: TeamMember) {
    setMemberDraft(member);
  }

  async function deleteTeamMember(memberId: number) {
    try {
      await apiAction({ action: "deleteMember", memberId });
      if (memberDraft.id === memberId) {
        setMemberDraft({ id: 0, name: "", email: "" });
      }
    } catch {
      // The shared action error is shown in the drawer.
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const selectedRoomWillBeEmpty =
      roomFilter === deleting.room &&
      !meetings.some(
        (meeting) => meeting.id !== deleting.id && meeting.room === roomFilter,
      );
    try {
      await apiAction({ action: "deleteMeeting", meetingId: deleting.id });
      if (selectedRoomWillBeEmpty) setRoomFilter("");
      setDeleting(null);
    } catch {
      // Keep the confirmation open so the administrator can retry.
    }
  }

  async function enterFullscreen() {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
  }

  async function playReminderSound() {
    const audio = reminderAudioRef.current || new Audio(reminderAudioUrl);
    reminderAudioRef.current = audio;
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    try {
      await audio.play();
      setSoundError("");
      return true;
    } catch {
      setSoundError("浏览器尚未授权自动播放，请点击“测试声音”完成授权");
      return false;
    }
  }

  function toggleReminderSound() {
    if (soundEnabled) {
      reminderAudioRef.current?.pause();
      setSoundEnabled(false);
      setSoundError("");
      return;
    }
    setSoundEnabled(true);
  }

  async function testReminderSound() {
    await playReminderSound();
  }

  function showReminderPopup(incomingMeetings: Meeting[]) {
    setReminderMeetings((current) => {
      const merged = [...current];
      incomingMeetings.forEach((meeting) => {
        if (!merged.some((item) => item.id === meeting.id)) merged.push(meeting);
      });
      return merged.sort((a, b) => a.start.localeCompare(b.start));
    });
    setReminderOpenedAt(Date.now());
    setReminderVisible(true);
  }

  function closeReminderPopup() {
    setReminderVisible(false);
    setReminderMeetings([]);
  }

  function testReminderExperience() {
    void playReminderSound();
    const previewMeetings = liveMeetings
      .filter((meeting) => meeting.date === todayKey && meeting.status !== "done")
      .slice(0, 2);
    const reminders =
      previewMeetings.length > 0
        ? previewMeetings
        : [
            {
              id: -1,
              date: todayKey,
              title: "会议提醒测试",
              room: serverRooms[0] || "会议室",
              start: new Intl.DateTimeFormat("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: "Asia/Shanghai",
              }).format(new Date(Date.now() + 10 * 60 * 1000)),
              end: "",
              owner: "本组管理员",
              type: "测试",
              status: "soon" as MeetingStatus,
              reminder: true,
            },
          ];
    showReminderPopup(reminders);
    localStorage.setItem(
      `meeting-reminder-preview-${route.group}`,
      JSON.stringify({
        ids: reminders.filter((meeting) => meeting.id > 0).map((meeting) => meeting.id),
        sentAt: Date.now(),
      }),
    );
  }

  function stepDate(direction: -1 | 1) {
    setDateOffset((value) => value + direction * (viewMode === "week" ? 7 : 1));
  }

  async function saveEmailSettings() {
    try {
      await apiAction({ action: "saveEmailSettings", settings: emailSettings });
      setEmailSettingsOpen(false);
    } catch {
      // The shared action error is shown in the settings drawer.
    }
  }

  async function sendTestEmail() {
    setEmailTestStatus("");
    setEmailTestSending(true);
    showToast("loading", "正在连接邮件服务器并发送测试邮件…");
    try {
      const result = await apiAction({ action: "testEmail", recipient: testRecipient });
      const message = result.message || "测试邮件已发送，请检查收件箱。";
      setEmailTestStatus(message);
      showToast("success", message);
    } catch (error) {
      showToast("error", (error as Error).message);
    } finally {
      setEmailTestSending(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const currentPassword = String(data.get("currentPassword") || "");
    const newPassword = String(data.get("newPassword") || "");
    const confirmation = String(data.get("confirmation") || "");
    if (newPassword !== confirmation) {
      setActionError("两次输入的新密码不一致");
      return;
    }
    try {
      await apiAction({ action: "changePassword", currentPassword, newPassword });
      setPasswordSettingsOpen(false);
      setActionError("");
    } catch {
      // The shared action error is shown in the password panel.
    }
  }

  const isAdmin = route.isAdmin && authenticated;
  const selectedOrganizer = teamMembers.find(
    (member) => member.name.trim() === draftOwner.trim(),
  );
  const statsMeetings = viewMode === "day" ? filteredMeetings : visibleWeekMeetings;
  const totalMinutes = statsMeetings.reduce((total, meeting) => {
    const [startHour, startMinute] = meeting.start.split(":").map(Number);
    const [endHour, endMinute] = meeting.end.split(":").map(Number);
    return total + endHour * 60 + endMinute - startHour * 60 - startMinute;
  }, 0);
  const roomCount = new Set(statsMeetings.map((meeting) => meeting.room)).size;
  const nextReminderMeeting = clock
    ? meetings
        .filter((meeting) => {
          if (!meeting.reminder) return false;
          const startsAt = new Date(`${meeting.date}T${meeting.start}:00+08:00`);
          return startsAt.getTime() > clock.getTime();
        })
        .sort((a, b) =>
          `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`),
        )[0] || null
    : null;
  const nextMeetingStartsAt = nextReminderMeeting
    ? new Date(`${nextReminderMeeting.date}T${nextReminderMeeting.start}:00+08:00`)
    : null;
  const secondsUntilMeeting =
    clock && nextMeetingStartsAt
      ? Math.max(0, Math.floor((nextMeetingStartsAt.getTime() - clock.getTime()) / 1000))
      : 0;
  const reminderHasTriggered =
    Boolean(nextReminderMeeting) && secondsUntilMeeting <= 10 * 60;
  const reminderCountdownSeconds = nextReminderMeeting
    ? Math.max(0, secondsUntilMeeting - (reminderHasTriggered ? 0 : 10 * 60))
    : 0;
  const reminderCountdownLabel = [
    Math.floor(reminderCountdownSeconds / 3600),
    Math.floor((reminderCountdownSeconds % 3600) / 60),
    reminderCountdownSeconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  const reminderRemainingSeconds = reminderOpenedAt && clock
    ? Math.max(0, 30 * 60 - Math.floor((clock.getTime() - reminderOpenedAt) / 1000))
    : 30 * 60;
  const reminderRemainingLabel = `${String(
    Math.floor(reminderRemainingSeconds / 60),
  ).padStart(2, "0")}:${String(reminderRemainingSeconds % 60).padStart(2, "0")}`;

  return (
    <main className={`app-shell ${isAdmin ? "admin-mode" : "display-mode"}`}>
      {toast && (
        <div key={toast.key} className={`toast-notice ${toast.tone}`} role="status" aria-live="polite">
          <i />
          <span>{toast.message}</span>
          {toast.tone !== "loading" && (
            <button onClick={() => setToast(null)} aria-label="关闭提示">×</button>
          )}
        </div>
      )}
      {isAdmin && (
        <aside className="admin-rail">
          <div className="rail-brand">
            <span className="brand-mark">会</span>
            <div>
              <strong>会议铃</strong>
              <small>团队会议管理</small>
            </div>
          </div>
          <nav aria-label="管理功能">
            <button className="rail-item active">
              <Icon>▦</Icon>
              今日会议
            </button>
            <button className="rail-item" onClick={() => setRosterOpen(true)}>
              <Icon>♙</Icon>
              人员名单
            </button>
            <button className="rail-item" onClick={() => setEmailSettingsOpen(true)}>
              <Icon>✉</Icon>
              邮件提醒设置
            </button>
            <button className="rail-item" onClick={() => setPasswordSettingsOpen(true)}>
              <Icon>⌁</Icon>
              修改管理员密码
            </button>
          </nav>
          <div className="rail-bottom">
            <div className="rail-team">
              <span>好</span>
              <div>
                <strong>{teamName || `${route.group} 组`}</strong>
                <small>团队管理员</small>
              </div>
            </div>
            <a className="rail-preview" href={displayUrl}>
              打开展示屏 ↗
            </a>
          </div>
        </aside>
      )}

      <section className="board">
        <header className="topbar">
          <div className="identity">
            {!isAdmin && <span className="brand-mark">会</span>}
            <div>
              <span className="eyebrow">{isAdmin ? "会议管理台" : "MEETING BOARD"}</span>
              <h1>{teamName || `${route.group} 组`}</h1>
            </div>
          </div>
          <div className="top-actions">
            {!isAdmin && (
              <>
                <button
                  className={`sound-control ${soundEnabled ? "enabled" : ""}`}
                  onClick={toggleReminderSound}
                  aria-label="切换提醒声音"
                  aria-pressed={soundEnabled}
                  title={soundError || "刷新页面后会自动恢复开启"}
                >
                  <span aria-hidden="true">{soundEnabled ? "♪" : "×"}</span>
                  {soundEnabled
                    ? soundError
                      ? "声音待授权"
                      : "声音已开启"
                    : "声音已关闭"}
                </button>
                <button
                  className="sound-test-button"
                  onClick={() => void testReminderSound()}
                  aria-label="测试提醒声音"
                  title="播放一次机场提示音和中文播报"
                >
                  测试声音
                </button>
                <button className="icon-button" onClick={enterFullscreen} aria-label="进入全屏">
                  ⛶
                </button>
                <a className="admin-link" href={adminUrl}>
                  管理员
                </a>
              </>
            )}
            {isAdmin && (
              <>
                <button className="sound-test-button" onClick={testReminderExperience}>
                  ♪ 测试提醒与声音
                </button>
                <button className="ghost-button">导出日程</button>
                <button className="primary-button" onClick={openCreate}>
                  <span>＋</span> 新增会议
                </button>
              </>
            )}
          </div>
        </header>

        {dataError && (
          <div className="board-error" role="alert">
            <strong>会议数据暂时无法加载</strong>
            <span>{dataError}</span>
          </div>
        )}

        <div className="summary-row">
          <div className="date-nav">
            <button
              onClick={() => stepDate(-1)}
              aria-label={viewMode === "day" ? "前一天" : "上一周"}
            >
              ←
            </button>
            <div>
              <strong>{dateLabel}</strong>
              <span>
                {toDateKey(date) === todayKey
                  ? viewMode === "day"
                    ? "今天"
                    : "本周"
                  : viewMode === "day"
                    ? "日程"
                    : "周日程"}
              </span>
            </div>
            <button
              onClick={() => stepDate(1)}
              aria-label={viewMode === "day" ? "后一天" : "下一周"}
            >
              →
            </button>
          </div>
          <div className="day-stats">
            <div>
              <b>{statsMeetings.length}</b>
              <span>场会议</span>
            </div>
            <i />
            <div>
              <b>{(totalMinutes / 60).toFixed(totalMinutes % 60 === 0 ? 0 : 1)}</b>
              <span>小时</span>
            </div>
            <i />
            <div>
              <b>{roomCount}</b>
              <span>间会议室</span>
            </div>
          </div>
          <div className="live-clock">
            <span>北京时间</span>
            <strong>
              {clock
                ? clock.toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                    timeZone: "Asia/Shanghai",
                  })
                : "--:--:--"}
            </strong>
          </div>
        </div>

        <section className="alert-strip">
          <div className="alert-symbol">
            <span>♪</span>
          </div>
          <div className="alert-copy">
            <span>下一场提醒</span>
            <strong>{nextReminderMeeting?.title || "今日暂无待提醒会议"}</strong>
          </div>
          <div className="alert-place">
            <span>{nextReminderMeeting?.start || "--:--"}</span>
            <b>{nextReminderMeeting?.room || "—"}</b>
          </div>
          <div className="countdown">
            <small>
              {nextReminderMeeting
                ? reminderHasTriggered
                  ? "距会议开始"
                  : "距提醒触发"
                : "提醒状态"}
            </small>
            <strong>{nextReminderMeeting ? reminderCountdownLabel : "--:--:--"}</strong>
          </div>
        </section>

        {isAdmin && (
          <div className="admin-toolbar">
            <label className="search-box">
              <span>⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索会议名称或发起人"
              />
            </label>
            <select value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)}>
              <option value="">全部会议室</option>
              {roomOptions.map((room) => (
                <option key={room} value={room}>{room}</option>
              ))}
            </select>
          </div>
        )}

        <section className="schedule-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">
                {viewMode === "day" ? "DAY SCHEDULE" : "WEEK SCHEDULE"}
              </span>
              <h2>{viewMode === "day" ? "按日查看" : "按周查看"}</h2>
            </div>
            <div className="section-controls">
              <div className="view-switch" aria-label="查看方式">
                <button
                  className={viewMode === "day" ? "active" : ""}
                  onClick={() => setViewMode("day")}
                >
                  按日
                </button>
                <button
                  className={viewMode === "week" ? "active" : ""}
                  onClick={() => setViewMode("week")}
                >
                  按周
                </button>
              </div>
              <div className="legend">
                <span><i className="active-dot" />进行中</span>
                <span><i className="soon-dot" />即将开始</span>
                <span><i className="future-dot" />待开始</span>
              </div>
            </div>
          </div>

          {viewMode === "day" ? (
          <div className="timeline">
            {filteredMeetings.map((meeting) => (
              <article className={`meeting-row ${meeting.status}`} key={meeting.id}>
                <div className="time-block">
                  <strong>{meeting.start}</strong>
                  <span>{meeting.end}</span>
                </div>
                <div className="timeline-marker">
                  <i />
                </div>
                <div className="meeting-main">
                  <div className="meeting-title-line">
                    <span className={`status-badge ${meeting.status}`}>
                      {statusText[meeting.status]}
                    </span>
                    <h3>{meeting.title}</h3>
                    {meeting.reminder && <span className="bell" title="已开启提醒">♪</span>}
                  </div>
                  <div className="meeting-meta">
                    <span><b>⌖</b>{meeting.room}</span>
                    <span><b>◎</b>{meeting.owner}</span>
                    <span>
                      <b>♙</b>
                      {meeting.participants ? `${meeting.participants} 人` : "人数未填"}
                    </span>
                    <span className="repeat-tag">{meeting.type}</span>
                  </div>
                </div>
                {isAdmin ? (
                  <div className="row-actions">
                    <button onClick={() => setViewing(meeting)} aria-label={`查看${meeting.title}`}>
                      查看
                    </button>
                    <button onClick={() => openEdit(meeting)} aria-label={`编辑${meeting.title}`}>
                      编辑
                    </button>
                    <button
                      className="delete-button"
                      onClick={() => setDeleting(meeting)}
                      aria-label={`删除${meeting.title}`}
                    >
                      删除
                    </button>
                  </div>
                ) : (
                  <div className="duration">
                    <strong>{durationLabel(durationMinutes(meeting.start, meeting.end))}</strong>
                    {meeting.status === "active" && (
                      <span>{remainingMeetingLabel(meeting, clock)}</span>
                    )}
                  </div>
                )}
              </article>
            ))}

            {filteredMeetings.length === 0 && (
              <div className="empty-state">
                <span>○</span>
                <strong>没有找到符合条件的会议</strong>
                <p>调整关键词或会议室筛选后再试试。</p>
              </div>
            )}
          </div>
          ) : (
            <div className="week-grid">
              {weekDates.map((weekDate) => {
                const dayKey = toDateKey(weekDate);
                const dayMeetings = visibleWeekMeetings
                  .filter((meeting) => meeting.date === dayKey)
                  .sort((a, b) => a.start.localeCompare(b.start));
                const isToday = dayKey === todayKey;
                return (
                  <section className={`week-day ${isToday ? "today" : ""}`} key={dayKey}>
                    <header>
                      <span>
                        {new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(weekDate)}
                      </span>
                      <strong>{weekDate.getDate()}</strong>
                      {isToday && <small>今天</small>}
                    </header>
                    <div className="week-events">
                      {dayMeetings.map((meeting) => (
                        <article
                          className={`week-event ${meeting.status}`}
                          key={meeting.id}
                          onClick={() => isAdmin && setViewing(meeting)}
                        >
                          <time>{meeting.start}</time>
                          <strong>{meeting.title}</strong>
                          <span>{meeting.room.split(" · ")[0]}</span>
                          {meeting.reminder && <i>♪</i>}
                          {isAdmin && (
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                openEdit(meeting);
                              }}
                              aria-label={`编辑${meeting.title}`}
                            >
                              编辑
                            </button>
                          )}
                        </article>
                      ))}
                      {dayMeetings.length === 0 && <span className="week-empty">暂无会议</span>}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </section>

        <footer className="board-footer">
          <span className={`sync-status ${syncState}`}>
            <i className="connection-dot" />
            {route.isAdmin
              ? "管理数据已加载"
              : syncState === "syncing"
                ? "正在同步会议更新…"
                : syncState === "offline"
                  ? "网络暂时不可用，将在下一轮重试"
                  : lastSyncedAt
                    ? "已同步 · 每60秒自动检查更新"
                    : "正在等待首次同步"}
          </span>
          <span>会议铃 · 团队会议管理工具</span>
        </footer>
      </section>

      {!route.isAdmin && reminderVisible && reminderMeetings.length > 0 && (
        <div className="reminder-overlay" role="dialog" aria-modal="true" aria-label="会议提醒">
          <section className="reminder-popup">
            <header>
              <div className="reminder-alarm-icon">
                <span>♪</span>
              </div>
              <div>
                <span className="eyebrow">MEETING REMINDER</span>
                <h2>请注意，10分钟后本组有会议开始，请提醒定会人前往</h2>
                <p>
                  {reminderMeetings.length > 1
                    ? `共有 ${reminderMeetings.length} 场会议即将开始`
                    : "请提前准备并准时到达会议室"}
                </p>
              </div>
              <button onClick={closeReminderPopup} aria-label="关闭会议提醒">×</button>
            </header>
            <div className="reminder-list">
              {reminderMeetings.map((meeting) => (
                <article key={meeting.id}>
                  <time>{meeting.start}</time>
                  <div>
                    <strong>{meeting.title}</strong>
                    <span>{meeting.room} · 发起人 {meeting.owner}</span>
                  </div>
                  <i>{meeting.type}</i>
                </article>
              ))}
            </div>
            <footer>
              <span>无人操作将在 {reminderRemainingLabel} 后自动关闭</span>
              <button onClick={closeReminderPopup}>知道了，关闭提醒</button>
            </footer>
          </section>
        </div>
      )}

      {route.isAdmin && !authenticated && !authChecking && (
        <div className="modal-backdrop">
          <form className="login-card" onSubmit={handleLogin}>
            <a href={displayUrl} className="modal-close" aria-label="返回看板">×</a>
            <span className="brand-mark large">会</span>
            <span className="eyebrow">ADMIN ACCESS</span>
            <h2>进入 {teamName || `${route.group} 组`}管理台</h2>
            <p>登录后可新增、编辑和删除本团队会议。</p>
            <label>
              管理员密码
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入管理员密码"
                autoFocus
              />
            </label>
            {loginError && <span className="form-error">{loginError}</span>}
            <button className="primary-button wide" type="submit">进入管理台</button>
          </form>
        </div>
      )}

      {drawerOpen && (
        <div className="drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="editor-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <span className="eyebrow">{editing ? "EDIT MEETING" : "NEW MEETING"}</span>
                <h2>{editing ? "编辑会议" : "新增会议"}</h2>
              </div>
              <button onClick={() => setDrawerOpen(false)} aria-label="关闭编辑面板">×</button>
            </div>
            <form ref={meetingFormRef} onSubmit={saveMeeting} className="meeting-form">
              {actionError && <span className="form-error full">{actionError}</span>}
              {!editing && VOICE_ENTRY_VISIBLE && (
                <section className={`voice-entry-card full ${voiceConfigured ? "" : "disabled"}`}>
                  <div>
                    <strong>语音创建会议</strong>
                    <span>
                      {voiceConfigured
                        ? "说出会议名称、会议室、日期、开始/结束时间和发起人，识别后会自动填入下方表单。"
                        : "服务器配置外部语音 Agent 后即可启用，API Key 不会发送到浏览器。"}
                    </span>
                    {voiceTranscript && <small>识别原文：{voiceTranscript}</small>}
                  </div>
                  <button
                    type="button"
                    className={voiceRecording ? "voice-stop-button" : "ghost-button"}
                    disabled={!voiceConfigured || voiceProcessing}
                    onClick={() => void toggleVoiceRecording()}
                  >
                    {voiceProcessing
                      ? "正在识别…"
                      : voiceRecording
                        ? "■ 结束并识别"
                        : "● 开始语音录入"}
                  </button>
                </section>
              )}
              <label className="full">
                会议名称
                <input
                  name="title"
                  list="meeting-title-options"
                  required
                  defaultValue={editing?.title}
                  placeholder="选择常用名称或直接输入"
                />
                <datalist id="meeting-title-options">
                  <option value="组会" />
                  <option value="项目沟通" />
                  <option value="需求评审" />
                  <option value="方案评审" />
                  <option value="项目复盘" />
                  <option value="迭代排期" />
                  <option value="跨组同步" />
                </datalist>
              </label>
              <label className="full">
                会议室
                <input
                  name="room"
                  list="meeting-room-options"
                  required
                  defaultValue={editing?.room || ""}
                  placeholder="选择常用会议室或手动填写"
                />
                <datalist id="meeting-room-options">
                  {roomOptions.map((room) => (
                    <option key={room} value={room} />
                  ))}
                </datalist>
              </label>
              <label className="full">
                会议日期
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={editing?.date || toDateKey(date)}
                />
              </label>
              <label>
                开始时间
                <input
                  name="start"
                  type="text"
                  inputMode="numeric"
                  pattern="([01]\d|2[0-3]):[0-5]\d"
                  required
                  defaultValue={editing?.start || "15:00"}
                  placeholder="HH:mm"
                />
              </label>
              <label>
                结束时间
                <input
                  name="end"
                  type="text"
                  inputMode="numeric"
                  pattern="([01]\d|2[0-3]):[0-5]\d"
                  required
                  defaultValue={editing?.end || "16:00"}
                  placeholder="HH:mm"
                />
              </label>
              <label>
                <span className="field-label-row">
                  <span>发起人</span>
                  <button type="button" onClick={() => setRosterOpen(true)}>维护名单</button>
                </span>
                <input
                  name="owner"
                  list="team-member-options"
                  required
                  value={draftOwner}
                  onChange={(event) => {
                    const owner = event.target.value;
                    setDraftOwner(owner);
                    const member = teamMembers.find((item) => item.name === owner);
                    if (!member?.email) setDraftEmailEnabled(false);
                  }}
                  placeholder="选择名单成员或手动填写"
                />
                <datalist id="team-member-options">
                  {teamMembers.map((member) => (
                    <option key={member.id} value={member.name}>
                      {member.email || "未维护邮箱"}
                    </option>
                  ))}
                </datalist>
              </label>
              <label>
                参会人数（选填）
                <input
                  name="participants"
                  type="number"
                  min="1"
                  defaultValue={editing?.participants || ""}
                  placeholder="可留空"
                />
              </label>
              <label className="full">
                重复规则
                <select name="type" defaultValue={editing?.type || "单次"}>
                  <option>单次</option>
                  <option>每日</option>
                  <option>每周五</option>
                  <option>每双周</option>
                </select>
              </label>
              <label className="switch-row full">
                <span>
                  <strong>会议提醒</strong>
                  <small>开始前 10 分钟在展示屏提醒并播放声音</small>
                </span>
                <input
                  name="reminder"
                  type="checkbox"
                  defaultChecked={editing?.reminder ?? true}
                />
              </label>
              <section
                className={`email-reminder-card full ${
                  emailSettings.enabled && selectedOrganizer?.email ? "" : "disabled"
                }`}
              >
                <div className="email-setting-head">
                  <div>
                    <strong>邮件提醒</strong>
                    <small>
                      {!emailSettings.enabled
                        ? "全局邮件提醒已关闭，请先在侧栏“邮件提醒设置”中开启"
                        : selectedOrganizer?.email
                          ? `将发送给 ${selectedOrganizer.name}（${selectedOrganizer.email}）`
                          : "选择名单中已维护邮箱的发起人后可开启"}
                    </small>
                  </div>
                  <label className="compact-switch">
                    <input
                      name="emailReminder"
                      type="checkbox"
                      disabled={!emailSettings.enabled || !selectedOrganizer?.email}
                      checked={draftEmailEnabled}
                      onChange={(event) => setDraftEmailEnabled(event.target.checked)}
                    />
                    <span />
                  </label>
                </div>
                {emailSettings.enabled && draftEmailEnabled && selectedOrganizer?.email && (
                  <div className="email-options">
                    <label>
                      抄送人邮箱（选填）
                      <input
                        name="ccEmails"
                        type="text"
                        value={draftCc}
                        onChange={(event) => setDraftCc(event.target.value)}
                        placeholder="多个邮箱使用逗号分隔"
                      />
                    </label>
                    <details className="email-template">
                      <summary>预览邮件内容</summary>
                      <div>
                        <strong>主题：【会议提醒】&#123;&#123;会议名称&#125;&#125; 即将开始</strong>
                        <p><strong>会议提醒</strong></p>
                        <p><strong>&#123;&#123;会议名称&#125;&#125;</strong></p>
                        <p>&#123;&#123;发起人&#125;&#125;，你好：</p>
                        <p>
                          你申请的的“&#123;&#123;会议名称&#125;&#125;”将于
                          &#123;&#123;会议日期&#125;&#125; &#123;&#123;开始时间&#125;&#125;<br />
                          在 &#123;&#123;会议室&#125;&#125;开始，请您及时召唤参会人前往。
                        </p>
                        <p>为避免影响会议安排及产生相关通报，请关注以下建议：</p>
                        <p>（1）会议开始提前前往，超过10分钟会被通报；</p>
                        <p>（2）会议提前结束时请在会议室内面板及时释放；</p>
                        <p>
                          （3）若您当前会议已确定改期/取消，请您在会议开始并坐满10分后从面板上释放，谢谢！
                        </p>
                        <p>本邮件由 {teamName || "本组"}会议看板自动发送，请勿直接回复。</p>
                      </div>
                    </details>
                  </div>
                )}
              </section>
              <div className="form-actions full">
                <button type="button" className="ghost-button" onClick={() => setDrawerOpen(false)}>
                  取消
                </button>
                <button type="submit" className="primary-button">
                  {editing ? "保存修改" : "创建会议"}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}

      {rosterOpen && (
        <div className="drawer-backdrop roster-backdrop" onMouseDown={() => setRosterOpen(false)}>
          <aside className="editor-drawer roster-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <span className="eyebrow">TEAM DIRECTORY</span>
                <h2>本组人员名单</h2>
              </div>
              <button onClick={() => setRosterOpen(false)} aria-label="关闭人员名单">×</button>
            </div>
            <div className="roster-content">
              <form className="roster-form" onSubmit={saveTeamMember}>
                {actionError && <span className="form-error">{actionError}</span>}
                <label>
                  姓名
                  <input
                    required
                    value={memberDraft.name}
                    onChange={(event) =>
                      setMemberDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="输入成员姓名"
                  />
                </label>
                <label>
                  邮箱（选填）
                  <input
                    type="email"
                    value={memberDraft.email}
                    onChange={(event) =>
                      setMemberDraft((current) => ({ ...current, email: event.target.value }))
                    }
                    placeholder="name@example.com"
                  />
                </label>
                <div>
                  {memberDraft.id !== 0 && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setMemberDraft({ id: 0, name: "", email: "" })}
                    >
                      取消编辑
                    </button>
                  )}
                  <button type="submit" className="primary-button">
                    {memberDraft.id ? "保存成员" : "添加成员"}
                  </button>
                </div>
              </form>

              <div className="roster-summary">
                <div>
                  <strong>{teamMembers.length} 位成员</strong>
                  <span>{teamMembers.filter((member) => member.email).length} 人已维护邮箱</span>
                </div>
                <div className="roster-file-actions">
                  <input
                    ref={rosterFileRef}
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    onChange={importRosterFile}
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={rosterImporting}
                    onClick={() => rosterFileRef.current?.click()}
                  >
                    {rosterImporting ? "正在导入…" : "导入 CSV"}
                  </button>
                  <button type="button" className="ghost-button" onClick={exportRoster}>
                    导出名单
                  </button>
                </div>
              </div>
              <p className="roster-note">
                文件使用“姓名、邮箱”两列；可从 Excel 另存为 CSV。相同姓名会更新邮箱，不会重复新增。
              </p>

              <div className="roster-list">
                {teamMembers.map((member) => (
                  <article key={member.id}>
                    <span className="member-avatar">{member.name.slice(0, 1)}</span>
                    <div>
                      <strong>{member.name}</strong>
                      <span>{member.email || "暂未维护邮箱"}</span>
                    </div>
                    <button onClick={() => editTeamMember(member)}>编辑</button>
                    <button className="delete-button" onClick={() => deleteTeamMember(member.id)}>
                      删除
                    </button>
                  </article>
                ))}
                {teamMembers.length === 0 && (
                  <div className="empty-state">
                    <strong>名单还是空的</strong>
                    <p>在上方添加本组成员，之后创建会议时即可直接选择。</p>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {emailSettingsOpen && (
        <div className="drawer-backdrop" onMouseDown={() => setEmailSettingsOpen(false)}>
          <aside
            className="editor-drawer settings-drawer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <span className="eyebrow">EMAIL REMINDER</span>
                <h2>邮件提醒设置</h2>
              </div>
              <button onClick={() => setEmailSettingsOpen(false)} aria-label="关闭邮件设置">
                ×
              </button>
            </div>
            <div className="settings-content">
              {actionError && <span className="form-error">{actionError}</span>}
              <section className="settings-block">
                <div className="settings-switch-row">
                  <div>
                    <strong>启用邮件提醒</strong>
                    <span>开启后，创建会议时可选择向发起人发送提醒邮件。</span>
                  </div>
                  <label className="compact-switch">
                    <input
                      type="checkbox"
                      checked={emailSettings.enabled}
                      onChange={(event) =>
                        setEmailSettings((current) => ({
                          ...current,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                    <span />
                  </label>
                </div>
              </section>

              <section className={`settings-block ${emailSettings.enabled ? "" : "muted"}`}>
                <label className="settings-field">
                  默认抄送人邮箱
                  <input
                    type="text"
                    disabled={!emailSettings.enabled}
                    value={emailSettings.ccEmails}
                    onChange={(event) =>
                      setEmailSettings((current) => ({
                        ...current,
                        ccEmails: event.target.value,
                      }))
                    }
                    placeholder="多个邮箱使用逗号分隔"
                  />
                  <small>新建会议时自动带入，仍可针对单场会议修改或清空。</small>
                </label>
              </section>

              <section className="mail-account-card">
                <span>发件邮箱</span>
                <strong>meetingalarm@163.com</strong>
                <i>实际发送状态以服务器 SMTP 配置为准</i>
              </section>

              <section className="settings-block mail-test-block">
                <label className="settings-field">
                  测试收件邮箱
                  <input
                    type="email"
                    value={testRecipient}
                    onChange={(event) => setTestRecipient(event.target.value)}
                    placeholder="输入用于接收测试邮件的地址"
                  />
                  <small>点击后会立即通过服务器的 163 SMTP 发送一封测试邮件。</small>
                </label>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!testRecipient || emailTestSending}
                  onClick={sendTestEmail}
                >
                  {emailTestSending ? "正在发送…" : "发送测试邮件"}
                </button>
                {emailTestStatus && <span className="mail-test-success">{emailTestStatus}</span>}
              </section>

              <section className="mail-rule-list">
                <h3>发送规则</h3>
                <div><span>发送时间</span><strong>会议开始前 10 分钟</strong></div>
                <div><span>主要收件人</span><strong>会议发起人邮箱</strong></div>
                <div><span>无邮箱成员</span><strong>仅展示屏提醒，不发邮件</strong></div>
              </section>

              <div className="settings-actions">
                <small>设置只对当前分组生效。</small>
                <button className="primary-button" onClick={saveEmailSettings}>
                  保存设置
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}

      {passwordSettingsOpen && (
        <div className="drawer-backdrop" onMouseDown={() => setPasswordSettingsOpen(false)}>
          <aside
            className="editor-drawer settings-drawer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <span className="eyebrow">SECURITY</span>
                <h2>修改管理员密码</h2>
              </div>
              <button onClick={() => setPasswordSettingsOpen(false)} aria-label="关闭密码设置">
                ×
              </button>
            </div>
            <form className="settings-content password-form" onSubmit={changePassword}>
              <p>修改后仅影响当前分组，其他组别的管理员密码不会改变。</p>
              {actionError && <span className="form-error">{actionError}</span>}
              <label className="settings-field">
                当前密码
                <input type="password" name="currentPassword" required autoComplete="current-password" />
              </label>
              <label className="settings-field">
                新密码
                <input
                  type="password"
                  name="newPassword"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
                <small>至少 6 位，建议使用字母、数字和符号组合。</small>
              </label>
              <label className="settings-field">
                再次输入新密码
                <input
                  type="password"
                  name="confirmation"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </label>
              <div className="settings-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setPasswordSettingsOpen(false)}
                >
                  取消
                </button>
                <button type="submit" className="primary-button">确认修改</button>
              </div>
            </form>
          </aside>
        </div>
      )}

      {viewing && (
        <div className="modal-backdrop" onMouseDown={() => setViewing(null)}>
          <article className="detail-card" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setViewing(null)} aria-label="关闭详情">×</button>
            <span className={`status-badge ${viewing.status}`}>{statusText[viewing.status]}</span>
            <h2>{viewing.title}</h2>
            <div className="detail-time">
              <strong>{viewing.start}</strong>
              <span>—</span>
              <strong>{viewing.end}</strong>
            </div>
            <dl>
              <div><dt>会议室</dt><dd>{viewing.room}</dd></div>
              <div><dt>发起人</dt><dd>{viewing.owner}</dd></div>
              <div>
                <dt>参会人数</dt>
                <dd>{viewing.participants ? `${viewing.participants} 人` : "未填写"}</dd>
              </div>
              <div><dt>重复规则</dt><dd>{viewing.type}</dd></div>
              <div><dt>提醒</dt><dd>{viewing.reminder ? "提前 10 分钟" : "未开启"}</dd></div>
              <div>
                <dt>邮件提醒</dt>
                <dd>
                  {!emailSettings.enabled
                    ? "全局已关闭"
                    : viewing.emailReminder
                      ? "已开启"
                      : "未开启"}
                </dd>
              </div>
            </dl>
            <button className="primary-button wide" onClick={() => {
              setViewing(null);
              openEdit(viewing);
            }}>编辑此会议</button>
          </article>
        </div>
      )}

      {deleting && (
        <div className="modal-backdrop">
          <article className="confirm-card">
            <Icon tone="danger">!</Icon>
            <h2>确认删除会议？</h2>
            <p>“{deleting.title}”将从本组会议中永久移除。</p>
            {actionError && <span className="form-error">{actionError}</span>}
            <div>
              <button className="ghost-button" onClick={() => setDeleting(null)}>取消</button>
              <button className="danger-button" onClick={confirmDelete}>确认删除</button>
            </div>
          </article>
        </div>
      )}
    </main>
  );
}
