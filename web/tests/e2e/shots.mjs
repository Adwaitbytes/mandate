// Screenshots of every page and state at 360, 768 and 1440 px, light and dark, into design/build-shots/.
// Needs: the mock chain (node tests/e2e/mock-chain.ts), the e2e dev server (scripts/e2e-dev.sh) and, for the
// not-deployed shots, a production server of the real build (pnpm build && pnpm start -p 3219).
// Usage: node tests/e2e/shots.mjs [filter]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const E2E = process.env.E2E_URL ?? "http://localhost:3218";
const PROD = process.env.PROD_URL ?? "http://localhost:3219";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8645";
const OUT = join(import.meta.dirname, "..", "..", "..", "design", "build-shots");
const OWNER = "0x4d96Ec766088D952D62255227902eeEe1C58276c";
const STRANGER = "0x1111111111111111111111111111111111111111";
const filter = process.argv[2] ?? "";
mkdirSync(OUT, { recursive: true });

const world = (name) => fetch(`${MOCK}/__world?name=${name}`);

/** A minimal EIP-1193 wallet. Reads go to the mock chain; sends return a hash the mock never mines. */
function walletScript(account, chainId) {
  return `(() => {
    let chainId = ${chainId};
    const listeners = {};
    window.ethereum = {
      isMetaMask: true,
      on: (e, f) => { (listeners[e] ||= []).push(f); },
      removeListener: () => {},
      request: async ({ method, params }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return ["${account}"];
        if (method === "eth_chainId") return "0x" + chainId.toString(16);
        if (method === "wallet_switchEthereumChain") { chainId = parseInt(params[0].chainId, 16); (listeners.chainChanged||[]).forEach(f => f("0x" + chainId.toString(16))); return null; }
        if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
        if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32);
        const res = await fetch("${MOCK}/rpc/" + chainId, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const json = await res.json();
        if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code });
        return json.result;
      },
    };
  })();`;
}

