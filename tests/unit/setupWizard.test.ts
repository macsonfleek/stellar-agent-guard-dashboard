import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import { policyToScVal } from "stellar-agent-guard-sdk";
import type { ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { SetupWizard } from "../../components/SetupWizard.tsx";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import { GuardContext } from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import { SETUP_STORAGE_KEY } from "../../lib/guard/setupChecklist.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import { POLICY_PRESETS } from "../../lib/guard/presets.ts";
import { guardStatusScVal } from "../mocks/sorobanFixtures.ts";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

const GUARD = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const GUARD_A = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
const GUARD_B = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";

/** A server whose every method rejects, so reads settle into their error states. */
const noNetworkServer = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error("network disabled in unit tests")),
  },
);

/**
 * A mounted snapshot for a freshly deployed guard with no policy — the exact
 * state the checklist exists to surface: default-deny.
 */
function policyMissingSnapshot(guard = GUARD): GuardSnapshot {
  return {
    guard,
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        has_policy: false,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 0n,
        now: 1n,
      },
    },
    policy: { ok: true, value: null },
    window: { ok: true, value: { total: 0n, entries: [] } },
    identity: {
      ok: true,
      value: {
        reportedWasmHash: PHASE1_ARTIFACT.wasmHash,
        fetchedSha256: PHASE1_ARTIFACT.wasmHash,
        bytes: PHASE1_ARTIFACT.wasmBytes,
        match: true,
      },
    },
  };
}

function contextValue(
  snapshot: GuardSnapshot,
  options: { server?: unknown; guard?: string } = {},
) {
  return {
    server: options.server ?? noNetworkServer,
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => {
      throw new Error("no signing in setup-wizard tests");
    },
    instances: [{ guard: GUARD, label: "Test guard", provenance: "test" }],
    guard: options.guard ?? GUARD,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    events: [],
    feed: {
      watching: false,
      latestLedger: null,
      error: null,
      lastPolledAt: null,
      guards: [],
      capped: 0,
      cappedLabels: [],
      gaps: [],
    },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
  } as any;
}

interface Rendered {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function render(
  element: ReactElement,
  snapshot: GuardSnapshot,
  options: { server?: unknown; guard?: string } = {},
): Promise<Rendered & { rerender: (next: GuardSnapshot, nextOptions: { server?: unknown; guard?: string }) => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(GuardContext.Provider, { value: contextValue(snapshot, options) }, element),
    );
  });
  // Let mount effects (the initialize read) settle inside act.
  await act(async () => {
    await sleep(80);
  });
  return {
    container,
    rerender: async (next, nextOptions) => {
      await act(async () => {
        root?.render(
          react.createElement(
            GuardContext.Provider,
            { value: contextValue(next, nextOptions) },
            element,
          ),
        );
      });
      await act(async () => {
        await sleep(40);
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `expected a button labelled "${text}"`);
  return button;
}

async function click(container: HTMLElement, text: string): Promise<void> {
  const button = buttonByText(container, text);
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await sleep(40);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function initializedInstance(value: boolean) {
  return {
    storage: [
      {
        key: { vec: [{ symbol: "Initialized" }] },
        val: { bool: value },
      },
    ],
  };
}

function decodeInvocation(transaction: unknown): { guard: string; fn: string } {
  const envelope = xdr.TransactionEnvelope.fromXDR(
    (transaction as { toXDR(): string }).toXDR(),
    "base64",
  );
  const body = envelope.type === "envelopeTypeTx" ? envelope.v1.tx.operations[0]?.body : undefined;
  const hostFunction =
    body && body.type === "invokeHostFunction"
      ? body.invokeHostFunctionOp.hostFunction
      : undefined;
  if (!hostFunction || hostFunction.type !== "hostFunctionTypeInvokeContract") {
    return { guard: "", fn: "" };
  }
  const call = hostFunction.invokeContract;
  return {
    guard: Address.fromScAddress(call.contractAddress).toString(),
    fn: String(call.functionName),
  };
}

function simulatedRead(retval: xdr.ScVal) {
  return {
    transactionData: undefined,
    minResourceFee: "1",
    result: { auth: [], retval },
    latestLedger: 1,
  };
}

function step(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`li[data-step="${id}"]`);
}

test("the checklist is a semantic ordered list with text status on every step", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    const list = rendered.container.querySelector<HTMLOListElement>(
      "ol[data-testid='setup-steps']",
    );
    assert.ok(list, "the steps must be rendered as an ordered list");
    const items = list.querySelectorAll("li");
    assert.equal(items.length, 4, "four steps: deployed, initialized, policy, verified");

    // Status is conveyed as text (and an icon), not by colour alone.
    for (const item of Array.from(items)) {
      assert.match(
        item.textContent ?? "",
        /Done|Pending|Error/,
        "each step must carry a text status label",
      );
    }
    assert.equal(step(rendered.container, "deployed")?.dataset.state, "pending");
    assert.equal(step(rendered.container, "policy")?.dataset.state, "pending");
    assert.equal(step(rendered.container, "verified")?.dataset.state, "pending");
  } finally {
    await rendered.unmount();
  }
});

