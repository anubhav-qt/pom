/**
 * Code 128 barcodes, as the bars to draw: each symbol's six widths (bar, space,
 * bar, space, bar, space) in modules, the stop symbol seven. All-digit text of
 * even length uses set C (two digits a symbol, half as wide); anything else set B.
 */

const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
export const CODE128_PATTERNS = PATTERNS;

const START_B = 104;
const START_C = 105;
const STOP = 106;

/** The symbol values for `text`, start and check symbol included, stop excluded. */
export function code128Values(text: string): number[] {
  if (!text) throw new Error("Nothing to encode.");
  let values: number[];
  if (/^\d+$/.test(text) && text.length % 2 === 0) {
    values = [START_C];
    for (let i = 0; i < text.length; i += 2) values.push(Number(text.slice(i, i + 2)));
  } else {
    values = [START_B];
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code > 126) throw new Error(`"${ch}" can't go in a Code 128 barcode.`);
      values.push(code - 32);
    }
  }
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  values.push(check);
  return values;
}

/**
 * The bars for `text`: x offsets and widths in modules, from the first bar
 * (quiet zones are the caller's), and the total width in modules.
 */
export function code128Bars(text: string): { bars: { x: number; w: number }[]; modules: number } {
  const widths = [...code128Values(text), STOP].map((v) => PATTERNS[v]).join("");
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (let i = 0; i < widths.length; i++) {
    const w = Number(widths[i]);
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  }
  return { bars, modules: x };
}
