import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/psc",
        destination: "/psc.html",
      },
    ];
  },
};

export default nextConfig;