test("a dismissed wizard still leaves the default-deny warning visible (safety invariant)", async () => {
  window.localStorage.setItem(
    SETUP_STORAGE_KEY,
    JSON.stringify({ [GUARD]: { dismissed: true, deployedMarker: null } }),
  );
  const rendered = await render(
    react.createElement(
      react.Fragment,
      null,
      react.createElement(StatusPanel),
      react.createElement(SetupWizard),
    ),
    policyMissingSnapshot(),
  );
  try {
    // The wizard is hidden...
    assert.equal(
      rendered.container.querySelector("ol[data-testid='setup-steps']"),
      null,
      "the checklist steps must be hidden once dismissed",
    );
    // ...but the chain-derived warning is not concealed by that dismissal.
    // Matched loosely on the middle clause so this asserts the *banner* — the
    // safety invariant — rather than one wording of it, which `StatusPanel` owns.
    assert.match(
      rendered.container.textContent ?? "",
      /No policy installed .* in default-deny/,
      "StatusPanel must still warn about default-deny while the wizard is dismissed",
    );
    assert.ok(
      buttonByText(rendered.container, "Show setup checklist"),
      "a reopen affordance must exist",
    );
  } finally {
    await rendered.unmount();
    window.localStorage.removeItem(SETUP_STORAGE_KEY);
  }
});

test("reopening the wizard restores it with the derived steps", async () => {
  window.localStorage.setItem(
    SETUP_STORAGE_KEY,
    JSON.stringify({ [GUARD]: { dismissed: true, deployedMarker: null } }),
  );
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    assert.equal(rendered.container.querySelector("ol[data-testid='setup-steps']"), null);
    await click(rendered.container, "Show setup checklist");
    const list = rendered.container.querySelector("ol[data-testid='setup-steps']");
    assert.ok(list, "the checklist must come back after reopening");
    assert.equal(list.querySelectorAll("li").length, 4);
    assert.equal(step(rendered.container, "policy")?.dataset.state, "pending");
  } finally {
    await rendered.unmount();
    window.localStorage.removeItem(SETUP_STORAGE_KEY);
  }
});

test("a failed verification re-read leaves step 4 in error, never optimistically green", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    assert.equal(step(rendered.container, "verified")?.dataset.state, "pending");
    await click(rendered.container, "Re-verify status & policy");

    const verified = step(rendered.container, "verified");
    assert.equal(verified?.dataset.state, "error", "a failed re-read must not turn the step green");
    assert.match(verified?.textContent ?? "", /Error/);
    assert.match(rendered.container.textContent ?? "", /verification read failed/i);

    // The verification result is held in the component and derived from the
    // fetch; no local write records it.
    const raw = window.localStorage.getItem(SETUP_STORAGE_KEY);
    if (raw) {
      const entry = (JSON.parse(raw) as Record<string, Record<string, unknown>>)[GUARD] ?? {};
      assert.deepEqual([...Object.keys(entry)].sort(), ["deployedMarker", "dismissed"]);
    }
  } finally {
    await rendered.unmount();
  }
});

test("a delayed initialize result from the previous guard is ignored", async () => {
  const pending = new Map([
    [GUARD_A, deferred<unknown>()],
    [GUARD_B, deferred<unknown>()],
  ]);
  const server = {
    getContractInstance: (guard: string) => pending.get(guard)!.promise,
  };
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot(GUARD_A), {
    server,
    guard: GUARD_A,
  });
  try {
    await rendered.rerender(policyMissingSnapshot(GUARD_B), { server, guard: GUARD_B });
    pending.get(GUARD_B)!.resolve(initializedInstance(true));
    await act(async () => {
      await sleep(40);
    });
    assert.equal(step(rendered.container, "initialized")?.dataset.state, "done");

    pending.get(GUARD_A)!.resolve(initializedInstance(false));
    await act(async () => {
      await sleep(40);
    });
    assert.equal(
      step(rendered.container, "initialized")?.dataset.state,
      "done",
      "the late result for guard A must not replace guard B's read",
    );
  } finally {
    await rendered.unmount();
  }
});

