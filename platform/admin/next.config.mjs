/** @type {import('next').NextConfig} */
const nextConfig = {
  // The shared package ships TypeScript source rather than a build step.
  transpilePackages: ['@slash/ad-shared'],
  // Creatives are delivered inline as data URLs, never as <img src> links,
  // so there is nothing here for the image optimiser to do.
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true }
}

export default nextConfig
