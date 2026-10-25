// The design shared by the console and the site: the names, the tokens, the
// icons and the writing of money. The CSS lives beside it:
//   import "design/theme.css"            the tokens as a Tailwind theme (after @import "tailwindcss")
//   import "design/tokens.css"           the same tokens as plain CSS variables
//   import "design/fonts/archivo.css"    Archivo, the site's voice and the console's titles
//   import "design/fonts/atkinson.css"   Atkinson Hyperlegible Next, the console's text and figures
// and the icons as a React component: import { Icon } from "design/icon".
export { BRAND, DISCLAIMER, SANDBOX, SIMULATED_LABEL, SOURCE_URL } from "./brand.ts";
export { contrast, luminance } from "./contrast.ts";
export { ICONS, type IconName } from "./icons.ts";
export {
  formatCount, formatMoney, formatPercent, formatSitePrice, MINOR_UNITS, MINUS, minorUnits, type MarketCode, type MoneyLike, NBSP, NNBSP,
  parseAmount,
} from "./money.ts";
export { COLOR, type ColorName, DURATION_MS, EASE, FONT, PAIRS, TEXT } from "./tokens.ts";
