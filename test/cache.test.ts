import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Cache } from "../src/usage-bar/cache.ts";

test("tabs share snapshots and claim only one poll per minute", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
  try {
    const a = new Cache(directory);
    const b = new Cache(directory);
    const snapshot = {
      updatedAt: Date.now(),
      limits: [{ label: "5h", remaining: 10, unit: "%" as const }],
    };
    assert.equal(a.write("codex", snapshot), true);
    assert.deepEqual(b.read("codex"), snapshot);
    assert.equal(
      statSync(join(directory, "codex-v3.json")).mode & 0o777,
      0o600,
    );
    // An old extension tab overwrites the legacy file with a newer bad reading.
    writeFileSync(
      join(directory, "codex.json"),
      JSON.stringify({
        updatedAt: snapshot.updatedAt + 1000,
        limits: [
          {
            label: "secondary",
            remaining: 100,
            unit: "%",
            at: snapshot.updatedAt,
          },
        ],
      }),
    );
    assert.deepEqual(b.read("codex"), snapshot);
    const energy = {
      updatedAt: snapshot.updatedAt,
      limits: [
        {
          label: "energy",
          remaining: 4,
          unit: "kWh" as const,
          percentRemaining: 16,
        },
      ],
    };
    a.write("neuralwatt", energy);
    writeFileSync(
      join(directory, "neuralwatt.json"),
      JSON.stringify({
        updatedAt: snapshot.updatedAt + 1000,
        limits: [{ label: "energy", remaining: 4, unit: "kWh" }],
      }),
    );
    assert.deepEqual(b.read("neuralwatt"), energy);
    const slot = 120000;
    writeFileSync(join(directory, "synthetic.2.poll"), "");
    assert.equal(a.claim("synthetic", slot), true);
    assert.equal(b.claim("synthetic", slot), false);
    assert.equal(b.claim("neuralwatt", slot), true);
    assert.equal(b.claim("synthetic", slot + 60000), true);
    a.write("codex", { ...snapshot, updatedAt: snapshot.updatedAt - 1000 });
    assert.deepEqual(b.read("codex"), snapshot);
    assert.deepEqual(
      Object.keys(
        JSON.parse(readFileSync(join(directory, "codex-v3.json"), "utf8")),
      ),
      ["updatedAt", "limits"],
    );
    writeFileSync(join(directory, "codex-v3.json"), "{broken");
    assert.equal(a.read("codex"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
