import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { chatImage } from "@/lib/seelie/chats";
import { failure, unauthorized } from "@/lib/seelie/http";

export const runtime = "nodejs";

/** An image from a chat: block `index` of transcript message `seq`. Never changes, so cached. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; seq: string; index: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id, seq, index } = await params;
  try {
    const image = await chatImage(user, id, Number(seq), Number(index));
    if (!image) return new NextResponse("Not found", { status: 404 });
    return new NextResponse(new Uint8Array(image.bytes), {
      headers: {
        "content-type": image.mimeType,
        "content-length": String(image.bytes.length),
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    return failure(err);
  }
}
