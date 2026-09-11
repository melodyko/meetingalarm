"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Meeting, MeetingStatus } from "../lib/meeting-store";

type GroupSummary = {
  slug: string;
  name: string;
  meetingCount: number;
  memberCount: number;
  createdAt: string;
};

type GlobalMeeting = Meeting & {
  groupSlug: string;
  groupName: string;
};

type SuperPayload = {
  groups: GroupSummary[];
  meetings: GlobalMeeting[];
};

function getStatus(meeting: Meeting): MeetingStatus {
  const now = Date.now();
  const start = new Date(`${meeting.date}T${meeting.start}:00+08:00`).getTime();
  const end = new Date(`${meeting.date}T${meeting.end}:00+08:00`).getTime();
  if (now >= end) return "done";
  if (now >= start) return "active";
  if (start - now <= 10 * 60 * 1000) return "soon";
  return "upcoming";
}

const statusLabels: Record<MeetingStatus, string> = {
  done: "已结束",
  active: "进行中",
  soon: "即将开始",
  upcoming: "待开始",
};

export default function SuperAdmin() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [data, setData] = useState<SuperPayload>({ groups: [], meetings: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [query, setQuery] = useState("");
  const [resetting, setResetting] = useState<GroupSummary | null>(null);
  const [deleting, setDeleting] = useState<GroupSummary | null>(null);

  async function loadData() {
    const response = await fetch("/api/meeting-board?super=1", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) {
      setAuthenticated(false);
      return false;
    }
    const payload = (await response.json()) as SuperPayload & { error?: string };
    if (!response.ok) throw new Error(payload.error || "数据加载失败");
    setData(payload);
    setAuthenticated(true);
    return true;
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadData()
        .catch((caught: Error) => setError(caught.message))
        .finally(() => setChecking(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function post(body: Record<string, unknown>) {
    setError("");
    setNotice("");
    const response = await fetch("/api/meeting-board", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(payload.error || "操作失败");
    return payload;
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    try {
      await post({ action: "superLogin", password });
      await loadData();
      setPassword("");
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await post({
        action: "createGroup",
        slug: String(values.get("slug") || ""),
        name: String(values.get("name") || ""),
        password: String(values.get("password") || ""),
      });
      form.reset();
      await loadData();
      setNotice("新组别已创建，可以立即使用对应地址访问。");
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetting) return;
    const values = new FormData(event.currentTarget);
    const nextPassword = String(values.get("password") || "");
    const confirmation = String(values.get("confirmation") || "");
    if (nextPassword !== confirmation) {
      setError("两次输入的新密码不一致");
      return;
    }
    try {
      await post({
        action: "resetGroupPassword",
        group: resetting.slug,
        password: nextPassword,
      });
      setResetting(null);
      setNotice(`${resetting.name}的管理员密码已重置。`);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function deleteGroup() {
    if (!deleting) return;
    try {
      await post({ action: "deleteGroup", group: deleting.slug });
      setDeleting(null);
      setGroupFilter((current) => (current === deleting.slug ? "" : current));
      await loadData();
      setNotice("组别及其会议、人员和设置已删除。");
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function logout() {
    await post({ action: "logout", scope: "super" });
    setAuthenticated(false);
    setData({ groups: [], meetings: [] });
  }

  const visibleMeetings = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return data.meetings.filter((meeting) => {
      const matchesGroup = !groupFilter || meeting.groupSlug === groupFilter;
      const matchesQuery =
        !keyword ||
        meeting.title.toLowerCase().includes(keyword) ||
        meeting.owner.toLowerCase().includes(keyword) ||
        meeting.room.toLowerCase().includes(keyword);
      return matchesGroup && matchesQuery;
    });
  }, [data.meetings, groupFilter, query]);

  if (checking) {
    return (
      <main className="super-shell super-loading">
        <span className="brand-mark large">会</span>
        <p>正在验证管理权限…</p>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="super-shell super-login">
        <section className="super-login-copy">
          <span className="eyebrow">MEETING ALARM CONTROL</span>
          <h1>会议铃<br />总控中心</h1>
          <p>集中维护组别与管理员凭证，同时查看所有团队的会议安排。</p>
        </section>
        <form className="super-login-card" onSubmit={login}>
          <span className="brand-mark large">会</span>
          <span className="eyebrow">SUPER ADMIN</span>
          <h2>超级管理员登录</h2>
          <p>密码只在服务器端校验，不会写入页面代码。</p>
          <label>
            超级管理员密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
              autoComplete="current-password"
              placeholder="请输入密码"
            />
          </label>
          {error && <span className="form-error">{error}</span>}
          <button className="primary-button wide" type="submit">进入总控中心</button>
          <Link href="/tools/work/meeting-alarm/group/haochezhu">返回会议看板</Link>
        </form>
      </main>
    );
  }

  return (
    <main className="super-dashboard">
      <header className="super-topbar">
        <div>
          <span className="brand-mark">会</span>
          <div>
            <span className="eyebrow">MEETING ALARM CONTROL</span>
            <h1>超级管理员</h1>
          </div>
        </div>
        <button className="ghost-button" onClick={logout}>退出登录</button>
      </header>

      <section className="super-content">
        {(error || notice) && (
          <div className={`super-message ${error ? "error" : "success"}`}>
            <span>{error || notice}</span>
            <button onClick={() => { setError(""); setNotice(""); }}>×</button>
          </div>
        )}

        <section className="super-stats">
          <article><span>组别总数</span><strong>{data.groups.length}</strong></article>
          <article><span>全部会议</span><strong>{data.meetings.length}</strong></article>
          <article>
            <span>今日会议</span>
            <strong>
              {data.meetings.filter((meeting) => {
                const today = new Intl.DateTimeFormat("en-CA", {
                  timeZone: "Asia/Shanghai",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(new Date());
                return meeting.date === today;
              }).length}
            </strong>
          </article>
          <article>
            <span>名单人数</span>
            <strong>{data.groups.reduce((sum, group) => sum + group.memberCount, 0)}</strong>
          </article>
        </section>

        <section className="super-grid">
          <div className="super-panel">
            <div className="super-panel-heading">
              <div><span className="eyebrow">GROUPS</span><h2>组别管理</h2></div>
              <small>各组数据与密码相互独立</small>
            </div>
            <div className="group-list">
              {data.groups.map((group) => (
                <article key={group.slug}>
                  <span className="group-avatar">{group.name.slice(0, 1)}</span>
                  <div>
                    <strong>{group.name}</strong>
                    <code>/group/{group.slug}</code>
                    <small>{group.meetingCount} 场会议 · {group.memberCount} 位成员</small>
                  </div>
                  <div className="group-actions">
                    <a
                      href={`/tools/work/meeting-alarm/group/${group.slug}/admin`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      管理页
                    </a>
                    <button onClick={() => { setError(""); setResetting(group); }}>重置密码</button>
                    <button className="danger-link" onClick={() => setDeleting(group)}>删除</button>
                  </div>
                </article>
              ))}
              {data.groups.length === 0 && <p className="super-empty">还没有任何组别。</p>}
            </div>
          </div>

          <form className="super-panel create-group-card" onSubmit={createGroup}>
            <div className="super-panel-heading">
              <div><span className="eyebrow">NEW GROUP</span><h2>新增组别</h2></div>
            </div>
            <label>
              组别名称
              <input name="name" required placeholder="例如：设计组" />
            </label>
            <label>
              地址标识
              <div className="slug-input">
                <span>/group/</span>
                <input
                  name="slug"
                  required
                  minLength={2}
                  maxLength={40}
                  pattern="[a-z0-9][a-z0-9-]+"
                  placeholder="design"
                />
              </div>
              <small>只能填写小写字母、数字和连字符，创建后不可修改。</small>
            </label>
            <label>
              初始管理员密码
              <input name="password" type="password" required minLength={6} autoComplete="new-password" />
            </label>
            <button className="primary-button wide" type="submit">创建组别</button>
          </form>
        </section>

        <section className="super-panel all-meetings">
          <div className="super-panel-heading">
            <div><span className="eyebrow">ALL MEETINGS</span><h2>全部分组会议</h2></div>
            <strong>{visibleMeetings.length} 条记录</strong>
          </div>
          <div className="super-filters">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会议、发起人或会议室"
            />
            <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="">全部组别</option>
              {data.groups.map((group) => (
                <option value={group.slug} key={group.slug}>{group.name}</option>
              ))}
            </select>
          </div>
          <div className="super-table-wrap">
            <table className="super-table">
              <thead>
                <tr>
                  <th>日期与时间</th>
                  <th>组别</th>
                  <th>会议</th>
                  <th>会议室</th>
                  <th>发起人</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {visibleMeetings.map((meeting) => {
                  const status = getStatus(meeting);
                  return (
                    <tr key={`${meeting.groupSlug}-${meeting.id}`}>
                      <td><strong>{meeting.date}</strong><span>{meeting.start}–{meeting.end}</span></td>
                      <td><i>{meeting.groupName}</i></td>
                      <td><strong>{meeting.title}</strong></td>
                      <td>{meeting.room}</td>
                      <td>{meeting.owner}</td>
                      <td><span className={`status-badge ${status}`}>{statusLabels[status]}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleMeetings.length === 0 && (
              <div className="super-empty">当前筛选条件下没有会议记录。</div>
            )}
          </div>
        </section>
      </section>

      {resetting && (
        <div className="modal-backdrop" onMouseDown={() => setResetting(null)}>
          <form className="confirm-card super-dialog" onSubmit={resetPassword} onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">RESET PASSWORD</span>
            <h2>重置{resetting.name}密码</h2>
            <p>重置后，原管理员密码将立即失效。</p>
            {error && <span className="form-error">{error}</span>}
            <label>新密码<input name="password" type="password" required minLength={6} autoComplete="new-password" /></label>
            <label>再次输入<input name="confirmation" type="password" required minLength={6} autoComplete="new-password" /></label>
            <div>
              <button type="button" className="ghost-button" onClick={() => setResetting(null)}>取消</button>
              <button type="submit" className="primary-button">确认重置</button>
            </div>
          </form>
        </div>
      )}

      {deleting && (
        <div className="modal-backdrop" onMouseDown={() => setDeleting(null)}>
          <article className="confirm-card super-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <span className="text-icon danger">!</span>
            <h2>删除{deleting.name}？</h2>
            <p>该组的会议、人员名单和设置都会被永久删除，此操作不可恢复。</p>
            {error && <span className="form-error">{error}</span>}
            <div>
              <button className="ghost-button" onClick={() => setDeleting(null)}>取消</button>
              <button className="danger-button" onClick={deleteGroup}>确认删除</button>
            </div>
          </article>
        </div>
      )}
    </main>
  );
}
