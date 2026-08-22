export type Locale = "en" | "zh";

export function browserLocale(): Locale {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const TEXT = {
  en: {
    overview: "Overview",
    sites: "Sites",
    incidents: "Incidents",
    statusPages: "Status pages",
    allServices: "All services",
    xgsServices: "XGS services",
    settings: "Settings",
    searchSites: "Search sites…",
    openMenu: "Open menu",
    signOut: "Sign out",
    noData: "No data",
    uptime: "uptime",
    daysAgo: (count: number) => `${count} days ago`,
    today: "Today",
  },
  zh: {
    overview: "概览",
    sites: "站点",
    incidents: "事件",
    statusPages: "状态页面",
    allServices: "全部服务",
    xgsServices: "XGS 服务",
    settings: "设置",
    searchSites: "搜索站点…",
    openMenu: "打开菜单",
    signOut: "退出登录",
    noData: "暂无数据",
    uptime: "可用率",
    daysAgo: (count: number) => `${count} 天前`,
    today: "今天",
  },
} as const;

export function t() {
  return TEXT[browserLocale()];
}
