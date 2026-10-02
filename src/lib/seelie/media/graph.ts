/**
 * Seelie writes its own ffmpeg filter graphs. Before ffmpeg sees one, this reads it
 * the way ffmpeg will (the graph's own quoting, then each filter's options) and holds
 * it to a sandbox: creativity is free, reaching outside the render is not.
 *
 *  - Only filters on the list below. Anything that opens a file, a network address or
 *    a plugin (movie, amovie, zmq, dnn, ladspa, frei0r, metadata=file...) isn't on it.
 *  - The few listed filters that read a file (drawtext's font and text file, subtitles,
 *    lut3d, sendcmd's script) take only placeholders for files the render owns:
 *      $font/<file>    a font in the media folder's fonts/ (video_assets lists them)
 *      $lut/<file>     a .cube look in luts/
 *      $file/<name>    a text file given with the render (subtitles, a sendcmd script)
 *      $asset/<id>     a subtitles asset
 *      $fonts          the fonts folder, for subtitles' fontsdir
 *    They become plain names in the render's own folder, which is ffmpeg's working
 *    directory, so no path ever reaches the graph.
 *  - sendcmd can't re-initialise a filter or set a file option.
 *  - Sizes past 8192 px and frame buffers past 300 frames are refused (memory).
 *  - The graph reads only the inputs it was given ([0:v], [1:a] ...) and must end in
 *    [vout] (and [aout] for sound); the renderer adds the output stage itself.
 *
 * No server-only imports: tests run it directly.
 */

export class GraphError extends Error {}

/* -------------------------------------------------------------------------- */
/* Reading a graph the way ffmpeg does                                        */
/* -------------------------------------------------------------------------- */

const WS = " \n\t\r";

/** av_get_token: up to an unquoted, unescaped `term` character; quotes and escapes removed. */
function getToken(s: string, i: number, term: string): { value: string; next: number } {
  while (i < s.length && WS.includes(s[i])) i++;
  let out = "";
  let kept = 0; // characters at the end that came from quotes or escapes, never trimmed
  while (i < s.length && !term.includes(s[i])) {
    const c = s[i++];
    if (c === "\\" && i < s.length) {
      out += s[i++];
      kept = out.length;
    } else if (c === "'") {
      while (i < s.length && s[i] !== "'") out += s[i++];
      if (i < s.length) {
        i++;
        kept = out.length;
      }
    } else out += c;
  }
  let end = out.length;
  while (end > kept && WS.includes(out[end - 1])) end--;
  return { value: out.slice(0, end), next: i };
}

const isKeyChar = (c: string) => /[A-Za-z0-9\-_/.]/.test(c);

export interface ParsedFilter {
  name: string;
  /** Unnamed values, in order (ffmpeg gives them to the filter's options in declaration order). */
  positional: string[];
  options: [string, string][];
  inputs: string[];
  outputs: string[];
}

/** A filter's option string as ffmpeg splits it: `a:b:key=value:key2=value2`. */
function parseOptions(args: string, filter: string): { positional: string[]; options: [string, string][] } {
  const positional: string[] = [];
  const options: [string, string][] = [];
  let i = 0;
  while (i < args.length) {
    // A key: key characters, optional spaces, then '='.
    let j = i;
    while (j < args.length && WS.includes(args[j])) j++;
    const keyStart = j;
    while (j < args.length && isKeyChar(args[j])) j++;
    const keyEnd = j;
    while (j < args.length && WS.includes(args[j])) j++;
    if (keyEnd > keyStart && args[j] === "=") {
      const { value, next } = getToken(args, j + 1, ":");
      options.push([args.slice(keyStart, keyEnd), value]);
      i = next;
    } else {
      if (options.length) throw new GraphError(`${filter}: an unnamed value after a named one ("${args.slice(i, i + 40)}"). Name it.`);
      const { value, next } = getToken(args, i, ":");
      positional.push(value);
      i = next;
    }
    if (args[i] === ":") i++;
  }
  return { positional, options };
}

function parseLabels(s: string, i: number): { labels: string[]; next: number } {
  const labels: string[] = [];
  for (;;) {
    while (i < s.length && WS.includes(s[i])) i++;
    if (s[i] !== "[") break;
    const close = s.indexOf("]", i + 1);
    if (close < 0) throw new GraphError(`An unclosed label at "${s.slice(i, i + 30)}".`);
    const label = s.slice(i + 1, close).trim();
    if (!label) throw new GraphError("An empty label [].");
    labels.push(label);
    i = close + 1;
  }
  return { labels, next: i };
}

