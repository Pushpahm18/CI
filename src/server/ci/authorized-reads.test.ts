import { describe, expect, it } from "vitest";
import { authorizedReads } from "@/server/ci/authorized-reads";
import { ForbiddenError } from "@/server/ci/errors";

describe("authorizedReads", () => {
  it("runs the authorization and the reads at the same time", async () => {
    const order: string[] = [];
    const [a, r] = await authorizedReads(
      async () => { order.push("auth-start"); await new Promise((x) => setTimeout(x, 20)); order.push("auth-end"); return "ok"; },
      async () => { order.push("read-start"); await new Promise((x) => setTimeout(x, 20)); order.push("read-end"); return 42; }
    );
    expect([a, r]).toEqual(["ok", 42]);
    expect(order.slice(0, 2).sort()).toEqual(["auth-start", "read-start"]); // both started before either finished
  });

  it("a refusal wins over everything: the caller sees the refusal, never the read result or the read's own failure", async () => {
    await expect(authorizedReads(async () => { throw new ForbiddenError("no"); }, async () => "secret")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizedReads(async () => { throw new ForbiddenError("no"); }, async () => { throw new Error("PERMISSION_DENIED token"); })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
