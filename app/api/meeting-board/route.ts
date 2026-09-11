import {
  adminGroup,
  hashPassword,
  publicGroup,
  readStore,
  touchGroup,
  updateStore,
  verifyPassword,
  type EmailSettings,
  type Meeting,
  type TeamMember,
} from "../../../lib/meeting-store";
import {
  processDueMeetingEmails,
  sendTestMeetingEmail,
} from "../../../lib/meeting-mailer";
import {
  recognizeVoiceMeeting,
  voiceAgentConfigured,
} from "../../../lib/meeting-voice-agent";

export const dynamic = "force-dynamic";

type SessionPayload = {
  scope: "group" | "super";
  group?: string;
  authVersion?: number;
  expiresAt: number;
};

const slugPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return Response.json(data, { ...init, headers });
}

function sessionSecret() {
  return (
    process.env.SESSION_SECRET ||
    process.env.SUPER_ADMIN_PASSWORD ||
    process.env.GROUP_ADMIN_INITIAL_PASSWORD ||
    "meeting-board-development-secret-change-in-production"
  );
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sign(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
  );
}

async function createToken(payload: SessionPayload) {
  const encoded = encodeURIComponent(JSON.stringify(payload));
  return `${encoded}.${await sign(encoded)}`;
}

async function verifyToken(value: string | undefined) {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!safeEqual(signature, await sign(encoded))) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(encoded)) as SessionPayload;
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieMap(request: Request) {
  return new Map(
    (request.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );
}

function groupCookieName(group: string) {
  return `meeting_group_${group}`;
}

async function isSuperAdmin(request: Request) {
  const token = cookieMap(request).get("meeting_super");
  return (await verifyToken(token))?.scope === "super";
}

async function canManageGroup(request: Request, group: string) {
  if (await isSuperAdmin(request)) return true;
  const token = cookieMap(request).get(groupCookieName(group));
  const payload = await verifyToken(token);
  if (payload?.scope !== "group" || payload.group !== group) return false;
  const store = await readStore();
  const target = store.groups.find((item) => item.slug === group);
  return Boolean(target && payload.authVersion === target.authVersion);
}

function cookieHeader(
  request: Request,
  name: string,
  value: string,
  maxAge = 12 * 60 * 60,
) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function validMeeting(value: unknown): value is Meeting {
  if (!value || typeof value !== "object") return false;
  const meeting = value as Partial<Meeting>;
  return Boolean(
    Number.isFinite(meeting.id) &&
      typeof meeting.title === "string" &&
      meeting.title.trim() &&
      typeof meeting.room === "string" &&
      meeting.room.trim() &&
      typeof meeting.owner === "string" &&
      meeting.owner.trim() &&
      typeof meeting.date === "string" &&
      datePattern.test(meeting.date) &&
      typeof meeting.start === "string" &&
      timePattern.test(meeting.start) &&
      typeof meeting.end === "string" &&
      timePattern.test(meeting.end) &&
      meeting.start < meeting.end,
  );
}

function groupAdminPayload(group: Parameters<typeof adminGroup>[0]) {
  return {
    ...adminGroup(group),
    voiceAgentConfigured: voiceAgentConfigured(),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get("super") === "1") {
    if (!(await isSuperAdmin(request))) {
      return json({ error: "未登录或登录已过期" }, { status: 401 });
    }
    const store = await readStore();
    return json({
      groups: store.groups.map((group) => ({
        slug: group.slug,
        name: group.name,
        meetingCount: group.meetings.length,
        memberCount: group.members.length,
        createdAt: group.createdAt,
      })),
      meetings: store.groups
        .flatMap((group) =>
          group.meetings.map((meeting) => ({
            ...meeting,
            groupSlug: group.slug,
            groupName: group.name,
          })),
        )
        .sort((left, right) =>
          `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`),
        ),
    });
  }

  const groupSlug = url.searchParams.get("group") || "";
  if (!slugPattern.test(groupSlug)) {
    return json({ error: "分组地址不正确" }, { status: 400 });
  }
  const store = await readStore();
  const group = store.groups.find((item) => item.slug === groupSlug);
  if (!group) return json({ error: "分组不存在" }, { status: 404 });
  await processDueMeetingEmails(groupSlug);

  if (url.searchParams.get("admin") === "1") {
    if (!(await canManageGroup(request, groupSlug))) {
      return json({ error: "未登录或登录已过期" }, { status: 401 });
    }
    return json(groupAdminPayload(group));
  }
  return json(publicGroup(group));
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "请求内容不是有效的 JSON" }, { status: 400 });
  }

  const action = String(body.action || "");
  const groupSlug = String(body.group || "");

  if (action === "login") {
    if (!slugPattern.test(groupSlug) || typeof body.password !== "string") {
      return json({ error: "请输入正确的分组和密码" }, { status: 400 });
    }
    const store = await readStore();
    const group = store.groups.find((item) => item.slug === groupSlug);
    if (!group || !(await verifyPassword(body.password, group.passwordHash))) {
      return json({ error: "管理员密码不正确" }, { status: 401 });
    }
    const token = await createToken({
      scope: "group",
      group: groupSlug,
      authVersion: group.authVersion,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    });
    return json(
      { ok: true, group: groupAdminPayload(group) },
      { headers: { "Set-Cookie": cookieHeader(request, groupCookieName(groupSlug), token) } },
    );
  }

  if (action === "superLogin") {
    const configuredPassword = process.env.SUPER_ADMIN_PASSWORD;
    if (!configuredPassword) {
      return json(
        { error: "服务器尚未配置 SUPER_ADMIN_PASSWORD" },
        { status: 503 },
      );
    }
    if (typeof body.password !== "string" || !safeEqual(body.password, configuredPassword)) {
      return json({ error: "超级管理员密码不正确" }, { status: 401 });
    }
    const token = await createToken({
      scope: "super",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    });
    return json(
      { ok: true },
      { headers: { "Set-Cookie": cookieHeader(request, "meeting_super", token, 8 * 60 * 60) } },
    );
  }

  if (action === "logout") {
    const scope = body.scope === "super" ? "super" : "group";
    const name = scope === "super" ? "meeting_super" : groupCookieName(groupSlug);
    return json(
      { ok: true },
      { headers: { "Set-Cookie": cookieHeader(request, name, "", 0) } },
    );
  }

  const superActions = new Set(["createGroup", "deleteGroup", "resetGroupPassword"]);
  if (superActions.has(action)) {
    if (!(await isSuperAdmin(request))) {
      return json({ error: "无超级管理员权限" }, { status: 403 });
    }

    if (action === "createGroup") {
      const slug = String(body.slug || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      if (!slugPattern.test(slug)) {
        return json({ error: "组别标识需为 2–40 位小写字母、数字或连字符" }, { status: 400 });
      }
      if (!name || password.length < 6) {
        return json({ error: "请填写组别名称，并设置至少 6 位的初始密码" }, { status: 400 });
      }
      const created = await updateStore(async (store) => {
        if (store.groups.some((group) => group.slug === slug)) return null;
        const now = new Date().toISOString();
        const group = {
          slug,
          name,
          passwordHash: await hashPassword(password),
          meetings: [],
          members: [],
          emailSettings: { enabled: false, ccEmails: "" },
          emailDeliveryKeys: [],
          authVersion: 1,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        store.groups.push(group);
        return { slug: group.slug, name: group.name };
      });
      if (!created) return json({ error: "该组别标识已经存在" }, { status: 409 });
      return json({ ok: true, group: created });
    }

    if (!slugPattern.test(groupSlug)) {
      return json({ error: "组别标识不正确" }, { status: 400 });
    }
    if (action === "deleteGroup") {
      const deleted = await updateStore((store) => {
        const before = store.groups.length;
        store.groups = store.groups.filter((group) => group.slug !== groupSlug);
        return store.groups.length !== before;
      });
      return deleted
        ? json({ ok: true })
        : json({ error: "组别不存在" }, { status: 404 });
    }
    const password = String(body.password || "");
    if (password.length < 6) {
      return json({ error: "新密码至少需要 6 位" }, { status: 400 });
    }
    const changed = await updateStore(async (store) => {
      const group = store.groups.find((item) => item.slug === groupSlug);
      if (!group) return false;
      group.passwordHash = await hashPassword(password);
      group.authVersion += 1;
      touchGroup(group);
      return true;
    });
    return changed
      ? json({ ok: true })
      : json({ error: "组别不存在" }, { status: 404 });
  }

  if (!slugPattern.test(groupSlug) || !(await canManageGroup(request, groupSlug))) {
    return json({ error: "无本组管理员权限" }, { status: 403 });
  }

  if (action === "changePassword") {
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 6) {
      return json({ error: "新密码至少需要 6 位" }, { status: 400 });
    }
    const result = await updateStore(async (store) => {
      const group = store.groups.find((item) => item.slug === groupSlug);
      if (!group) return "missing";
      if (!(await verifyPassword(currentPassword, group.passwordHash))) return "wrong";
      group.passwordHash = await hashPassword(newPassword);
      group.authVersion += 1;
      touchGroup(group);
      return group.authVersion;
    });
    if (result === "wrong") return json({ error: "当前密码不正确" }, { status: 400 });
    if (result === "missing") return json({ error: "组别不存在" }, { status: 404 });
    const token = await createToken({
      scope: "group",
      group: groupSlug,
      authVersion: result,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    });
    return json(
      { ok: true },
      { headers: { "Set-Cookie": cookieHeader(request, groupCookieName(groupSlug), token) } },
    );
  }

  if (action === "testEmail") {
    const recipient = String(body.recipient || "").trim();
    const store = await readStore();
    const group = store.groups.find((item) => item.slug === groupSlug);
    if (!group) return json({ error: "组别不存在" }, { status: 404 });
    try {
      await sendTestMeetingEmail(recipient, group.name);
      return json({ ok: true, message: `测试邮件已发送至 ${recipient}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      return json({ error: `邮件发送失败：${message}` }, { status: 502 });
    }
  }

  if (action === "recognizeVoiceMeeting") {
    const store = await readStore();
    const group = store.groups.find((item) => item.slug === groupSlug);
    if (!group) return json({ error: "组别不存在" }, { status: 404 });
    try {
      const meeting = await recognizeVoiceMeeting({
        audioBase64: String(body.audioBase64 || ""),
        mimeType: String(body.mimeType || "audio/webm"),
        groupName: group.name,
        rooms: publicGroup(group).rooms,
        members: group.members,
      });
      return json({ ok: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : "语音识别失败";
      return json({ error: message }, { status: 502 });
    }
  }

  if (action === "saveMeeting") {
    if (!validMeeting(body.meeting)) {
      return json({ error: "会议信息不完整或时间范围不正确" }, { status: 400 });
    }
    const meeting = body.meeting;
    const group = await updateStore((store) => {
      const target = store.groups.find((item) => item.slug === groupSlug);
      if (!target) return null;
      const index = target.meetings.findIndex((item) => item.id === meeting.id);
      if (index >= 0) target.meetings[index] = meeting;
      else target.meetings.push(meeting);
      target.meetings.sort(
        (left, right) =>
          left.date.localeCompare(right.date) || left.start.localeCompare(right.start),
      );
      touchGroup(target);
      return adminGroup(target);
    });
    return group ? json({ ok: true, group }) : json({ error: "组别不存在" }, { status: 404 });
  }

  if (action === "deleteMeeting") {
    const meetingId = Number(body.meetingId);
    const group = await updateStore((store) => {
      const target = store.groups.find((item) => item.slug === groupSlug);
      if (!target) return null;
      target.meetings = target.meetings.filter((meeting) => meeting.id !== meetingId);
      touchGroup(target);
      return adminGroup(target);
    });
    return group ? json({ ok: true, group }) : json({ error: "组别不存在" }, { status: 404 });
  }

  if (action === "saveMember") {
    const value = body.member as Partial<TeamMember> | undefined;
    const name = String(value?.name || "").trim();
    const email = String(value?.email || "").trim();
    const id = Number(value?.id) || Date.now();
    if (!name) return json({ error: "成员姓名不能为空" }, { status: 400 });
    const group = await updateStore((store) => {
      const target = store.groups.find((item) => item.slug === groupSlug);
      if (!target) return null;
      const member = { id, name, email };
      const index = target.members.findIndex((item) => item.id === id);
      if (index >= 0) target.members[index] = member;
      else target.members.push(member);
      touchGroup(target);
      return adminGroup(target);
    });
    return group ? json({ ok: true, group }) : json({ error: "组别不存在" }, { status: 404 });
  }

  if (action === "importMembers") {
    const values = Array.isArray(body.members) ? body.members : [];
    if (values.length === 0 || values.length > 1000) {
      return json({ error: "导入名单需包含 1–1000 位成员" }, { status: 400 });
    }
    const normalized = values
      .map((value) => {
        const member = value as Partial<TeamMember>;
        return {
          name: String(member.name || "").trim(),
          email: String(member.email || "").trim(),
        };
      })
      .filter((member) => member.name);
    if (normalized.length === 0) {
      return json({ error: "文件中没有识别到有效姓名" }, { status: 400 });
    }
    const invalidEmail = normalized.find(
      (member) =>
        member.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email),
    );
    if (invalidEmail) {
      return json({ error: `${invalidEmail.name} 的邮箱格式不正确` }, { status: 400 });
    }
    const imported = await updateStore((store) => {
      const target = store.groups.find((item) => item.slug === groupSlug);
      if (!target) return null;
      let added = 0;
      let updated = 0;
      normalized.forEach((value, index) => {
        const existing = target.members.find(
          (member) => member.name.trim().toLocaleLowerCase() === value.name.toLocaleLowerCase(),
        );
        if (existing) {
          if (value.email) existing.email = value.email;
          existing.name = value.name;
          updated += 1;
        } else {
          target.members.push({
            id: Date.now() + index,
            name: value.name,
            email: value.email,
          });
          added += 1;
        }
      });
      target.members.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
      touchGroup(target);
      return { group: groupAdminPayload(target), added, updated };
    });
    return imported
      ? json({
          ok: true,
          group: imported.group,
          message: `导入完成：新增 ${imported.added} 人，更新 ${imported.updated} 人`,
        })
      : json({ error: "组别不存在" }, { status: 404 });
  }

  if (action === "deleteMember") {
    const memberId = Number(body.memberId);
    const group = await updateStore((store) => {
      const target = store.groups.find((item) => item.slug === groupSlug);
      if (!target) return null;
      target.members = target.members.filter((member) => member.id !== memberId);
      touchGroup(target);
      return adminGroup(target);
    });
    return group ? json({ ok: true, group }) : json({ error: "组别不存在" }, { status: 404 });
  }

  if (action === "saveEmailSettings") {
    const value = body.settings as Partial<EmailSettings> | undefined;
    const group = await updateStore((store) => {
      const target = store.groups.find((item) => item.slug === groupSlug);
      if (!target) return null;
      target.emailSettings = {
        enabled: Boolean(value?.enabled),
        ccEmails: String(value?.ccEmails || "").trim(),
      };
      touchGroup(target);
      return adminGroup(target);
    });
    return group ? json({ ok: true, group }) : json({ error: "组别不存在" }, { status: 404 });
  }

  return json({ error: "不支持的操作" }, { status: 400 });
}
