/**
 * Fonts shipped in public/fonts and installed on first launch, with their licences.
 * Licence files are deployed next to the fonts, so the links work on the hosted site too.
 */
export interface BundledFont {
  /** Path under public/fonts. */
  path: string;
  /** Display name; defaults to the name inside the font. */
  name?: string;
  /** Credit shown in the credits table. */
  author: string;
  license: "SIL OFL 1.1" | "Apache 2.0" | "Hershey Fonts licence";
  /** Licence file under public/fonts. */
  licenseFile: string;
}

const ofl = (path: string, author: string, licenseFile: string): BundledFont => ({ path, author, license: "SIL OFL 1.1", licenseFile });
const hershey = (file: string, name: string): BundledFont => ({
  path: `hershey/${file}.jhf`,
  name,
  author: "Dr. A. V. Hershey (U.S. National Bureau of Standards); data format by James Hurt",
  license: "Hershey Fonts licence",
  licenseFile: "hershey/HERSHEY-LICENSE.txt",
});

export const BUNDLED_FONTS: BundledFont[] = [
  ofl("Caveat.ttf", "Pablo Impallari, The Caveat Project Authors", "OFL-caveat.txt"),
  ofl("IndieFlower-Regular.ttf", "Kimberly Geswein", "OFL-indieflower.txt"),
  ofl("PatrickHand-Regular.ttf", "Patrick Wagesreiter", "OFL-patrickhand.txt"),
  ofl("ShadowsIntoLight.ttf", "Kimberly Geswein", "OFL-shadowsintolight.txt"),
  { path: "HomemadeApple-Regular.ttf", author: "Font Diner, Inc.", license: "Apache 2.0", licenseFile: "LICENSE-homemadeapple.txt" },
  ofl("Kalam-Regular.ttf", "Indian Type Foundry", "OFL-kalam.txt"),
  ofl("Gurajada-Regular.ttf", "Purushoth Kumar Guthula, SiliconAndhra", "OFL-gurajada.txt"),
  ofl("Mallanna-Regular.ttf", "Purushoth Kumar Guthula, SiliconAndhra; Latin from Nunito by Vernon Adams", "OFL-mallanna.txt"),
  hershey("futural", "Hershey Sans 1-stroke"),
  hershey("futuram", "Hershey Sans Bold"),
  hershey("rowmans", "Hershey Roman Simplex"),
  hershey("rowmand", "Hershey Roman Duplex"),
  hershey("rowmant", "Hershey Roman Triplex"),
  hershey("timesr", "Hershey Times Roman"),
  hershey("timesi", "Hershey Times Italic"),
  hershey("timesrb", "Hershey Times Bold"),
  hershey("scripts", "Hershey Script 1-stroke"),
  hershey("scriptc", "Hershey Script"),
  hershey("cursive", "Hershey Cursive"),
  hershey("gothiceng", "Hershey Gothic English"),
  hershey("gothicger", "Hershey Gothic German"),
  hershey("gothicita", "Hershey Gothic Italian"),
  hershey("greek", "Hershey Greek (Latin keys)"),
  hershey("cyrillic", "Hershey Cyrillic (Latin keys)"),
];

/** URL of a file under public/fonts. */
export const fontAsset = (path: string) => `${import.meta.env.BASE_URL}fonts/${path}`;

const BUNDLED_FILES = new Set(BUNDLED_FONTS.map((b) => b.path.split("/").pop()));
/** Bundled fonts are matched by file name; they cannot be removed. */
export const isBundledFile = (filename: string) => BUNDLED_FILES.has(filename);