/** Every filter in a graph, with its links. Throws GraphError on what ffmpeg would refuse to parse. */
export function parseGraph(graph: string): ParsedFilter[] {
  const filters: ParsedFilter[] = [];
  let i = 0;
  while (i < graph.length) {
    const ins = parseLabels(graph, i);
    i = ins.next;
    while (i < graph.length && WS.includes(graph[i])) i++;
    if (i >= graph.length) {
      if (ins.labels.length) throw new GraphError(`Labels with no filter after them: [${ins.labels.join("][")}].`);
      break;
    }
    let j = i;
    while (j < graph.length && !"=,;[".includes(graph[j])) j++;
    const name = graph.slice(i, j).trim().split("@")[0];
    if (!/^[a-z0-9_]+$/.test(name)) throw new GraphError(`"${graph.slice(i, j).trim().slice(0, 40)}" isn't a filter name.`);
    i = j;
    let args = "";
    if (graph[i] === "=") {
      const t = getToken(graph, i + 1, "[],;");
      args = t.value;
      i = t.next;
    }
    const outs = parseLabels(graph, i);
    i = outs.next;
    filters.push({ name, ...parseOptions(args, name), inputs: ins.labels, outputs: outs.labels });
    while (i < graph.length && WS.includes(graph[i])) i++;
    if (i < graph.length) {
      if (graph[i] !== "," && graph[i] !== ";") throw new GraphError(`Unexpected "${graph.slice(i, i + 20)}" after ${name}.`);
      i++;
    }
  }
  if (!filters.length) throw new GraphError("The graph is empty.");
  return filters;
}

/* -------------------------------------------------------------------------- */
/* The sandbox                                                                */
/* -------------------------------------------------------------------------- */

/** The filters a graph may use. None of them opens anything by itself. */
const ALLOWED = new Set(
  `
  alphaextract alphamerge amplify atadenoise avgblur bilateral blend boxblur bwdif cas chromahold chromakey chromanr
  chromashift colorbalance colorchannelmixer colorcontrast colorcorrect colorize colorhold colorkey colorlevels colormatrix
  colorspace colortemperature convolution copy crop curves datascope deband deblock decimate deflate deflicker dejudder
  delogo despill dilation displace drawbox drawgrid drawtext edgedetect elbg epx eq erosion estdif exposure fade fieldorder
  fillborders floodfill format fps framerate framestep freezeframes gblur geq gradfun grayworld guided haldclut hflip
  histeq histogram hqdn3d hqx hstack hsvhold hsvkey hue huesaturation il inflate interleave kirsch lagfun lenscorrection
  limitdiff limiter loop lumakey lut lut1d lut2 lut3d lutrgb lutyuv maskedclamp maskedmax maskedmerge maskedmin
  maskedthreshold maskfun median mergeplanes minterpolate mix monochrome morpho negate nlmeans noise normalize null
  oscilloscope overlay pad palettegen paletteuse perspective photosensitivity pixelize premultiply prewitt pseudocolor
  removegrain reverse rgbashift roberts rotate sab scale scale2ref scroll select selectivecolor sendcmd setdar setfield
  setparams setpts setrange setsar settb shear showinfo shuffleframes shuffleplanes smartblur sobel split spp subtitles ass
  swaprect swapuv tblend thistogram threshold thumbnail tile tmedian tmidequalizer tmix tonemap tpad transpose trim
  unpremultiply unsharp untile v360 varblur vectorscope vflip vibrance vignette vstack waveform xbr xfade xmedian xstack
  yadif yaepblur zoompan zscale
  color nullsrc testsrc testsrc2 smptebars smptehdbars gradients life mandelbrot cellauto rgbtestsrc yuvtestsrc pal75bars
  pal100bars allrgb allyuv sierpinski
  acompressor acrossfade acrusher adeclick adeclip adelay aecho aemphasis aeval aevalsrc afade afftdn afftfilt aformat
  agate aiir alimiter allpass aloop amerge amix amultiply anequalizer anlmdn anoisesrc anull anullsrc apad aphaser
  apulsator aresample areverse asendcmd asetnsamples asetpts asetrate asettb asplit astats atempo atrim bandpass
  bandreject bass biquad chorus compand compensationdelay crossfeed crystalizer dcshift deesser dynaudnorm earwax
  equalizer extrastereo flanger haas highpass highshelf join loudnorm lowpass lowshelf mcompand pan rubberband
  sidechaincompress sidechaingate silenceremove sine speechnorm stereotools stereowiden superequalizer surround treble
  tremolo vibrato volume concat showwaves showwavespic showspectrum showfreqs showvolume avectorscope ahistogram
  `
    .split(/\s+/)
    .filter(Boolean),
);

type Placeholder = "font" | "lut" | "file" | "asset" | "fonts";

