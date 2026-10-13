import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Real React/Motion components, in-memory sessions and fake Firestore only.
// No server, enrollment, emulator reset or production request is required.
const fixture = {
  slot: "mom",
  names: { mom: "Elizabeth", aunt: "Rita" },
  connected: true,
  pending: null,
  configured: true,
  loading: false,
  error: null,
  houseWords: [],
  wordRequests: [],
  dictionaryReady: true,
  dictionaryError: null,
  newGameRequests: [],
  newGameRequestsReady: true,
  newGameRequestsError: null,
  endGameRequests: [],
  endGameRequestsReady: true,
  endGameRequestsError: null,
  timedClockReady: true,
  serverTimeOffset: 0,
  presenceStatus: { mom: "present", aunt: "present" },
  sharedActionsPaused: false,
  sharedActionMessage: null,
  sharedActionsResumeAt: null,
  rack: ["A", "T", "E", "O", "N", "S", "L"].map((letter) => ({
    id: `${letter}-0`,
    letter,
    value: 1,
  })),
  game: {
    id: "render-regression",
    revision: 0,
    board: { "7,6": { id: "R-board", letter: "R", value: 1, row: 7, col: 6 } },
    rackCounts: { mom: 7, aunt: 7 },
    bagCount: 86,
    scores: { mom: 0, aunt: 0 },
    turn: "mom",
    status: "active",
    scorelessTurns: 0,
    lastMove: null,
    winner: null,
    winCondition: "classic",
  },
};
for (let i = 0; i < 78; i++) {
  const row = Math.floor(i / 15),
    col = i % 15;
  fixture.game.board[`${row},${col}`] = {
    id: `board-${i}`,
    letter: "A",
    value: 1,
    row,
    col,
  };
}

async function bundle(contents, plugins) {
  return build({
    stdin: { contents, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true,
    write: false,
    outdir: "test-build",
    format: "iife",
    minify: true,
    external: ["/fonts/*", "/textures/*"],
    logLevel: "silent",
    define: {
      "import.meta.env.BASE_URL": '"/"',
      "import.meta.env.DEV": "false",
      "import.meta.env.VITE_APP_VERSION": '"render test"',
      "import.meta.env.VITE_BUILD_TIME": '"2026-10-12T23:41:00.000Z"',
      "process.env.NODE_ENV": '"production"',
    },
    plugins,
  });
}

const appBuild = await bundle(
  `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import App from './src/App';
  window.auditState = ${JSON.stringify(fixture)};
  window.auditChange = patch => { window.auditState = {...window.auditState, ...patch}; window.dispatchEvent(new Event('audit-state')); };
  window.auditStats = {appRenders:0, boardCells:0, previewCalls:0};
  createRoot(document.getElementById('root')).render(<App/>);
`,
  [
    {
      name: "render-test-fixtures",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/firebase$/ }, () => ({
          path: "session",
          namespace: "test-fixture",
        }));
        for (const name of [
          "useWordDictionary",
          "useAppUpdate",
          "useScreenAwake",
        ])
          builder.onResolve({ filter: new RegExp(`${name}$`) }, () => ({
            path: name,
            namespace: "test-fixture",
          }));
        builder.onLoad(
          { filter: /.*/, namespace: "test-fixture" },
          ({ path }) => ({
            resolveDir: process.cwd(),
            contents:
              path === "session"
                ? `import {useSyncExternalStore} from 'react'; const sub = f => {window.addEventListener('audit-state', f);return()=>window.removeEventListener('audit-state',f)};export function useGameSession(){return useSyncExternalStore(sub,()=>window.auditState)}`
                : path === "useWordDictionary"
                  ? `const dictionary=new Set(['RAT','RATE','AT']);export function useWordDictionary(){return{dictionary,error:null,retry:()=>{}}}`
                  : path === "useAppUpdate"
                    ? `export function useAppUpdate(){return{available:false,checking:false,applying:false,status:'',error:null,check:async()=>false,apply:async()=>{},applyAtNewGame:async()=>false}}`
                    : `export function useScreenAwake(){return{enabled:false,supported:false,active:false,status:'',setEnabled:async()=>{}}}`,
          }),
        );
        builder.onLoad({ filter: /src[\\/]App\.tsx$/ }, async ({ path }) => {
          let contents = await readFile(path, "utf8");
          assert(
            contents.includes("export default function App() {"),
            "App instrumentation marker changed",
          );
          contents = contents
            .replace("  previewMove,", "  previewMove as actualPreviewMove,")
            .replace(
              "export default function App() {",
              "export default function App() { window.auditStats.appRenders++;",
            );
          contents += `\nfunction previewMove(...args){window.auditStats.previewCalls++;return actualPreviewMove(...args)}`;
          return {
            contents,
            loader: "tsx",
            resolveDir: process.cwd() + "/src",
          };
        });
        builder.onLoad(
          { filter: /src[\\/]components[\\/]BoardCell\.tsx$/ },
          async ({ path }) => {
            const contents = await readFile(path, "utf8");
            assert(
              contents.includes("}: BoardCellProps) {"),
              "BoardCell instrumentation marker changed",
            );
            return {
              contents: contents.replace(
                "}: BoardCellProps) {",
                "}: BoardCellProps) { window.auditStats.boardCells++;",
              ),
              loader: "tsx",
              resolveDir: process.cwd() + "/src/components",
            };
          },
        );
      },
    },
  ],
);

