import { describe, expect, it } from "vitest";
import type { SyncStatus } from "../bindings";
import { MockBackend } from "./mock-backend";
import {
  ALREADY_LINKED,
  MOCK_SYNC_LIMITED_EMAIL,
  MOCK_SYNC_NO_MAIL,
  MOCK_SYNC_RESET_CODE,
  MOCK_SYNC_TAKEN_EMAIL,
  MOCK_SYNC_UNREACHABLE,
  MOCK_SYNC_WRONG_PASSWORD,
  normalizeEmail,
  normalizeServerUrl,
} from "./mock-sync";

const SERVER = "https://sync.example.com";
const PASSWORD = "un mot de passe assez long";

const fixedNow = () => new Date("2026-10-04T10:00:00.000Z");

describe("mock sync", () => {
  it("links, syncs, changes the interval and unlinks, emitting sync-changed", async () => {
    const backend = new MockBackend({ seed: false, now: fixedNow });
    const seen: SyncStatus[] = [];
    await backend.events.syncChanged.listen((e) => seen.push(e.payload.status));
    const c = backend.commands;
    expect((await c.syncStatus()).state).toBe("unlinked");
    expect((await c.syncNow()).state).toBe("unlinked");
    expect(await c.syncAccount()).toBeNull();
    const linked = await c.syncLogin({
      serverUrl: " https://sync.example.com/ ",
      email: " User@Exemple.fr ",
      password: "secret",
    });
    expect(await c.syncAccount()).toEqual({
      email: "user@exemple.fr",
      emailVerified: true,
    });
    expect(linked).toEqual({
      state: "idle",
      serverUrl: "https://sync.example.com",
      intervalMinutes: 5,
      lastSyncAt: "2026-10-04T10:00:00.000Z",
      errorKind: null,
      pending: 0,
    });
    await c.syncNow();
    expect(seen.map((s) => s.state)).toEqual(["idle", "syncing", "idle"]);
    expect((await c.syncSetInterval(15)).intervalMinutes).toBe(15);
    await expect(c.syncSetInterval(7)).rejects.toMatchObject({
      kind: "invalid",
    });
    const unlinked = await c.syncUnlink();
    expect(unlinked.state).toBe("unlinked");
    expect(unlinked.serverUrl).toBe("https://sync.example.com");
    expect(await c.syncAccount()).toBeNull();
  });

  it("signs up a new account", async () => {
    const c = new MockBackend({ seed: false, now: fixedNow }).commands;
    const status = await c.syncSignup({
      serverUrl: SERVER,
      email: "nouveau@exemple.fr",
      password: PASSWORD,
    });
    expect(status.state).toBe("idle");
    expect(await c.syncAccount()).toEqual({
      email: "nouveau@exemple.fr",
      emailVerified: false,
    });
  });

  it("gives each account error its kind", async () => {
    const c = new MockBackend({ seed: false }).commands;
    const account = (email: string, password = PASSWORD) => ({
      serverUrl: SERVER,
      email,
      password,
    });
    await expect(
      c.syncSignup(account(MOCK_SYNC_TAKEN_EMAIL)),
    ).rejects.toMatchObject({ kind: "sync_email_taken" });
    await expect(
      c.syncSignup(account("nouveau@exemple.fr", "court")),
    ).rejects.toMatchObject({ kind: "sync_weak_password" });
    await expect(
      c.syncSignup(account("pas-une-adresse")),
    ).rejects.toMatchObject({ kind: "sync_bad_email" });
    await expect(
      c.syncLogin(account("user@exemple.fr", MOCK_SYNC_WRONG_PASSWORD)),
    ).rejects.toMatchObject({ kind: "sync_auth" });
    await expect(
      c.syncLogin(account(MOCK_SYNC_LIMITED_EMAIL)),
    ).rejects.toMatchObject({ kind: "sync_rate_limited" });
    await expect(
      c.syncForgotPassword({
        serverUrl: `https://${MOCK_SYNC_NO_MAIL}.example`,
        email: "user@exemple.fr",
      }),
    ).rejects.toMatchObject({ kind: "sync_mail_unavailable" });
    await expect(
      c.syncResetPassword({
        serverUrl: SERVER,
        email: "user@exemple.fr",
        code: "000000",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ kind: "sync_invalid_code" });
    expect((await c.syncStatus()).state).toBe("unlinked");
  });

  it("refuses to join another account while linked", async () => {
    const c = new MockBackend({ seed: false }).commands;
    await c.syncLogin({
      serverUrl: SERVER,
      email: "user@exemple.fr",
      password: PASSWORD,
    });
    const other = {
      serverUrl: SERVER,
      email: "autre@exemple.fr",
      password: PASSWORD,
    };
    await expect(c.syncLogin(other)).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining(ALREADY_LINKED),
    });
    await expect(c.syncSignup(other)).rejects.toMatchObject({
      kind: "invalid",
    });
    expect((await c.syncAccount())?.email).toBe("user@exemple.fr");
    // A re-login to the same account (any case) is allowed.
    await c.syncLogin({
      serverUrl: SERVER,
      email: " User@Exemple.FR ",
      password: PASSWORD,
    });
    // After « Se déconnecter », another account is allowed.
    await c.syncUnlink();
    expect((await c.syncSignup(other)).state).toBe("idle");
    expect((await c.syncAccount())?.email).toBe("autre@exemple.fr");
  });

  it("resets a forgotten password with the code, then logs in", async () => {
    const c = new MockBackend({ seed: false }).commands;
    const email = "user@exemple.fr";
    expect(await c.syncForgotPassword({ serverUrl: SERVER, email })).toBeNull();
    expect(
      await c.syncResetPassword({
        serverUrl: SERVER,
        email,
        code: MOCK_SYNC_RESET_CODE,
        password: PASSWORD,
      }),
    ).toBeNull();
    const status = await c.syncLogin({
      serverUrl: SERVER,
      email,
      password: PASSWORD,
    });
    expect(status.state).toBe("idle");
  });

  it("refuses bad addresses, wrong passwords and unreachable servers", async () => {
    const c = new MockBackend({ seed: false }).commands;
    const email = "user@exemple.fr";
    await expect(
      c.syncLogin({ serverUrl: "sync.example.com", email, password: "x" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      c.syncLogin({
        serverUrl: "https://sync.example.com",
        email,
        password: MOCK_SYNC_WRONG_PASSWORD,
      }),
    ).rejects.toMatchObject({ kind: "sync_auth" });
    await expect(
      c.syncLogin({
        serverUrl: `https://${MOCK_SYNC_UNREACHABLE}.example`,
        email,
        password: "x",
      }),
    ).rejects.toMatchObject({ kind: "sync_offline" });
    expect((await c.syncStatus()).state).toBe("unlinked");
  });

  it("normalizes e-mail addresses like the server", () => {
    expect(normalizeEmail("  User@Exemple.FR ")).toBe("user@exemple.fr");
    expect(normalizeEmail("user@exemple")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });

  it("normalizes server addresses like the core", () => {
    expect(normalizeServerUrl("https://a.b/")).toBe("https://a.b");
    expect(normalizeServerUrl("http://127.0.0.1:3020")).toBe(
      "http://127.0.0.1:3020",
    );
    expect(normalizeServerUrl("http://localhost:3020/")).toBe(
      "http://localhost:3020",
    );
    expect(normalizeServerUrl("http://sync.example.com")).toBeNull();
    expect(normalizeServerUrl("")).toBeNull();
  });
});
