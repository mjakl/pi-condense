import { expect, it } from "bun:test";

for (const mode of ["final-response", "budget"]) {
  it(`delivers ${mode} summaries once across live runs and reload (offline Pi SDK)`, async () => {
    // Isolate real Pi/Anthropic dispatch from the unit suite's module mocks.
    const child = Bun.spawn([process.execPath, "src/lifecycle-fixture.ts", mode], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ budget: mode === "budget", calls: 9, summaries: mode === "budget" ? 6 : 3, reload: true });
  });
}