const presenceBuild = await bundle(
  `
  import React,{useSyncExternalStore} from 'react';import{createRoot}from'react-dom/client';
  import{usePlayerPresence}from'./src/hooks/usePlayerPresence';
  const db={app:{options:{projectId:'mock-presence-only'}}};
  window.presenceConnected=true;window.presenceRenders=0;window.presenceWrites=0;
  window.setPresenceConnected=value=>{window.presenceConnected=value;window.dispatchEvent(new Event('presence-connected'))};
  window.emitPresence=(devices,fromCache=false)=>window.presenceSnapshot({metadata:{fromCache},docs:devices.map(device=>({id:device.id,metadata:{hasPendingWrites:!!device.pending},data:()=>({slot:device.slot,lastSeen:{toMillis:()=>device.lastSeen}})}))});
  const subscribe=f=>{window.addEventListener('presence-connected',f);return()=>window.removeEventListener('presence-connected',f)};
  function Probe(){const connected=useSyncExternalStore(subscribe,()=>window.presenceConnected);const status=usePlayerPresence(db,'device-mom','mom',true,connected);window.presenceRenders++;return <div data-testid="presence">{JSON.stringify(status)}</div>}
  createRoot(document.getElementById('root')).render(<Probe/>);
`,
  [
    {
      name: "fake-presence-firestore",
      setup(builder) {
        builder.onResolve({ filter: /^firebase\/firestore$/ }, () => ({
          path: "firestore",
          namespace: "fake-firestore",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fake-firestore" }, () => ({
          contents: `
      export const collection=(...args)=>args,doc=(...args)=>args,serverTimestamp=()=>null;
      export function onSnapshot(_ref,_options,next,error){window.presenceSnapshot=next;window.presenceError=error;return()=>{window.presenceSnapshot=null}};
      export function setDoc(){window.presenceWrites++;return Promise.resolve()};
    `,
        }));
      },
    },
  ],
);

