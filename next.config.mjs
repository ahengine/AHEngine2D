/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": [
      "./AH2DEdtior.html",
      "./engine/**/*",
      "./node_modules/pixi.js/dist/pixi.min.js",
      "./node_modules/pixi.js/dist/packages/unsafe-eval.min.js",
      "./node_modules/planck/dist/planck.min.js",
      "./node_modules/planck/dist/planck.js"
    ]
  }
};

export default nextConfig;
