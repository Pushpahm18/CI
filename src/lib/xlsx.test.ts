import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildXlsx } from "@/lib/xlsx";

// Fake cells only. Opens the generated workbook as a zip and checks the parts Excel needs.
describe("buildXlsx", () => {
  it("writes a valid workbook: heading row styled, numbers as numbers, text escaped", async () => {
    const blob = await buildXlsx([
      { name: "Rows", rows: [["Name", "Qty"], ["A & <B>", 4], ["", null]] },
      { name: "Second:Sheet?", rows: [["X"]] },
    ]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"])
    );
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    expect(workbook).toContain('name="Rows"');
    expect(workbook).toContain('name="Second Sheet "'); // illegal characters removed
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain('<pane ySplit="1"');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">'); // heading style
    expect(sheet).toContain("A &amp; &lt;B&gt;"); // escaped
    expect(sheet).toContain('<c r="B2"><v>4</v></c>'); // number stays a number
    expect(sheet).not.toContain('r="A3"'); // blank cells are omitted
  });
});
