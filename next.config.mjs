/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": ["./AH2DEdtior.html", "./engine/**/*", "./node_modules/pixi.js/dist/pixi.min.js"]
  }
};

export default nextConfig;
