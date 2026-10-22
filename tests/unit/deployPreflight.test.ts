import assert from "node:assert/strict";
import { test } from "node:test";
import type { rpc } from "@stellar/stellar-sdk";
import {
  deployGuard,
  describePinnedArtifactVerification,
} from "../../lib/guard/guardOps.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import type { WasmIdentity } from "../../lib/guard/chain.ts";

const SIGNER_ADDRESS = "GA76DICZHOAA3L2OUCHG4X6J6DMM2NDEPLUWMK4PVLR2YTXZADHJZIXD";
const SALT = new Uint8Array(32).fill(1);

test("deployment refuses an occupied predicted address before requesting a signature", async () => {
  let signatures = 0;
  let instanceReads = 0;
  const server = {
    async getContractInstance() {
      instanceReads += 1;
      return {};
    },
  } as unknown as rpc.Server;

  await assert.rejects(
    deployGuard({
      server,
      signer: {
        address: SIGNER_ADDRESS,
        signTransaction: async () => {
          signatures += 1;
          return "";
        },
        signAuthEntry: async () => {
          signatures += 1;
          return "";
        },
      },
      salt: SALT,
    }),
    /a contract already exists/,
  );
  assert.equal(instanceReads, 1, "the predicted address receives a fresh preflight read");
  assert.equal(signatures, 0, "an existing instance must not trigger a wallet prompt");
});

test("deployment fails closed when the predicted address cannot be read", async () => {
  let signatures = 0;
  const server = {
    async getContractInstance() {
      throw new Error("RPC unavailable");
    },
  } as unknown as rpc.Server;

  await assert.rejects(
    deployGuard({
      server,
      signer: {
        address: SIGNER_ADDRESS,
        signTransaction: async () => {
          signatures += 1;
          return "";
        },
        signAuthEntry: async () => {
          signatures += 1;
          return "";
        },
      },
      salt: SALT,
    }),
    /could not verify whether .*RPC unavailable/,
  );
  assert.equal(signatures, 0);
});

test("existing bytecode gets distinct visible labels for pinned and mismatched identities", () => {
  const pinned: WasmIdentity = {
    reportedWasmHash: PHASE1_ARTIFACT.wasmHash,
    fetchedSha256: PHASE1_ARTIFACT.wasmHash,
    bytes: PHASE1_ARTIFACT.wasmBytes,
    match: true,
  };
  const mismatched: WasmIdentity = {
    ...pinned,
    fetchedSha256: "0".repeat(64),
    match: false,
  };

  assert.equal(
    describePinnedArtifactVerification(pinned),
    "matches the pinned artifact",
  );
  assert.equal(
    describePinnedArtifactVerification(mismatched),
    "does not match the pinned artifact",
  );
});