/**
 * The listed filters that read files: which option each unnamed value lands on (ffmpeg's
 * declaration order, as far as it matters), and the placeholders each file option takes.
 * Unnamed values past `positions` must be named.
 */
const FILE_FILTERS: Record<string, { positions: string[]; aliases?: Record<string, string>; files: Record<string, Placeholder[] | "never"> }> = {
  drawtext: { positions: ["fontfile", "text", "textfile"], files: { fontfile: ["font"], textfile: ["file"] } },
  subtitles: {
    positions: ["filename", "original_size", "fontsdir"],
    aliases: { f: "filename" },
    files: { filename: ["file", "asset"], fontsdir: ["fonts"] },
  },
  ass: { positions: ["filename", "original_size", "fontsdir"], aliases: { f: "filename" }, files: { filename: ["file", "asset"], fontsdir: ["fonts"] } },
  lut3d: { positions: ["file"], files: { file: ["lut"] } },
  lut1d: { positions: ["file"], files: { file: ["lut"] } },
  sendcmd: { positions: ["commands", "filename"], aliases: { c: "commands", f: "filename" }, files: { filename: ["file"] } },
  asendcmd: { positions: ["commands", "filename"], aliases: { c: "commands", f: "filename" }, files: { filename: ["file"] } },
  curves: {
    positions: ["preset", "master", "red", "green", "blue", "all"],
    aliases: { m: "master", r: "red", g: "green", b: "blue" },
    files: { psfile: "never", plot: "never" },
  },
};

/** Option names that mean a file anywhere: refused unless the filter's spec allows them. */
const FILE_KEYS = new Set([
  "fontfile",
  "textfile",
  "filename",
  "file",
  "psfile",
  "plot",
  "stats_file",
  "log_path",
  "model",
  "model_path",
  "fontsdir",
  "dumpfile",
  "datapath",
  "obj",
  "weights",
  "result",
  "input",
]);

const PLACEHOLDER: Record<Placeholder, RegExp> = {
  font: /^\$font\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,
  lut: /^\$lut\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,
  file: /^\$file\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,
  asset: /^\$asset\/\d{1,9}$/,
  fonts: /^\$fonts$/,
};

const HINT: Record<Placeholder, string> = {
  font: "$font/<file> (video_assets fonts lists them)",
  lut: "$lut/<file>.cube",
  file: "$file/<name> of a file passed with the render",
  asset: "$asset/<id> of a subtitles asset",
  fonts: "$fonts",
};

/** Filters whose numbers are sizes: none may pass 8192. */
const SIZED = new Set(["scale", "scale2ref", "pad", "crop", "zoompan", "zscale", "tile", "xstack", "color", "nullsrc", "testsrc", "testsrc2", "smptebars", "smptehdbars", "gradients", "life", "mandelbrot", "cellauto", "rgbtestsrc", "yuvtestsrc", "pal75bars", "pal100bars", "sierpinski", "showwaves", "showwavespic", "showspectrum", "showfreqs", "showvolume", "avectorscope", "ahistogram", "untile", "v360", "fillborders", "rotate"]);
const MAX_SIDE = 8192;
const MAX_LOOP_FRAMES = 300;

/** sendcmd may change a filter's settings over time, never its files, and never re-create it. */
function checkCommands(text: string, where: string) {
  const words = text.toLowerCase().split(/[^a-z0-9_]+/);
  if (words.includes("reinit")) throw new GraphError(`${where}: "reinit" isn't allowed; send the option itself (e.g. "drawtext text 'Hi'").`);
  const bad = words.find((w) => FILE_KEYS.has(w));
  if (bad) throw new GraphError(`${where}: commands can't change "${bad}".`);
}

export interface GraphFiles {
  /** Placeholders the graph uses, to be copied into the render folder. */
  fonts: Set<string>;
  luts: Set<string>;
  files: Set<string>;
  assets: Set<number>;
  fontsDir: boolean;
}

export interface CheckedGraph {
  filters: ParsedFilter[];
  uses: GraphFiles;
  /** [aout] is produced, so the video has the graph's sound. */
  hasAudio: boolean;
}

/**
 * Check a graph against the sandbox. `inputs` is how many inputs it was given;
 * `files` the text files passed with it (their contents are checked too when a
 * sendcmd reads one).
 */
