// The deploy hook. Each repo's CI calls it once its image is published:
//   POST https://laptop.paribelle.in/_paribelle/deploy   Authorization: Bearer <deploy key>
// and it leaves a note in ./.deploy/requested, which the ThinkPad's systemd path unit
// (update.sh --install) turns into an update straight away, instead of at the next
// 5-minute check. It does nothing else: the update itself runs on the host, as always.
//
// The deploy key is DEPLOY_KEY, or else derived from the EDGE_KEY this .env already has:
// HMAC-SHA256(EDGE_KEY, "paribelle-deploy"), hex. CI holds only that derived value (the
// THINKPAD_DEPLOY_KEY secret), which can't be turned back into the edge key.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const key =
  process.env.DEPLOY_KEY ||
  (process.env.EDGE_KEY ? createHmac("sha256", process.env.EDGE_KEY).update("paribelle-deploy").digest("hex") : "");
const digest = (s) => createHash("sha256").update(s).digest();

createServer((req, res) => {
  const answer = (status, text) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(`${text}\n`);
  };
  if (req.method !== "POST") return answer(405, "POST only");
  if (!key) return answer(503, "no deploy key on the ThinkPad (EDGE_KEY or DEPLOY_KEY in infra/.env)");
  const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!timingSafeEqual(digest(given), digest(key))) return answer(403, "forbidden");

  const from = String(req.headers["x-paribelle-repo"] ?? "ci").replace(/[^\w./-]/g, "").slice(0, 80);
  try {
    writeFileSync("/deploy/requested", `${new Date().toISOString()} ${from}\n`);
  } catch (e) {
    console.error("could not leave the note:", e.message);
    return answer(500, "could not leave the note; the next 5-minute check will update");
  }
  console.log(`update requested by ${from}`);
  answer(202, "updating");
}).listen(8091, () => console.log("deploy hook listening on 8091"));