test("a failed verification read can be retried without replaying a write", async () => {
  let statusReads = 0;
  let policyReads = 0;
  let instanceReads = 0;
  let writes = 0;
  const server = {
    async getContractInstance() {
      instanceReads += 1;
      return initializedInstance(true);
    },
    async simulateTransaction(transaction: unknown) {
      const { fn } = decodeInvocation(transaction);
      if (fn === "status") {
        statusReads += 1;
        if (statusReads === 1) throw new Error("status read temporarily unavailable");
        return simulatedRead(
          guardStatusScVal({
            admin_frozen: false,
            has_policy: true,
            heartbeat_expired: false,
            last_heartbeat: 1,
            now: 2,
          }),
        );
      }
      if (fn === "policy") {
        policyReads += 1;
        return simulatedRead(policyToScVal(POLICY_PRESETS[0]!.config));
      }
      throw new Error(`unexpected contract function: ${fn}`);
    },
    async sendTransaction() {
      writes += 1;
      throw new Error("verification must not submit a transaction");
    },
  };
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot(GUARD_A), {
    server,
    guard: GUARD_A,
  });
  try {
    await click(rendered.container, "Re-verify status & policy");
    assert.equal(step(rendered.container, "verified")?.dataset.state, "error");

    await click(rendered.container, "Re-verify status & policy");
    assert.equal(
      step(rendered.container, "verified")?.dataset.state,
      "done",
      rendered.container.textContent ?? "",
    );
    assert.equal(statusReads, 2);
    assert.equal(policyReads, 2);
    assert.equal(instanceReads, 1, "verification retries only reads; it does not replay initialization");
    assert.equal(writes, 0);
  } finally {
    await rendered.unmount();
  }
});

test("a late verification from the previous guard cannot replace the selected guard's result", async () => {
  const pending = new Map<string, Map<string, ReturnType<typeof deferred<unknown>>>>();
  for (const guard of [GUARD_A, GUARD_B]) {
    pending.set(
      guard,
      new Map([
        ["status", deferred<unknown>()],
        ["policy", deferred<unknown>()],
      ]),
    );
  }
  const server = {
    async getContractInstance() {
      return initializedInstance(true);
    },
    simulateTransaction(transaction: unknown) {
      const { guard, fn } = decodeInvocation(transaction);
      return pending.get(guard)?.get(fn)?.promise ?? Promise.reject(new Error(`unexpected ${guard}.${fn}`));
    },
  };
  const rendered = await render(
    react.createElement(SetupWizard),
    policyMissingSnapshot(GUARD_A),
    { server, guard: GUARD_A },
  );
  try {
    await click(rendered.container, "Re-verify status & policy");
    await rendered.rerender(policyMissingSnapshot(GUARD_B), { server, guard: GUARD_B });
    await click(rendered.container, "Re-verify status & policy");

    pending
      .get(GUARD_B)!
      .get("status")!
      .resolve(
        simulatedRead(
          guardStatusScVal({
            admin_frozen: false,
            has_policy: true,
            heartbeat_expired: false,
            last_heartbeat: 1,
            now: 2,
          }),
        ),
      );
    pending
      .get(GUARD_B)!
      .get("policy")!
      .resolve(simulatedRead(policyToScVal(POLICY_PRESETS[0]!.config)));
    await act(async () => {
      await sleep(40);
    });
    assert.equal(step(rendered.container, "verified")?.dataset.state, "done");

    pending
      .get(GUARD_A)!
      .get("status")!
      .resolve(
        simulatedRead(
          guardStatusScVal({
            admin_frozen: false,
            has_policy: false,
            heartbeat_expired: false,
            last_heartbeat: 1,
            now: 2,
          }),
        ),
      );
    pending.get(GUARD_A)!.get("policy")!.resolve(simulatedRead(xdr.ScVal.scvVoid()));
    await act(async () => {
      await sleep(40);
    });
    assert.equal(
      step(rendered.container, "verified")?.dataset.state,
      "done",
      "guard A's late verification must not replace guard B's result",
    );
  } finally {
    await rendered.unmount();
  }
});
