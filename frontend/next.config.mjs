/** @type {import('next').NextConfig} */
// All browser traffic stays in the teaching UI; account and judge adapters are internal.
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/", destination: "/management/home", permanent: false },
      { source: "/login", destination: "/management/login", permanent: false },
      { source: "/oj/:path*", destination: "/management/home", permanent: false },
      { source: "/template/:path*", destination: "/management/home", permanent: false },
    ];
  },
  async rewrites() {
    return { beforeFiles: [
      { source: "/management-api/:path*", destination: `${process.env.MANAGEMENT_API_URL || "http://127.0.0.1:8101"}/api/:path*` },
      { source: "/management/:path*", destination: `${process.env.MANAGEMENT_WEB_URL || "http://127.0.0.1:3101"}/management/:path*` },
      { source: "/api/:path*", destination: `${process.env.COURSE_API_URL || "http://127.0.0.1:8100"}/api/:path*` },
    ], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
