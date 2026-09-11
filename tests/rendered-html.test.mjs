import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

function environment() {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  };
}

function context() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

test("renders the display, group admin and super admin routes", async () => {
  const worker = await loadWorker();
  const paths = [
    "/tools/work/meeting-alarm/group/haochezhu",
    "/tools/work/meeting-alarm/group/haochezhu/admin",
    "/tools/work/meeting-alarm/superadmin",
  ];

  for (const path of paths) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
      environment(),
      context(),
    );
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") || "", /^text\/html\b/i);
  }
});

test("does not expose former sample copy or passwords in client assets", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/tools/work/meeting-alarm/group/haochezhu", {
      headers: { accept: "text/html" },
    }),
    environment(),
    context(),
  );
  const html = await response.text();

  assert.doesNotMatch(html, /2026-07-24|前端原型|演示密码|产品晨会/);
  assert.match(html, /会议铃|MEETING BOARD/);
});

test("ships iPad mini, phone and legacy Safari display fallbacks", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");

  assert.match(css, /@media \(min-width: 721px\) and \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /grid-template-columns: repeat\(7, minmax\(78vw, 78vw\)\)/);
  assert.match(css, /min-height: -webkit-fill-available/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(layout, /viewportFit: "cover"/);
});

test("keeps sound enabled after refresh and separates the test action", async () => {
  const source = await readFile(new URL("../app/meeting-board.tsx", import.meta.url), "utf8");

  assert.match(source, /useState\(true\);/);
  assert.match(source, /function toggleReminderSound\(\)/);
  assert.match(source, /async function testReminderSound\(\)/);
  assert.match(source, />\s*测试声音\s*<\/button>/);
  assert.doesNotMatch(source, /if \(started\) setSoundEnabled\(true\)/);
});

test("uses a compact phone header and single-row reminder strip", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.display-mode \.summary-row \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.display-mode \.live-clock span \{\s*display: none;/);
  assert.match(css, /\.display-mode \.alert-strip \{\s*grid-template-columns: 36px minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.display-mode \.countdown \{\s*grid-column: auto;/);
});

test("uses a compact two-column meeting card without duplicate meeting type", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../app/meeting-board.tsx", import.meta.url), "utf8");

  assert.match(css, /grid-template-columns: 62px minmax\(0, 1fr\)/);
  assert.match(css, /grid-template-columns: auto minmax\(0, 1fr\) auto/);
  assert.match(source, /meeting\.status === "active" &&/);
  assert.doesNotMatch(source, /`已结束 · \$\{meeting\.type\}`/);
});

test("sends recipients as RFC-encoded display name and email address objects", async () => {
  const source = await readFile(new URL("../lib/meeting-mailer.ts", import.meta.url), "utf8");

  assert.match(source, /function recipientMailbox\(name: string, address: string\)/);
  assert.match(source, /name: name\.replace\(\/\[\\r\\n\]\+\/g, " "\)\.trim\(\)/);
  assert.match(source, /to: recipientMailbox\(organizer\.name, organizer\.email\)/);
  assert.match(source, /to: recipientMailbox\("管理员", recipient\)/);
  assert.doesNotMatch(source, /to: organizer\.email/);
});

test("uses the revised Chinese meeting reminder copy in text, HTML and UI preview", async () => {
  const mailer = await readFile(new URL("../lib/meeting-mailer.ts", import.meta.url), "utf8");
  const board = await readFile(new URL("../app/meeting-board.tsx", import.meta.url), "utf8");

  for (const source of [mailer, board]) {
    assert.match(source, /你申请的的/);
    assert.match(source, /请您及时召唤参会人前往/);
    assert.match(source, /超过10分钟会被通报/);
    assert.match(source, /会议室内面板及时释放/);
    assert.match(source, /会议开始并坐满10分后从面板上释放/);
  }
  assert.doesNotMatch(mailer, /MEETING REMINDER/);
  assert.doesNotMatch(mailer, /提醒你负责的/);
});

test("targets Safari 12 and avoids unsupported iPad mini 3 APIs", async () => {
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  const board = await readFile(new URL("../app/meeting-board.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/tools/work/meeting-alarm/group/haochezhu", {
      headers: { accept: "text/html" },
    }),
    environment(),
    context(),
  );
  const html = await response.text();

  assert.match(viteConfig, /target: "safari12"/);
  assert.match(viteConfig, /cssTarget: "safari12"/);
  assert.doesNotMatch(board, /\.replaceAll\(/);
  assert.match(layout, /legacySafariPolyfills/);
  assert.match(layout, /!Object\.hasOwn/);
  assert.match(layout, /!String\.prototype\.replaceAll/);
  assert.match(layout, /!String\.prototype\.matchAll/);
  assert.match(layout, /<head>[\s\S]*legacySafariPolyfills[\s\S]*<\/head>/);
  assert.ok(html.indexOf("replaceAll requires a global RegExp") >= 0);
  assert.ok(html.indexOf("replaceAll requires a global RegExp") < html.indexOf('id="_R_"'));
});

test("hides the unfinished voice meeting entry without removing its implementation", async () => {
  const source = await readFile(new URL("../app/meeting-board.tsx", import.meta.url), "utf8");

  assert.match(source, /const VOICE_ENTRY_VISIBLE = false/);
  assert.match(source, /!editing && VOICE_ENTRY_VISIBLE &&/);
  assert.match(source, /async function toggleVoiceRecording\(\)/);
  assert.doesNotMatch(source, /测试提醒与语音/);
  assert.match(source, /测试提醒与声音/);
});
