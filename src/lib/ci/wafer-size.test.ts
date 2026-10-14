import { describe, expect, it } from "vitest";
import { unexpectedWaferValues, waferDisplay, waferLabelFor, waferStoredFor, waferStoredForInput } from "@/lib/ci/wafer-size";

describe("wafer size mapping (approved)", () => {
  it("maps stored numbers, however they are written, to the approved labels", () => {
    expect(waferLabelFor(300)).toBe('300mm (12")');
    expect(waferLabelFor("300.0")).toBe('300mm (12")');
    expect(waferLabelFor(" 200 ")).toBe('200mm (8")');
    expect(waferLabelFor("150.0")).toBe('150mm (6")');
  });

  it("never converts anything outside the mapping", () => {
    for (const v of [null, undefined, "", "  ", "abc", "100", "300.5", "450", 0]) expect(waferLabelFor(v)).toBeNull();
    expect(waferDisplay("450.0")).toBe("450.0");
    expect(waferDisplay("")).toBe("");
  });

  it("maps the exact labels back to numbers and rejects look-alikes", () => {
    expect(waferStoredFor('300mm (12")')).toBe(300);
    expect(waferStoredFor('150mm (6")')).toBe(150);
    for (const v of ["300", "300mm", '300MM (12")', "", null]) expect(waferStoredFor(v)).toBeNull();
  });

  it("on the form, the same three sizes are accepted however the list spells them; any other size is refused", () => {
    for (const v of ["300", "300mm", "300 mm", "300MM", "300.0", `300mm (12")`, " 200mm ", "150 mm", `150mm (6")`]) expect(waferStoredForInput(v), String(v)).toBe(Number(String(v).trim().slice(0, 3)));
    for (const v of ["100", "100mm", "450", "30", "3000mm", "abc", "", null, undefined, "300x"]) expect(waferStoredForInput(v), String(v)).toBeNull();
  });

  it("reports unexpected stored values once each, ignoring blanks and approved ones", () => {
    expect(unexpectedWaferValues(["300.0", "", "450.0", "450.0", "abc"])).toEqual(["450.0", "abc"]);
  });
});
