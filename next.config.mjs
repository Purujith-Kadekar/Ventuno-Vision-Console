/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // firebase-admin uses dynamic requires and native-ish Google transport
  // code; keep it out of the server bundle so Vercel resolves it at runtime
  // instead of failing the route at import time.
  experimental: {
    serverComponentsExternalPackages: ['firebase-admin'],
  },
};

export default nextConfig;
