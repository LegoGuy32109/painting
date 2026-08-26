import { assertEquals, assertExists } from "@std/assert";
import { ParadeState } from "../src/client/parade-state.js";

/** @param {string} id */
const canvas = (id) => ({ id, pixels: "", title: id });

Deno.test("active canvases suppress completed paintings and rotate once before repeating", () => {
  const state = new ParadeState();
  state.addCompletedPage([canvas("signed")], null);
  state.syncActive(Array.from({ length: 24 }, (_, index) => ({
    canvas: canvas(`live-${index}`),
    headSequence: index,
  })));

  const offered = [];
  for (let index = 0; index < 24; index++) {
    const next = state.next(new Set());
    assertExists(next);
    assertEquals(next.kind, "active");
    offered.push(next.canvas.id);
  }
  assertEquals(new Set(offered).size, 24);
  const repeated = state.next(new Set());
  assertExists(repeated);
  assertEquals(repeated.kind, "active");
});

Deno.test("completed cursor pages exhaust before a repeat bag is used", () => {
  const state = new ParadeState();
  state.addCompletedPage([canvas("a"), canvas("b")], "next");
  const a = state.next(new Set());
  const b = state.next(new Set());
  assertExists(a);
  assertExists(b);
  assertEquals(a.canvas.id, "a");
  assertEquals(b.canvas.id, "b");
  assertEquals(state.next(new Set()), null);
  state.addCompletedPage([canvas("c")], null);
  const c = state.next(new Set());
  const repeated = state.next(new Set());
  assertExists(c);
  assertExists(repeated);
  assertEquals(c.canvas.id, "c");
  assertEquals(repeated.kind, "completed");
});

Deno.test("newly signed painting leads after the last live canvas leaves", () => {
  const state = new ParadeState();
  state.addCompletedPage([canvas("old")], null);
  state.addActive(canvas("live"));
  state.complete({ ...canvas("live"), title: "fresh" });
  const next = state.next(new Set());
  assertExists(next);
  assertEquals(next.canvas.title, "fresh");
});
