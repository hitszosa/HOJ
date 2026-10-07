const dirMetaMap: Record<string, Record<string, any>> = {
  "/docs/admin": { title: "后台" },
};

// route 是以下源码中规定的 EditableTreeNode 类型，但不能导入
// https://github.com/posva/unplugin-vue-router/blob/main/src/core/extendRoutes.ts
export function extendRoute(route: any) {
  // console.log(route.name, ":", route.fullPath);
  if (route.fullPath === "/docs" && route.isPassThrough) {
    route.meta = { ...route.meta, layout: "docs" };
  }
  if (route.fullPath.startsWith("/docs")) {
    route.meta = { ...route.meta, no_login: true };
  }

  if (Object.hasOwn(dirMetaMap, route.fullPath)) {
    route.meta = { ...route.meta, ...dirMetaMap[route.fullPath as string] };
  }
}
