// Seelie's photo models (cut-out, retouching, selection, upscaling), run through
// onnxruntime-node in a process of their own: src/lib/seelie/media/models.ts forks this
// file and sends it tensors. A model at 1024x1024 takes gigabytes; kept out here, the
// kernel stops this process first when the OMS runs short of memory (models.ts raises its
// oom_score_adj), and the OMS process holding Seelie's reply carries on. It ends when the
// OMS lets go of it (disconnects) after a few idle minutes, and all its memory with it.
//
//   parent → { id, op: "open", file, threads }          ← { id, inputNames, outputNames }
//   parent → { id, op: "run", file, threads, feeds }    ← { id, outputs }
//   (an error)                                           ← { id, error }
//
// A tensor travels as { type, data, dims }: the IPC channel is "advanced" (structured
// clone), which carries typed arrays as they are.
import ort from "onnxruntime-node";

const sessions = new Map();

function session(file, threads) {
  let s = sessions.get(file);
  if (!s) {
    s = ort.InferenceSession.create(file, { graphOptimizationLevel: "all", intraOpNumThreads: threads, logSeverityLevel: 3 });
    s.catch(() => sessions.delete(file));
    sessions.set(file, s);
  }
  return s;
}

async function handle(msg) {
  const model = await session(msg.file, msg.threads);
  if (msg.op === "open") return { inputNames: [...model.inputNames], outputNames: [...model.outputNames] };
  const feeds = {};
  for (const [name, t] of Object.entries(msg.feeds)) feeds[name] = new ort.Tensor(t.type, t.data, t.dims);
  const out = await model.run(feeds);
  const outputs = {};
  for (const [name, t] of Object.entries(out)) {
    outputs[name] = { type: t.type, data: t.data, dims: [...t.dims] };
    t.dispose?.();
  }
  return { outputs };
}

process.on("message", (msg) => {
  handle(msg).then(
    (res) => process.send?.({ id: msg.id, ...res }),
    (err) => process.send?.({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
  );
});
// The OMS let go of it, or the OMS process itself ended.
process.on("disconnect", () => process.exit(0));
