import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The sidebar's collapse toggle now sits fixed at the bottom-left (see
  // AppShell), which is also where Next's dev-mode indicator badge renders
  // by default — move the badge so the two don't overlap during `next dev`.
  // Dev-only; has no effect on the production build.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
