import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev is browsed via 127.0.0.1 as well as localhost; without this Next blocks
  // its own dev scripts for that origin and the page loses all interactivity.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