async function openFixture(
  browser,
  build,
  clock = false,
  reducedMotion = "no-preference",
) {
  let css =
    build.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  for (const font of ["dm-sans-latin", "fraunces-latin"])
    css = css.replace(
      `/fonts/${font}.woff2`,
      `data:font/woff2;base64,${(await readFile(`public/fonts/${font}.woff2`)).toString("base64")}`,
    );
  const script = build.outputFiles.find((file) =>
    file.path.endsWith(".js"),
  ).text;
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    reducedMotion,
  });
  if (clock) {
    await page.clock.install({ time: new Date("2026-10-12T20:00:00.000Z") });
    await page.clock.pauseAt(new Date("2026-10-12T20:00:10.000Z"));
  }
  await page.route("**/*", (route) => {
    assert(
      new URL(route.request().url()).origin === "https://render-test.invalid",
      "A test attempted external network access",
    );
    return route.fulfill({
      contentType: "text/html",
      body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    });
  });
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("https://render-test.invalid/");
  return page;
}
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome",
});
try {
  const page = await openFixture(browser, appBuild);
  await page.getByTestId("game-board").waitFor();
  await page.getByTestId("rack-tile-A-0").click();
  await page.getByTestId("board-cell-7-7").click();
  await page.getByTestId("rack-tile-T-0").click();
  await page.getByTestId("board-cell-7-8").click();
  assert.equal(
    await page
      .getByTestId("board-cell-7-7")
      .locator(".tile-letter")
      .textContent(),
    "A",
  );
  assert.equal(
    await page
      .getByTestId("board-cell-7-8")
      .locator(".tile-letter")
      .textContent(),
    "T",
  );
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.auditStats = { appRenders: 0, boardCells: 0, previewCalls: 0 };
  });
  const source = await page.getByTestId("rack-tile-E-0").boundingBox();
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  for (let row = 6; row <= 9; row++)
    for (let col = 0; col < 15; col++) {
      const rect = await page
        .getByTestId(`board-cell-${row}-${col}`)
        .boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.waitForTimeout(17);
    }
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dragStats = await page.evaluate(() => window.auditStats);
  assert(
    dragStats.appRenders >= 50,
    "The gesture did not exercise enough target changes",
  );
  assert(
    dragStats.boardCells <= 150,
    `Unchanged cells rerendered during drag: ${dragStats.boardCells}`,
  );
  assert.equal(
    dragStats.previewCalls,
    0,
    "Dragging recomputed an unchanged draft",
  );
  await page.evaluate(() => {
    window.auditStats = { appRenders: 0, boardCells: 0, previewCalls: 0 };
    window.auditChange({ presenceStatus: { mom: "present", aunt: "present" } });
  });
  await page.waitForTimeout(100);
  const idleStats = await page.evaluate(() => window.auditStats);
  assert(
    idleStats.appRenders > 0,
    "Presence fixture did not rerender the parent",
  );
  assert.equal(
    idleStats.boardCells,
    0,
    "Unchanged presence rerendered the board",
  );
  assert.equal(idleStats.previewCalls, 0);
  // A memoized empty cell must still use the newly selected tile/action closure.
  await page.getByTestId("rack-tile-E-0").click();
  await page.getByTestId("board-cell-7-9").click();
  assert.equal(
    await page
      .getByTestId("board-cell-7-9")
      .locator(".tile-letter")
      .textContent(),
    "E",
  );
  await page.getByTestId("board-cell-7-7").click();
  await page.getByTestId("board-cell-7-7").click();
  assert.equal(
    await page.getByTestId("board-cell-7-7").locator(".tile-letter").count(),
    0,
    "Tap recall retained a stale selection",
  );
  await page.close();

  // A pass has no card, but its presentation timer may still be running when
  // the next player submits. Its stale ID must not briefly render that play.
  const sequence = await openFixture(browser, appBuild, false, "reduce");
  await sequence.getByTestId("game-board").waitFor();
  await sequence.evaluate(() => {
    window.scoreCardMounts = 0;
    const sampled = new WeakSet();
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const card = node.matches(".floating-points")
            ? node
            : node.querySelector(".floating-points");
          if (card && !sampled.has(card)) {
            sampled.add(card);
            window.scoreCardMounts++;
          }
        }
    }).observe(document, { childList: true, subtree: true });
    window.auditChange({
      game: {
        ...window.auditState.game,
        revision: 1,
        turn: "aunt",
        lastMove: {
          id: "pass-before-play",
          player: "mom",
          kind: "pass",
          placements: [],
          words: [],
          score: 0,
          at: Date.now(),
        },
      },
    });
  });
  await sequence.waitForTimeout(250);
  await sequence.evaluate(() => {
    const placed = { id: "incoming-A", letter: "A", value: 1, row: 7, col: 7 };
    window.auditChange({
      game: {
        ...window.auditState.game,
        revision: 2,
        turn: "mom",
        board: { ...window.auditState.game.board, "7,7": placed },
        lastMove: {
          id: "play-after-pass",
          player: "aunt",
          kind: "play",
          placements: [placed],
          words: ["RA"],
          score: 4,
          at: Date.now(),
        },
      },
    });
  });
  await sequence.getByTestId("move-celebration").waitFor();
  // An unguarded stale card can satisfy waitFor for only one frame. Observe
  // through the reduced-motion arrival and replacement before counting mounts.
  await sequence.waitForTimeout(250);
  assert.equal(
    await sequence.evaluate(() => window.scoreCardMounts),
    1,
    "A stale pass mounted a score card before the accepted play's arrival",
  );
  await sequence.close();

  const presence = await openFixture(browser, presenceBuild, true);
  await presence.getByTestId("presence").waitFor();
  const base = await presence.evaluate(() => Date.now());
  const emit = async (devices, cache = false) => {
    await presence.evaluate(
      ({ devices, cache }) => window.emitPresence(devices, cache),
      { devices, cache },
    );
    await presence.clock.runFor(1);
  };
  await emit([
    { id: "device-mom", slot: "mom", lastSeen: base },
    { id: "device-aunt", slot: "aunt", lastSeen: base },
  ]);
  assert.equal(
    await presence.getByTestId("presence").textContent(),
    JSON.stringify({ mom: "present", aunt: "present" }),
  );
  const initialRenders = await presence.evaluate(() => window.presenceRenders);
  await presence.clock.runFor(19_999);
  const devices = [
    { id: "device-mom", slot: "mom", lastSeen: base },
    { id: "device-mom-new", slot: "mom", lastSeen: base + 20_000 },
    { id: "device-aunt", slot: "aunt", lastSeen: base },
  ];
  await emit(devices);
  await presence.clock.runFor(99_998);
  assert.equal(
    await presence.evaluate(() => window.presenceRenders),
    initialRenders,
    "Unchanged labels or five-second ticks rerendered the consumer",
  );
  assert.equal(
    await presence.evaluate(() => window.presenceWrites),
    2,
    "Heartbeat write cadence changed",
  );
  await presence.clock.runFor(2);
  assert.equal(
    await presence.getByTestId("presence").textContent(),
    JSON.stringify({ mom: "present", aunt: "away" }),
  );
  assert.equal(await presence.evaluate(() => window.presenceWrites), 3);
  await presence.clock.runFor(20_000);
  assert.equal(
    await presence.getByTestId("presence").textContent(),
    JSON.stringify({ mom: "away", aunt: "away" }),
  );
  await emit(devices, true);
  assert.equal(
    await presence.getByTestId("presence").textContent(),
    JSON.stringify({ mom: "unknown", aunt: "unknown" }),
  );
  const unknownRenders = await presence.evaluate(() => window.presenceRenders);
  await emit(devices, true);
  assert.equal(
    await presence.evaluate(() => window.presenceRenders),
    unknownRenders,
    "Repeated cache metadata rerendered unknown presence",
  );
  await presence.evaluate(() => window.setPresenceConnected(false));
  await presence.clock.runFor(1);
  const disconnectedWrites = await presence.evaluate(
    () => window.presenceWrites,
  );
  await presence.clock.runFor(70_000);
  assert.equal(
    await presence.evaluate(() => window.presenceWrites),
    disconnectedWrites,
    "Disconnected presence continued writing",
  );
  await presence.close();
  console.log(
    JSON.stringify(
      {
        dragStats,
        idleStats,
        presence:
          "expiry, stable labels, metadata and heartbeat assertions passed",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
