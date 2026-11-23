import { beforeEach, describe, expect, it } from "vitest";
import {
  CURATED_UNSPLASH_PHOTOS,
  cacheKey,
  clearCachedHomePhoto,
  loadDailyHomePhoto,
  pickCuratedPhoto,
  readCachedHomePhoto,
  readPhotoIdHistory,
  writeCachedHomePhoto,
} from "./home-photos";
import { configureIpc, resetIpc } from "./ipc";
import type { HomePhoto } from "./ipc/api";
import { createMockIpc } from "./ipc/mock";

const PHOTO: HomePhoto = {
  id: "photo-1",
  src: "https://images.unsplash.com/photo-1?auto=format&fit=crop&w=2400&q=80",
  credit: "Jane Doe",
  username: "janedoe",
  source: "https://unsplash.com/@janedoe?utm_source=dayali&utm_medium=referral",
  license: "Unsplash License",
  licenseUrl: "https://unsplash.com/license",
  title: "Landscape at dawn",
};

describe("home-photos metadata cache and daily rotation", () => {
  beforeEach(() => {
    localStorage.clear();
    resetIpc();
  });

  it("round-trips the metadata without storing image bytes", () => {
    writeCachedHomePhoto("2026-11-20", PHOTO);
    const stored = localStorage.getItem(cacheKey("2026-11-20"));
    expect(stored).toContain("photo-1");
    expect(stored).not.toContain("base64");
    expect(readCachedHomePhoto("2026-11-20")).toEqual(PHOTO);
  });

  it("ignores corrupt or incomplete entries", () => {
    localStorage.setItem(cacheKey("2026-11-20"), "{oops");
    expect(readCachedHomePhoto("2026-11-20")).toBeNull();
    localStorage.setItem(cacheKey("2026-11-21"), JSON.stringify({ id: "x" }));
    expect(readCachedHomePhoto("2026-11-21")).toBeNull();
  });

  it("clears one day without touching the others", () => {
    writeCachedHomePhoto("2026-11-20", PHOTO);
    writeCachedHomePhoto("2026-11-21", { ...PHOTO, id: "photo-2" });
    clearCachedHomePhoto("2026-11-20");
    expect(readCachedHomePhoto("2026-11-20")).toBeNull();
    expect(readCachedHomePhoto("2026-11-21")?.id).toBe("photo-2");
  });

  it("serves the cached photo without calling the IPC", async () => {
    writeCachedHomePhoto("2026-11-20", PHOTO);
    let calls = 0;
    configureIpc({
      ...createMockIpc(),
      homePhotoUnsplash: async () => {
        calls += 1;
        return null;
      },
    });
    await expect(
      loadDailyHomePhoto({ logicalDate: "2026-11-20", query: "landscape" }),
    ).resolves.toEqual(PHOTO);
    expect(calls).toBe(0);
  });

  it("records a photo served from the local cache in the vault history", async () => {
    const ipc = createMockIpc();
    configureIpc({ ...ipc, homePhotoUnsplash: async () => null });
    writeCachedHomePhoto("2026-12-03", PHOTO);

    await loadDailyHomePhoto({ logicalDate: "2026-12-03", query: null });

    // Vault créé/migré après la mise en cache : l'identifiant ne doit pas manquer à l'appel.
    expect(await ipc.homePhotoSeenList()).toContain(PHOTO.id);
  });

  it("falls back to curated Unsplash photo when IPC has no key, and records ID history", async () => {
    configureIpc({ ...createMockIpc(), homePhotoUnsplash: async () => null });
    const photo = await loadDailyHomePhoto({ logicalDate: "2026-11-20", query: null });

    expect(photo).toBeDefined();
    expect(photo.src).toContain("images.unsplash.com");
    expect(CURATED_UNSPLASH_PHOTOS.some((p) => p.id === photo.id)).toBe(true);
    expect(readCachedHomePhoto("2026-11-20")).toEqual(photo);
    expect(readPhotoIdHistory()).toContain(photo.id);
  });

  it("selects a different photo for different days and avoids recently shown IDs", () => {
    const photoDay1 = pickCuratedPhoto("2026-11-20");
    const photoDay2 = pickCuratedPhoto("2026-11-21");

    expect(photoDay1.id).not.toBe(photoDay2.id);
    expect(readPhotoIdHistory()).toContain(photoDay1.id);
    expect(readPhotoIdHistory()).toContain(photoDay2.id);

    // Même journée logique = même photo
    expect(readCachedHomePhoto("2026-11-20")?.id).toBe(photoDay1.id);
  });

  it("prioritizes live IPC photo when backend returns one", async () => {
    configureIpc({ ...createMockIpc(), homePhotoUnsplash: async () => PHOTO });
    await expect(loadDailyHomePhoto({ logicalDate: "2026-11-25", query: null })).resolves.toEqual(
      PHOTO,
    );
    expect(readCachedHomePhoto("2026-11-25")).toEqual(PHOTO);
    expect(readPhotoIdHistory()).toContain(PHOTO.id);
  });

  it("never re-picks a photo already recorded in the vault, and records the new one there", async () => {
    const ipc = createMockIpc();
    configureIpc({ ...ipc, homePhotoUnsplash: async () => null });
    const [keep, ...others] = CURATED_UNSPLASH_PHOTOS;
    for (const photo of others) {
      await ipc.homePhotoSeenRecord({ id: photo.id, logicalDate: "2026-01-01" });
    }

    const photo = await loadDailyHomePhoto({ logicalDate: "2026-11-30", query: null });

    expect(photo.id).toBe(keep?.id);
    expect(await ipc.homePhotoSeenList()).toContain(photo.id);
  });

  it("restarts from the least recently seen photo once the whole collection has been shown", () => {
    const all = CURATED_UNSPLASH_PHOTOS.map((photo) => photo.id);
    const picked = pickCuratedPhoto("2026-12-01", all);
    expect(picked.id).toBe(all[0]);
  });

  it("still picks a photo when the vault history cannot be read", async () => {
    configureIpc({
      ...createMockIpc(),
      homePhotoUnsplash: async () => null,
      homePhotoSeenList: async () => {
        throw new Error("vault fermé");
      },
      homePhotoSeenRecord: async () => {
        throw new Error("vault fermé");
      },
    });
    const photo = await loadDailyHomePhoto({ logicalDate: "2026-12-02", query: null });
    expect(CURATED_UNSPLASH_PHOTOS.some((item) => item.id === photo.id)).toBe(true);
  });
});
