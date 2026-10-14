import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O renderer Remotion roda só no servidor (bundler webpack + Chrome headless): não empacotar.
  serverExternalPackages: ["@remotion/bundler", "@remotion/renderer", "@remotion/compositor-win32-x64-msvc", "remotion"],
};

export default nextConfig;
