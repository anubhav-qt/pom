/** Text of every page, in order. Empty string for a page with no text layer. */
export async function extractPageTexts(data: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    // pdfjs transfers the buffer it is handed; give it its own copy.
    data: data.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    // Missing standard-font data only affects rendering, which we never do.
    verbosity: 0,
  }).promise;

  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    page.cleanup();
  }
  await doc.destroy();
  return texts;
}