const shots = [
  // Live states against the mock chain
  { name: "mandate", url: `${E2E}/` },
  { name: "docket", url: `${E2E}/docket` },
  { name: "case-window-hash-mismatch", url: `${E2E}/docket/8` },
  { name: "case-injection-hold", url: `${E2E}/docket/2` },
  { name: "case-split-hold", url: `${E2E}/docket/3` },
  { name: "case-vetoed", url: `${E2E}/docket/4` },
  { name: "case-overridden", url: `${E2E}/docket/5` },
  { name: "case-cast", url: `${E2E}/docket/1` },
  { name: "case-voting-not-open", url: `${E2E}/docket/6` },
  { name: "case-voting-ended", url: `${E2E}/docket/7` },
  { name: "case-awaiting-verdicts", url: `${E2E}/docket/9` },
  { name: "case-not-found", url: `${E2E}/docket/99` },
  { name: "weights", url: `${E2E}/weights` },
  { name: "radar", url: `${E2E}/radar` },
  { name: "propose", url: `${E2E}/propose` },
  {
    name: "propose-own-text",
    url: `${E2E}/propose`,
    act: async (p) => {
      await p.getByLabel("Write your own").check();
      await p.getByLabel("Title").fill("Fund a public dashboard of treasury flows");
      await p
        .getByLabel("What the proposal does")
        .fill(
          "Pay 2,000 MDV to build a public dashboard that shows every treasury transfer, updated daily, with the code published.",
        );
    },
  },
  {
    name: "propose-relayer-unset",
    url: `${E2E}/propose`,
    route: [
      "**/api/propose",
      {
        status: 503,
        body: {
          code: "relayer-unset",
          error: "This deployment has no relayer wallet, so it cannot file proposals for visitors",
        },
      },
    ],
    act: async (p) => {
      await p.getByRole("button", { name: "File this proposal" }).click();
      await p.getByRole("alert").first().waitFor();
    },
  },
  {
    name: "propose-rate-limited",
    url: `${E2E}/propose`,
    route: [
      "**/api/propose",
      {
        status: 429,
        body: {
          code: "rate-limited",
          scope: "visitor",
          retryAfterSeconds: 2460,
          error: "You have filed the most proposals allowed from one address in an hour",
        },
      },
    ],
    act: async (p) => {
      await p.getByRole("button", { name: "File this proposal" }).click();
      await p.getByRole("alert").first().waitFor();
    },
  },
  {
    name: "propose-following",
    url: `${E2E}/propose`,
    once: true,
    act: async (p) => {
      await p.getByLabel(/Refill the community grants wallet/).check();
      await p.getByRole("button", { name: "File this proposal" }).click();
      await p.getByText("Following your proposal").waitFor({ timeout: 20_000 });
      await p.waitForTimeout(2500);
    },
  },
  { name: "docket-empty", url: `${E2E}/docket`, world: "empty" },
  { name: "docket-rpc-error", url: `${E2E}/docket`, world: "down", wait: 9000 },
  { name: "mandate-rpc-error", url: `${E2E}/`, world: "down", wait: 9000 },
  { name: "docket-loading", url: `${E2E}/docket`, hangRpc: true },
  { name: "case-loading", url: `${E2E}/docket/8`, hangRpc: true },
  // Wallet states on a case in its veto window
  {
    name: "wallet-none",
    url: `${E2E}/docket/8`,
    act: async (p) => {
      await p.getByRole("button", { name: "Veto this vote" }).click();
      await p.getByText(/No browser wallet found/).waitFor();
    },
    focus: ".stub",
  },
  {
    name: "wallet-not-owner",
    url: `${E2E}/docket/8`,
    wallet: [STRANGER, 84532],
    act: async (p) => {
      await p.getByRole("button", { name: "Veto this vote" }).click();
      await p.getByRole("button", { name: "Connect wallet" }).click();
      await p.getByText(/is not the mandate owner/).waitFor();
    },
    focus: ".stub",
  },
  {
    name: "wallet-wrong-network",
    url: `${E2E}/docket/8`,
    wallet: [OWNER, 1301],
    act: async (p) => {
      await p.getByRole("button", { name: "Veto this vote" }).click();
      await p.getByRole("button", { name: "Connect wallet" }).click();
      await p.getByRole("button", { name: "Switch to Base Sepolia" }).waitFor();
    },
    focus: ".stub",
  },
  {
    name: "wallet-pending-tx",
    url: `${E2E}/docket/8`,
    wallet: [OWNER, 84532],
    act: async (p) => {
      await p.getByRole("button", { name: "Veto this vote" }).click();
      await p.getByRole("button", { name: "Connect wallet" }).click();
      await p.getByRole("button", { name: "Veto case 8" }).click();
      await p.getByText(/Waiting for Base Sepolia to include/).waitFor();
    },
    focus: ".stub",
  },
  // The real build, as deployed today: nothing on chain yet
  { name: "prod-mandate-not-deployed", url: `${PROD}/` },
  { name: "prod-docket-not-deployed", url: `${PROD}/docket` },
  { name: "prod-case-not-deployed", url: `${PROD}/docket/3` },
  { name: "prod-weights-not-deployed", url: `${PROD}/weights` },
  { name: "prod-propose-not-deployed", url: `${PROD}/propose` },
];

const widths = [360, 768, 1440];
const browser = await chromium.launch();
let count = 0;
for (const s of shots.filter((x) => x.name.includes(filter))) {
  for (const scheme of ["light", "dark"]) {
    for (const w of widths) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: 900 },
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      const p = await ctx.newPage();
      if (s.wallet) await p.addInitScript(walletScript(s.wallet[0], s.wallet[1]));
      if (s.route) {
        const [pattern, r] = s.route;
        await p.route(pattern, (route) =>
          route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) }),
        );
      }
      if (s.hangRpc) await p.route(`${MOCK}/rpc/**`, () => new Promise(() => {}));
      await world(s.world ?? "full");
      await p.goto(s.url, { waitUntil: "domcontentloaded" });
      if (!s.hangRpc) await p.waitForLoadState("networkidle").catch(() => undefined);
      await p.waitForTimeout(s.hangRpc ? 1200 : (s.wait ?? 1500));
      if (s.act) await s.act(p);
      await p.waitForTimeout(400);
      const file = join(OUT, `${s.name}-${w}${scheme === "dark" ? "-dark" : ""}.png`);
      if (s.focus) await p.locator(s.focus).scrollIntoViewIfNeeded();
      await p.screenshot({ path: file, fullPage: !s.focus });
      count++;
      await ctx.close();
    }
  }
}
await world("full");
await browser.close();
process.stdout.write(`${count} screenshots in ${OUT}\n`);
