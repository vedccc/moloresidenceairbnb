import type { NextConfig } from "next";

// Static-edge migration COMPLETE. Every page fetches from the Supabase edge
// function `api` via TanStack Query, so the whole route tree is statically
// renderable. `output: 'export'` emits a static `out/` bundle for the Render
// static_site deploy; `images.unoptimized` is required by static export.
// See docs/superpowers/specs/2026-06-12-static-edge-migration-design.md
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
