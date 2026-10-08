import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Provider, type Snapshot, validSnapshot } from "./quotas.ts";

// Cache contains normalized numbers/timestamps only: never raw responses or auth.
export class Cache {
  private directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  private snapshotPath(provider: Provider): string {
    // Version snapshots AND polling claims: old tabs must neither overwrite
    // percentage-aware readings nor claim refreshes for an obsolete cache.
    return join(this.directory, `${provider}-v3.json`);
  }
  read(provider: Provider): Snapshot | undefined {
    try {
      const value: unknown = JSON.parse(
        readFileSync(this.snapshotPath(provider), "utf8"),
      );
      return validSnapshot(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  write(provider: Provider, snapshot: Snapshot): boolean {
    if (!validSnapshot(snapshot)) return false;
    const temp = join(this.directory, `${provider}.${randomUUID()}.tmp`);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if ((this.read(provider)?.updatedAt ?? 0) > snapshot.updatedAt)
        return true;
      writeFileSync(temp, JSON.stringify(snapshot), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, this.snapshotPath(provider));
      return true;
    } catch {
      return false;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* Already renamed or not created. */
      }
    }
  }
  // One polling tab per provider per minute; crashed tabs cannot leave a stuck lock.
  claim(provider: Provider, now = Date.now()): boolean {
    const slot = Math.floor(now / 60_000);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.directory, `${provider}-v3.${slot}.poll`), "", {
        flag: "wx",
        mode: 0o600,
      });
      try {
        unlinkSync(join(this.directory, `${provider}-v3.${slot - 1}.poll`));
      } catch {
        /* First run. */
      }
      return true;
    } catch {
      return false;
    }
  }
}
