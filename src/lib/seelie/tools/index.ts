import "server-only";

import type { User } from "@/db/schema";

import { amazonApi, amazonListings, catalogueLink, inventoryTool, productsTool, productUpdate, pushStock, restockPlan } from "./catalogue";
import { adsCreate, adsManage, adsReport } from "./ads";
import { viewImages } from "./images";
import { instagram, instagramPost } from "./instagram";
import { finance, orderNotes } from "./money";
import { cancellations, findOrders, fulfilment, orderDetails, ordersOverview, scanLookup } from "./orders";
import { imageSpecs, photoEdit } from "./photo";
import { photoshoot } from "./photoshoot";
import { photoPublish, videoPublish } from "./publish";
import { returnsDesk, returnsUpdate } from "./returns";
import { songs } from "./songs";
import { sqlQuery, sqlSchema } from "./sql";
import { videoAssets, videoLibrary, videoRender, videoWatch } from "./video";
import {
  storeAmazonGap,
  storeApi,
  storeApiRoutes,
  storeCreateProducts,
  storeDeleteProducts,
  storeProducts,
  storeUpdateProducts,
  storeUploadImages,
} from "./store";
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
  storeApiRoutes,
  storeApi,
  // Media (videos and reels are Seelie's own edits through video_render; the Reels screen's
  // Gemini-directed maker isn't offered, so Seelie never hands a video off to it)
  viewImages,
  videoAssets,
  videoWatch,
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
  // Retired tools: older chats still show their cards.
  return new Map([...ALL.map((t) => [t.name, t.label] as [string, string]), ["reels", "Reels"], ["image_studio", "Image studio"]]);
}
