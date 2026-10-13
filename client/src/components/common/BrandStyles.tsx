/**
 * Shared brand typography. Place at src/components/common/BrandStyles.tsx.
 *
 * Bricolage Grotesque (display) + Figtree (body). `.mp-home` sets the body
 * font and text color for everything inside a layout; `.mp-display` is for
 * headlines. If you prefer, move this CSS into index.css and delete this file.
 */
const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400..700&display=swap');
.mp-home { font-family: 'Figtree', ui-sans-serif, system-ui, sans-serif; color: #0B2B2E; }
.mp-display { font-family: 'Bricolage Grotesque', 'Figtree', ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.025em; }
`;

export function BrandStyles() {
  return <style>{FONT_CSS}</style>;
}