export function checkGraph(graph: string, inputs: number, files: Record<string, string> = {}): CheckedGraph {
  if (graph.length > 60_000) throw new GraphError("The graph is longer than 60,000 characters.");
  const filters = parseGraph(graph);
  const uses: GraphFiles = { fonts: new Set(), luts: new Set(), files: new Set(), assets: new Set(), fontsDir: false };
  const produced = new Set<string>();
  const consumed = new Set<string>();

  for (const f of filters) {
    if (!ALLOWED.has(f.name)) {
      throw new GraphError(`The filter "${f.name}" isn't allowed in Seelie's renders (it reads files or devices, or isn't on the list).`);
    }
    const spec = FILE_FILTERS[f.name];
    const named: [string, string][] = [];
    if (spec) {
      if (f.positional.length > spec.positions.length) {
        throw new GraphError(`${f.name}: name every option after "${spec.positions.join(":")}" (key=value).`);
      }
      f.positional.forEach((v, idx) => named.push([spec.positions[idx], v]));
    }
    for (const [k, v] of f.options) named.push([spec?.aliases?.[k] ?? k, v]);

    for (const [key, value] of named) {
      const allowed = spec?.files[key];
      if (allowed === "never" || (FILE_KEYS.has(key) && !allowed)) {
        throw new GraphError(`${f.name}: the option "${key}" reads or writes a file, which renders can't.`);
      }
      if (allowed) {
        const kind = allowed.find((p) => PLACEHOLDER[p].test(value));
        if (!kind) throw new GraphError(`${f.name}: ${key} must be ${allowed.map((p) => HINT[p]).join(" or ")}, not "${value.slice(0, 60)}".`);
        const name = value.slice(value.indexOf("/") + 1);
        if (kind === "font") uses.fonts.add(name);
        else if (kind === "lut") uses.luts.add(name);
        else if (kind === "file") {
          if (!(name in files)) throw new GraphError(`${f.name}: $file/${name} wasn't passed with the render (files).`);
          uses.files.add(name);
          if (f.name === "sendcmd" || f.name === "asendcmd") checkCommands(files[name], `$file/${name}`);
        } else if (kind === "asset") uses.assets.add(Number(name));
        else uses.fontsDir = true;
      }
      if ((f.name === "sendcmd" || f.name === "asendcmd") && key === "commands") checkCommands(value, f.name);
      if (f.name === "loop" && key === "size" && Number(value) > MAX_LOOP_FRAMES) {
        throw new GraphError(`loop: size ${value} holds too many frames (at most ${MAX_LOOP_FRAMES}).`);
      }
    }
    if (SIZED.has(f.name)) {
      for (const value of [...f.positional, ...f.options.map(([, v]) => v)]) {
        const big = value.match(/\d+(\.\d+)?/g)?.map(Number).find((n) => n > MAX_SIDE);
        if (big) throw new GraphError(`${f.name}: ${big} is bigger than ${MAX_SIDE} px.`);
      }
    }
    if (f.name === "loop" && f.positional[1] !== undefined && Number(f.positional[1]) > MAX_LOOP_FRAMES) {
      throw new GraphError(`loop: size ${f.positional[1]} holds too many frames (at most ${MAX_LOOP_FRAMES}).`);
    }

    for (const label of f.inputs) {
      const stream = /^(\d+)(:[avs](:\d+)?)?$/.exec(label);
      if (stream) {
        if (Number(stream[1]) >= inputs) throw new GraphError(`[${label}]: there ${inputs === 1 ? "is 1 input" : `are ${inputs} inputs`} (0 to ${inputs - 1}).`);
      } else consumed.add(label);
    }
    for (const label of f.outputs) {
      if (label.startsWith("__")) throw new GraphError(`[${label}]: labels starting with __ are the renderer's.`);
      if (/^\d/.test(label)) throw new GraphError(`[${label}]: a label can't start with a digit (those name inputs).`);
      if (produced.has(label)) throw new GraphError(`[${label}] is produced twice.`);
      produced.add(label);
    }
  }

  if (!produced.has("vout")) throw new GraphError("The graph must end its picture in [vout].");
  for (const label of consumed) if (!produced.has(label)) throw new GraphError(`[${label}] is used but never produced.`);
  for (const label of produced) {
    if (label !== "vout" && label !== "aout" && !consumed.has(label)) throw new GraphError(`[${label}] is produced but never used.`);
  }
  if (consumed.has("vout") || consumed.has("aout")) throw new GraphError("[vout] and [aout] are the graph's results; don't feed them into another filter.");
  return { filters, uses, hasAudio: produced.has("aout") };
}

/** The graph with every placeholder replaced by the plain name its file has in the render folder. */
export function localizeGraph(graph: string, assetFile: (id: number) => string): string {
  return graph
    .replace(/\$(font|lut|file)\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})/g, (_, kind: string, name: string) => `${kind}-${name}`)
    .replace(/\$asset\/(\d{1,9})/g, (_, id: string) => assetFile(Number(id)))
    .replace(/\$fonts\b/g, "fonts");
}
