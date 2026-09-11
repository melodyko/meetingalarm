import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type MeetingStatus = "done" | "active" | "soon" | "upcoming";

export type Meeting = {
  id: number;
  date: string;
  title: string;
  room: string;
  start: string;
  end: string;
  owner: string;
  participants?: number;
  type: string;
  status: MeetingStatus;
  reminder: boolean;
  emailReminder?: boolean;
  ccEmails?: string[];
};

export type TeamMember = {
  id: number;
  name: string;
  email: string;
};

export type EmailSettings = {
  enabled: boolean;
  ccEmails: string;
};

export type MeetingGroup = {
  slug: string;
  name: string;
  passwordHash: string;
  meetings: Meeting[];
  members: TeamMember[];
  emailSettings: EmailSettings;
  emailDeliveryKeys: string[];
  authVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type Store = {
  version: 1;
  groups: MeetingGroup[];
};

const defaultRooms = [
  "财险大厦3702",
  "财险大厦3703",
  "财险大厦3704",
];

let writeQueue: Promise<unknown> = Promise.resolve();

function dataFilePath() {
  return (
    process.env.MEETING_DATA_FILE ||
    path.join(process.cwd(), "data", "meeting-board.json")
  );
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) {
    return new Uint8Array();
  }
  return new Uint8Array(value.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) || []);
}

function safeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: 150_000,
    },
    key,
    256,
  );
  return `pbkdf2-sha256:150000:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterationsValue, saltValue, hashValue] = encoded.split(":");
  if (algorithm !== "pbkdf2-sha256") return false;
  const iterations = Number(iterationsValue);
  const salt = hexToBytes(saltValue);
  const expected = hexToBytes(hashValue);
  if (!Number.isFinite(iterations) || iterations < 1 || salt.length === 0 || expected.length === 0) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    expected.length * 8,
  );
  return safeEqual(new Uint8Array(bits), expected);
}

async function createInitialStore(): Promise<Store> {
  const now = new Date().toISOString();
  const initialPassword = process.env.GROUP_ADMIN_INITIAL_PASSWORD || "123456";
  return {
    version: 1,
    groups: [
      {
        slug: "haochezhu",
        name: "好车主产品组",
        passwordHash: await hashPassword(initialPassword),
        meetings: [],
        members: [],
        emailSettings: { enabled: false, ccEmails: "" },
        emailDeliveryKeys: [],
        authVersion: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

async function saveStore(store: Store) {
  const file = dataFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function readStore(): Promise<Store> {
  const file = dataFilePath();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Store;
    if (parsed?.version !== 1 || !Array.isArray(parsed.groups)) {
      throw new Error("Unsupported meeting data format.");
    }
    parsed.groups.forEach((group) => {
      group.authVersion ||= 1;
      group.emailDeliveryKeys ||= [];
    });
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    const initial = await createInitialStore();
    await saveStore(initial);
    return initial;
  }
}

export async function updateStore<T>(mutator: (store: Store) => Promise<T> | T) {
  let result!: T;
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    result = await mutator(store);
    await saveStore(store);
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  return result;
}

export function publicGroup(group: MeetingGroup) {
  return {
    slug: group.slug,
    name: group.name,
    meetings: group.meetings,
    revision: group.revision,
    rooms: defaultRooms,
  };
}

export function adminGroup(group: MeetingGroup) {
  return {
    ...publicGroup(group),
    members: group.members,
    emailSettings: group.emailSettings,
  };
}

export function touchGroup(group: MeetingGroup) {
  group.revision += 1;
  group.updatedAt = new Date().toISOString();
}
