/** The service worker's navigation handler (mobile/sw.js, docs/SYNC.md § 6.5). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type FetchEvent = {
  request: { method: string; url: string; mode: string };
  respondWith: (r: Promise<Response>) => void;
};

function loadWorker(network: () => Promise<Response>) {
  const source = readFileSync(join(process.cwd(), "mobile", "sw.js"), "utf8");
  const handlers: Record<string, (e: FetchEvent) => void> = {};
  const self = {
    location: { origin: "https://todo.test" },
    addEventListener: (type: string, h: (e: FetchEvent) => void) => {
      handlers[type] = h;
    },
  };
  const app = new Response("<html>app</html>", { status: 200 });
  const caches = {
    match: async (key: string) => (key === "/index.html" ? app.clone() : null),
  };
  new Function(
    "self",
    "caches",
    "fetch",
    `const BUILD = "0000000000000000"; const PRECACHE = [];\n${source}`,
  )(self, caches, network);
  return async (): Promise<Response> => {
    let response: Promise<Response> | null = null;
    handlers.fetch({
      request: { method: "GET", url: "https://todo.test/", mode: "navigate" },
      respondWith: (r) => {
        response = r;
      },
    });
    if (!response) throw new Error("not handled");
    return response;
  };
}

describe("service worker navigations", () => {
  it("serve the network page when the server answers", async () => {
    const navigate = loadWorker(
      async () => new Response("fresh", { status: 200 }),
    );
    expect(await (await navigate()).text()).toBe("fresh");
  });

  it("fall back to the cached app when the server is down (502, Cloudflare 52x)", async () => {
    for (const status of [502, 503, 521, 522]) {
      const navigate = loadWorker(
        async () => new Response("<html>Bad gateway</html>", { status }),
      );
      const response = await navigate();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<html>app</html>");
    }
  });

  it("fall back to the cached app offline", async () => {
    const navigate = loadWorker(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await (await navigate()).text()).toBe("<html>app</html>");
  });
});

describe("service worker messages (V2.7 bis)", () => {
  type MessageEvent = {
    data: unknown;
    ports?: { postMessage: (m: unknown) => void }[];
  };

  function loadWith(precache: string[]) {
    const source = readFileSync(join(process.cwd(), "mobile", "sw.js"), "utf8");
    const handlers: Record<string, (e: MessageEvent) => void> = {};
    let skipped = 0;
    const self = {
      location: { origin: "https://todo.test" },
      addEventListener: (type: string, h: (e: MessageEvent) => void) => {
        handlers[type] = h;
      },
      skipWaiting: () => {
        skipped += 1;
      },
    };
    new Function(
      "self",
      "caches",
      "fetch",
      `const BUILD = "0000000000000000"; const PRECACHE = ${JSON.stringify(precache)};\n${source}`,
    )(self, {}, async () => new Response());
    return {
      send(data: unknown) {
        const answers: unknown[] = [];
        handlers.message({
          data,
          ports: [{ postMessage: (m) => answers.push(m) }],
        });
        return answers;
      },
      skipped: () => skipped,
    };
  }

  it("activates only for a page of its own build", () => {
    const worker = loadWith(["/index.html", "/assets/swUpdate-abc.js"]);
    expect(
      worker.send({
        type: "SKIP_WAITING_IF_SAME_BUILD",
        path: "/assets/swUpdate-old.js",
      }),
    ).toEqual([{ skipping: false }]);
    expect(worker.skipped()).toBe(0);
    expect(
      worker.send({
        type: "SKIP_WAITING_IF_SAME_BUILD",
        path: "/assets/swUpdate-abc.js",
      }),
    ).toEqual([{ skipping: true }]);
    expect(worker.skipped()).toBe(1);
  });

  it("still activates on « Recharger », and ignores anything else", () => {
    const worker = loadWith([]);
    worker.send({ type: "SKIP_WAITING" });
    worker.send({ type: "SKIP_WAITING_IF_SAME_BUILD" });
    worker.send(null);
    expect(worker.skipped()).toBe(1);
  });
});
