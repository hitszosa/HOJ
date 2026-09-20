/** @type {import('next').NextConfig} */
// HUSTOJ 是账号/题库/判题的主体：/oj 前缀代理到 HUSTOJ 根（8080），
// 用于原生登录/课程/退出入口；/template 代理其绝对资源路径。不开放泛代理，
// /api 始终指向 Course Service。
const HUSTOJ = process.env.COURSE_HUSTOJ_URL || "http://127.0.0.1:8080";
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${process.env.COURSE_API_URL || "http://127.0.0.1:8100"}/api/:path*` },
      { source: "/oj/:path*", destination: `${HUSTOJ}/:path*` },
      { source: "/template/:path*", destination: `${HUSTOJ}/template/:path*` },
    ];
  },
};

export default nextConfig;
