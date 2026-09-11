import nodemailer from "nodemailer";
import { readStore, updateStore } from "./meeting-store";

let deliveryQueue: Promise<unknown> = Promise.resolve();

function smtpConfiguration() {
  const user = process.env.SMTP_USER?.trim() || "";
  const pass = process.env.SMTP_PASS?.trim() || "";
  if (!user || !pass) {
    throw new Error("服务器尚未配置 SMTP_USER 和 SMTP_PASS");
  }
  const port = Number(process.env.SMTP_PORT || "465");
  return {
    host: process.env.SMTP_HOST?.trim() || "smtp.163.com",
    port,
    secure: (process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
    user,
    pass,
    from: process.env.SMTP_FROM?.trim() || `会议铃 <${user}>`,
  };
}

function createTransport() {
  const config = smtpConfiguration();
  return {
    config,
    transport: nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 20_000,
    }),
  };
}

function parseEmails(value: string | string[] | undefined) {
  const source = Array.isArray(value) ? value.join(",") : value || "";
  return Array.from(
    new Set(
      source
        .split(/[,，;\s]+/)
        .map((email) => email.trim())
        .filter(Boolean),
    ),
  );
}

function recipientMailbox(name: string, address: string) {
  return {
    name: name.replace(/[\r\n]+/g, " ").trim(),
    address: address.trim(),
  };
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] || character,
  );
}

function meetingMessage(input: {
  groupName: string;
  recipientName: string;
  title: string;
  room: string;
  date: string;
  start: string;
}) {
  const subject = `【会议提醒】${input.title} 即将开始`;
  const text = `会议提醒
${input.title}
${input.recipientName}，你好：

你申请的的“${input.title}”将于 ${input.date} ${input.start}
在 ${input.room} 开始，请您及时召唤参会人前往。

为避免影响会议安排及产生相关通报，请关注以下建议：
（1）会议开始提前前往，超过10分钟会被通报；
（2）会议提前结束时请在会议室内面板及时释放；
（3）若您当前会议已确定改期/取消，请您在会议开始并坐满10分后从面板上释放，谢谢！

本邮件由${input.groupName}会议看板自动发送，请勿直接回复。`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;color:#17332d;line-height:1.8;max-width:640px;margin:auto">
      <div style="padding:22px 26px;background:#103d35;color:#fff;border-radius:14px 14px 0 0">
        <div style="font-size:13px;opacity:.72;letter-spacing:.12em">会议提醒</div>
        <h1 style="font-size:24px;margin:8px 0 0">${escapeHtml(input.title)}</h1>
      </div>
      <div style="padding:28px 26px;border:1px solid #dfe5df;border-top:0;border-radius:0 0 14px 14px">
        <p>${escapeHtml(input.recipientName)}，你好：</p>
        <p>你申请的的“<strong>${escapeHtml(input.title)}</strong>”将于
          <strong>${escapeHtml(input.date)} ${escapeHtml(input.start)}</strong> 在
          <strong>${escapeHtml(input.room)}</strong> 开始，请您及时召唤参会人前往。</p>
        <div style="margin-top:20px;padding:16px 18px;background:#fff4df;border-left:3px solid #f4ba3f">
          <p style="margin:0 0 8px"><strong>为避免影响会议安排及产生相关通报，请关注以下建议：</strong></p>
          <p style="margin:4px 0">（1）会议开始提前前往，超过10分钟会被通报；</p>
          <p style="margin:4px 0">（2）会议提前结束时请在会议室内面板及时释放；</p>
          <p style="margin:4px 0">（3）若您当前会议已确定改期/取消，请您在会议开始并坐满10分后从面板上释放，谢谢！</p>
        </div>
        <p style="margin-top:26px;color:#82908c;font-size:13px">
          本邮件由${escapeHtml(input.groupName)}会议看板自动发送，请勿直接回复。
        </p>
      </div>
    </div>`;
  return { subject, text, html };
}

export async function sendTestMeetingEmail(recipient: string, groupName: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error("测试收件邮箱格式不正确");
  }
  const { config, transport } = createTransport();
  const message = meetingMessage({
    groupName,
    recipientName: "管理员",
    title: "会议铃邮件通道测试",
    room: "会议室",
    date: new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    start: new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date()),
  });
  await transport.sendMail({
    from: config.from,
    to: recipientMailbox("管理员", recipient),
    ...message,
  });
}

async function deliverDueEmails(groupSlug?: string) {
  const now = new Date();
  const store = await readStore();
  const groups = groupSlug
    ? store.groups.filter((group) => group.slug === groupSlug)
    : store.groups;

  for (const group of groups) {
    if (!group.emailSettings.enabled) continue;
    for (const meeting of group.meetings) {
      if (!meeting.emailReminder) continue;
      const startsAt = new Date(`${meeting.date}T${meeting.start}:00+08:00`);
      const millisecondsUntilStart = startsAt.getTime() - now.getTime();
      if (millisecondsUntilStart <= 0 || millisecondsUntilStart > 10 * 60 * 1000) {
        continue;
      }
      const deliveryKey = `${meeting.id}:${meeting.date}:${meeting.start}`;
      if (group.emailDeliveryKeys.includes(deliveryKey)) continue;
      const organizer = group.members.find((member) => member.name === meeting.owner);
      if (!organizer?.email) continue;

      const { config, transport } = createTransport();
      const message = meetingMessage({
        groupName: group.name,
        recipientName: organizer.name,
        title: meeting.title,
        room: meeting.room,
        date: meeting.date,
        start: meeting.start,
      });
      await transport.sendMail({
        from: config.from,
        to: recipientMailbox(organizer.name, organizer.email),
        cc: parseEmails(
          meeting.ccEmails?.length ? meeting.ccEmails : group.emailSettings.ccEmails,
        ),
        ...message,
      });
      await updateStore((latest) => {
        const target = latest.groups.find((item) => item.slug === group.slug);
        if (!target || target.emailDeliveryKeys.includes(deliveryKey)) return;
        target.emailDeliveryKeys.push(deliveryKey);
        if (target.emailDeliveryKeys.length > 1000) {
          target.emailDeliveryKeys = target.emailDeliveryKeys.slice(-1000);
        }
      });
    }
  }
}

export function processDueMeetingEmails(groupSlug?: string) {
  const operation = deliveryQueue.then(() => deliverDueEmails(groupSlug));
  deliveryQueue = operation.catch((error) => {
    console.error("[meeting-mailer] Email delivery failed:", error);
  });
  return deliveryQueue;
}
