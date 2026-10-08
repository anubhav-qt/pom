import "server-only";

import type { User } from "@/db/schema";

import { amazonApi, amazonListings, catalogueLink, inventoryTool, productsTool, productUpdate, pushStock, restockPlan } from "./catalogue";
import { adsCreate, adsManage, adsReport } from "./ads";
import { viewImages } from "./images";
import { instagram, instagramPost } from "./instagram";
import { memory } from "./memory";
import { finance, orderNotes } from "./money";
import { cancellations, findOrders, fulfilment, orderDetails, ordersOverview, scanLookup } from "./orders";
import { pdfEdit, pdfRead } from "./pdf";
import { imageSpecs, photoEdit } from "./photo";
import { photoshoot } from "./photoshoot";
import { photoPublish, videoPublish } from "./publish";
import { returnsDesk, returnsUpdate } from "./returns";
import { routines } from "./routines";
import { songs } from "./songs";
import { sqlQuery, sqlSchema } from "./sql";
import { videoAssets, videoLibrary, videoPlan, videoRender, videoWatch } from "./video";
import {
  storeAmazonGap,
  storeApi,
  storeApiRoutes,
  storeCreateProducts,
  storeDeleteProducts,
  storeHero,
  storeProducts,
  storeUpdateProducts,
  storeUploadImages,
} from "./store";
import { paribelleOrders } from "./paribelle";
import { storeCategories, storeHsn, storePages, storeSettings } from "./site";
import { marketplaceAccounts, syncMarketplace, syncStatus } from "./sync";
import type { SeelieTool } from "./types";
import { fetchUrl, webSearch, youtube } from "./web";

/** Every tool, in the order the model sees them. */
const ALL = [
  // Orders and the floor
  findOrders,
  orderDetails,
  ordersOverview,
  fulfilment,
  cancellations,
  scanLookup,
  returnsDesk,
  returnsUpdate,
  paribelleOrders,
  orderNotes,
  // Catalogue and stock
  productsTool,
  productUpdate,
  inventoryTool,
  pushStock,
  restockPlan,
  // Money
  finance,
  // Marketplaces
  syncStatus,
  syncMarketplace,
  marketplaceAccounts,
  amazonListings,
  catalogueLink,
  amazonApi,
  // paribelle.in
  storeProducts,
  storeUpdateProducts,
  storeDeleteProducts,
  storeUploadImages,
  storeCreateProducts,
  storeAmazonGap,
  storeHero,
  storeSettings,
  storePages,
  storeCategories,
  storeHsn,
  storeApiRoutes,
  storeApi,
  // Media (videos and reels are Seelie's own compositions, video_plan then video_render; the
  // Reels screen's Gemini-directed maker isn't offered, so Seelie never hands a video off to it)
  viewImages,
  videoAssets,
  videoWatch,
  videoPlan,
  videoRender,
  videoLibrary,
  videoPublish,
  songs,
  // Product photos: new pictures only through photoshoot (the capped image model); every
  // edit is code (photo_edit); marketplace rules are saved presets
  photoshoot,
  photoEdit,
  imageSpecs,
  photoPublish,
  // PDFs: read them, and make new ones (edits, forms, redaction, HTML laid out as pages)
  pdfRead,
  pdfEdit,
  // Instagram and Meta ads (the Meta connection in Seelie's settings)
  instagram,
  instagramPost,
  adsReport,
  adsCreate,
  adsManage,
  // The web
  webSearch,
  fetchUrl,
  youtube,
  // Memory (what the person asked Seelie to keep) and routines (scheduled runs)
  memory,
  routines,
  // Anything else
  sqlSchema,
  sqlQuery,
] as unknown as SeelieTool[];

/** The tools this user gets: switched-on features only, owner tools for owners. */
export function toolsFor(user: Pick<User, "role">): SeelieTool[] {
  return ALL.filter((t) => (!t.ownerOnly || user.role === "owner") && (t.enabled?.() ?? true));
}

/** Every tool's card label, by name (for rows read back from the database). */
export function toolLabels(): Map<string, string> {
  // Retired tools: older chats still show their cards. Helpers is the engine's own.
  return new Map([...ALL.map((t) => [t.name, t.label] as [string, string]), ["reels", "Reels"], ["image_studio", "Image studio"], ["helpers", "Helpers"]]);
}
