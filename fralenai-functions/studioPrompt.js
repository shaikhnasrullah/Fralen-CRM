// FRALEN Creative Studio: server-side prompt builder. The client sends a validated "brief", never a raw prompt.
const STYLES = {
  A: "a photorealistic high-end fashion advertisement featuring a stylish adult model wearing attractive eyeglasses, realistic skin texture, natural eyewear reflections, soft cinematic studio lighting, premium commercial photography",
  B: "an original photorealistic conceptual advertisement built around an oversized premium eyeglass frame as the hero object, accurate frame geometry, realistic materials, detailed reflections, dramatic studio lighting",
  C: "a cinematic luxury eyewear advertisement, close-up of premium glasses, dramatic directional lighting, polished materials, controlled reflections, high contrast editorial composition, minimal clutter",
  D: "a professional product photograph of several visually distinct eyeglass frames arranged elegantly, realistic frame shapes and proportions, accurate lenses and temples, natural shadows, consistent perspective, clean premium background",
  E: "a premium urban lifestyle advertisement with a stylish adult model wearing fashionable glasses in a modern architectural city setting, natural light, cinematic photography, contemporary fashion styling",
  F: "a refined campaign photograph with prominent eyewear and a tasteful seasonal atmosphere, realistic photography, the product clearly the focus, uncluttered"
};
const OCCASION = {
  diwali: "warm premium lighting with elegant festive diyas in soft focus",
  eid: "refined decorative patterns and sophisticated warm lighting",
  newyear: "a celebratory modern atmosphere with subtle bokeh",
  summer: "bright sunlight and a summer mood",
  school: "a clean, friendly optical-retail atmosphere",
  opening: "a premium storefront-inspired setting"
};
const ZONE = {
  bottom: "Keep the lower 40% of the frame calm and uncluttered",
  left: "Keep the left 45% of the frame calm and uncluttered",
  edges: "Keep the top 30% and bottom 25% of the frame calm and uncluttered",
  none: "Leave generous calm negative space"
};
const SIZE = { square: "1024x1024", portrait: "1024x1536", story: "1024x1536", landscape: "1536x1024" };
const clean = (t, n) => String(t || "").replace(/[^\p{L}\p{N}\s.,'&%-]/gu, "").slice(0, n);

function buildPrompt(b) {
  return [
    "Create " + (STYLES[b.style] || STYLES.A) + ", for an independent optical retailer.",
    b.model ? "Include a stylish adult model." : "Do not include any people.",
    b.product ? "The eyewear must be the clear hero product." : "",
    b.palette ? "Colour palette: " + clean(b.palette, 60) + "." : "",
    OCCASION[b.occasion] ? "Atmosphere: " + OCCASION[b.occasion] + "." : "",
    b.notes ? "Additional art direction: " + clean(b.notes, 300) + "." : "",
    (ZONE[b.textZone] || ZONE.none) + " for promotional typography.",
    "Realistic textures, accurate frame geometry, natural reflections, shallow depth of field.",
    "No text, no lettering, no watermark, no logos, no brand names, no invented contact details."
  ].filter(Boolean).join(" ");
}
module.exports = { buildPrompt, SIZE, STYLES };
